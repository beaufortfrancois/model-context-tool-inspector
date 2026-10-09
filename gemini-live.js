/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from './js-genai.js';

const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

class AudioScheduler {
  constructor() {
    this.ctx = null;
    this.sources = new Set();
    this.nextStartTime = 0;
    this.onSpeaking = null;
  }

  ensureContext() {
    if (this.ctx && (this.ctx.state === 'running' || this.ctx.state === 'suspended')) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    this.ctx = new AudioContext({ sampleRate: 24000 });
    return this.ctx;
  }

  play(data) {
    const ctx = this.ensureContext();
    if (this.sources.size === 0) this.onSpeaking?.(true);

    try {
      const dataInt16 = new Int16Array(data.buffer);
      const buffer = ctx.createBuffer(1, dataInt16.length, 24000);
      const channelData = buffer.getChannelData(0);
      for (let i = 0; i < dataInt16.length; i++) channelData[i] = dataInt16[i] / 32768.0;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startTime = Math.max(ctx.currentTime, this.nextStartTime);
      source.start(startTime);
      this.nextStartTime = startTime + buffer.duration;
      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        if (this.sources.size === 0) {
          this.onSpeaking?.(false);
        }
      };
    } catch (err) {
      console.error('Playback error:', err);
    }
  }

  clear() {
    this.sources.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {}
    });
    this.sources.clear();
    this.nextStartTime = 0;
    this.onSpeaking?.(false);
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {}
      this.ctx = null;
    }
  }
}

class MicCapture {
  constructor(logPrompt) {
    this.logPrompt = logPrompt;
    this.onAudioData = null;
    this.onListening = null;
    this.listeningTimeout = null;
    this._onMessage = (message) => {
      if (message.type === 'audio-data') {
        this.onAudioData?.(message.data);
        this.onListening?.(true);
        if (this.listeningTimeout) clearTimeout(this.listeningTimeout);
        this.listeningTimeout = setTimeout(() => this.onListening?.(false), 200);
      } else if (message.type === 'mic-error') {
        console.error('Mic error from offscreen:', message.error);
      }
    };
  }

  async start() {
    try {
      await this.stop();

      // Check current permission state
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
      console.debug('[WebMCP] Mic permission status:', permissionStatus.state);

      if (permissionStatus.state !== 'granted') {
        this.logPrompt(
          'ℹ️ Microphone permission required. Opening a small window to request access...',
        );

        const url = chrome.runtime.getURL('mic-permission.html');
        const popup = await chrome.windows.create({
          url,
          type: 'popup',
          width: 350,
          height: 250,
          focused: true,
          state: 'normal', // This is key to preventing full-screen inheritance on macOS
        });

        // Wait for mic-permission.js to report the grant so this same click can
        // start the session. Closing the popup first cancels.
        await new Promise((resolve, reject) => {
          const onMessage = (message) => {
            if (message.type === 'mic-permission-granted') done(resolve);
          };
          const onRemoved = (windowId) => {
            if (windowId !== popup.id) return;
            done(() => reject(new Error('Microphone permission was not granted.')));
          };
          const done = (settle) => {
            chrome.runtime.onMessage.removeListener(onMessage);
            chrome.windows.onRemoved.removeListener(onRemoved);
            settle();
          };
          chrome.runtime.onMessage.addListener(onMessage);
          chrome.windows.onRemoved.addListener(onRemoved);
        });
      }

      chrome.runtime.onMessage.addListener(this._onMessage);

      // 2. Create offscreen document if it doesn't exist
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['USER_MEDIA'],
          justification: 'Capture microphone for Gemini Live',
        });
      }

      // 3. Send message with retry to handle race condition where document is created but not ready
      let attempts = 0;
      const sendStart = async () => {
        try {
          await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start-mic' });
        } catch (e) {
          if (attempts++ < 10) {
            await new Promise((r) => setTimeout(r, 100));
            return sendStart();
          }
          throw e;
        }
      };
      await sendStart();
    } catch (err) {
      this.logPrompt(`⚠️ Mic Error: ${err.message}`);
      throw err;
    }
  }

  async stop() {
    chrome.runtime.onMessage.removeListener(this._onMessage);
    try {
      if (await chrome.offscreen.hasDocument()) {
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-mic' }).catch(() => {});
        await chrome.offscreen.closeDocument().catch(() => {});
      }
    } catch (err) {}
    if (this.listeningTimeout) clearTimeout(this.listeningTimeout);
    this.onListening?.(false);
  }
}

function decode(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

function createBlob(base64) {
  return { data: base64, mimeType: 'audio/pcm;rate=16000' };
}

let liveSession = null;
let audioScheduler = null;
let micCapture = null;
let lastStartParams = null;
let isReconnecting = false;
let updateToolsTimeout = null;
let lastToolsHash = null;
let resumeHandle = null;
let toolCallInProgress = false;
let userRequest = '';
let userRequestDone = true;
let requestToolCalls = [];

function toolsHash(tools) {
  return JSON.stringify((tools || []).map((t) => [t.frameId, t.name, t.inputSchema]));
}

export async function initGeminiLive(params) {
  params.micBtn.onclick = async () => {
    if (!localStorage.apiKey) {
      params.apiKeyBtn.click();
      return;
    }
    if (liveSession) {
      stopLive(params.micBtn);
    } else {
      lastStartParams = params;
      startLive(params);
    }
  };
}

export async function updateLiveTools() {
  if (!liveSession || !lastStartParams) return;

  if (updateToolsTimeout) clearTimeout(updateToolsTimeout);
  updateToolsTimeout = setTimeout(async () => {
    // Tools changed by a tool call are picked up once it returns.
    if (toolCallInProgress) return;
    if (toolsHash(lastStartParams.getTools()) === lastToolsHash) return;

    lastStartParams.logPrompt?.('Tools updated. Reconnecting Gemini Live session...');
    await startLive(lastStartParams);
  }, 200);
}

async function startLive(
  { micBtn, getTools, getConfig, executeTool, logPrompt, addToTrace },
  resumeText = null,
) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  lastToolsHash = toolsHash(getTools());

  if (!audioScheduler) {
    audioScheduler = new AudioScheduler();
    audioScheduler.onSpeaking = (speaking) => micBtn.classList.toggle('speaking', speaking);
  }

  if (!micCapture) {
    micCapture = new MicCapture(logPrompt);
    micCapture.onListening = (listening) => micBtn.classList.toggle('listening', listening);
  }

  if (!micBtn.classList.contains('active')) {
    try {
      await micCapture.start();
    } catch {
      return; // MicCapture already logged why.
    }

    micBtn.classList.add('active');
    micBtn.querySelector('.mic-icon').style.display = 'none';
    micBtn.querySelector('.stop-icon').style.display = 'block';
  }

  const config = getConfig();
  const liveGenAI = new GoogleGenAI({
    apiKey: localStorage.apiKey,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  if (liveSession) {
    isReconnecting = true;
    try {
      liveSession.close();
    } catch {}
    liveSession = null;
  }

  try {
    liveSession = await liveGenAI.live.connect({
      model: LIVE_MODEL,
      config: {
        systemInstruction: { parts: [{ text: config.systemInstruction.join('\n') }] },
        responseModalities: ['AUDIO'],
        thinkingConfig: { thinkingBudget: 0 },
        contextWindowCompression: { slidingWindow: {} },
        proactivity: { proactiveAudio: true },
        inputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        realtimeInputConfig: { activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' },
        // Keeps the conversation when reconnecting with new tools.
        sessionResumption: { handle: resumeHandle ?? undefined },
        tools: config.tools,
      },
      callbacks: {
        onopen: () => {
          isReconnecting = false;
          logPrompt(`Live session connected.`);
          micCapture.onAudioData = (data) => {
            if (liveSession) liveSession.sendRealtimeInput({ audio: createBlob(data) });
          };
        },
        onclose: (e) => {
          if (!isReconnecting) {
            logPrompt(`Live session closed. Reason: "${e.reason || 'No reason provided'}"`);
            stopLive(micBtn);
          }
        },
        onerror: (error) => {
          if (!isReconnecting) {
            addToTrace({ error });
            logPrompt(`Live session error: ${error.message || error}`);
            stopLive(micBtn);
          }
        },
        onmessage: (message) => {
          addToTrace({ userPrompt: { message, config } });
          const update = message.sessionResumptionUpdate;
          if (update?.resumable && update.newHandle) resumeHandle = update.newHandle;
          if (message.setupComplete && resumeText) {
            const turns = [{ role: 'user', parts: [{ text: resumeText }] }];
            addToTrace({ userPrompt: { message: turns, config } });
            liveSession?.sendClientContent({ turns, turnComplete: true });
            resumeText = null;
          }
          if (message.toolCall?.functionCalls) {
            const fcs = message.toolCall.functionCalls;
            toolCallInProgress = true;
            (async () => {
              const responses = [];
              for (const { id, name, args: inputArgs } of fcs) {
                let [frameId, toolName] = name.split(/_(.*)/s)[1].split(/_(.*)/s);
                frameId = parseInt(frameId);
                logPrompt(`AI calling tool "${toolName}" with ${JSON.stringify(inputArgs)}`);
                let response;
                try {
                  const result = await executeTool(tab.id, toolName, inputArgs, frameId);
                  response = { result: result === undefined ? null : result };
                  logPrompt(`Tool "${toolName}" result: ${result}`);
                } catch (e) {
                  response = { error: e.message };
                  logPrompt(`⚠️ Error executing tool "${toolName}": ${e.message}`);
                }
                responses.push({ id, name, response });
                requestToolCalls.push(
                  `${toolName}(${JSON.stringify(inputArgs)}) returned ${JSON.stringify(response)}`,
                );
              }
              toolCallInProgress = false;
              if (!lastStartParams) return; // Stopped while the tool ran.
              addToTrace({ userPrompt: { message: responses, config } });

              // Like text mode, pull tools after each tool call. Live tools can
              // only be set on connect, so if the page's tools changed (e.g.
              // after a navigation), resume the conversation with the new tools.
              if (toolsHash(getTools()) === lastToolsHash) {
                liveSession?.sendToolResponse({ functionResponses: responses });
                return;
              }
              logPrompt('Tools updated. Reconnecting Gemini Live session...');
              await startLive(
                lastStartParams,
                [
                  userRequest && `The user asked: "${userRequest.trim()}"`,
                  `Tool calls made so far: ${requestToolCalls.join('; ')}.`,
                  'The page changed, so your tools now match the new page.',
                  'Continue with the request if anything is left to do.',
                ].filter(Boolean).join('\n'),
              );
            })();
          }

          if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
              if (part.inlineData?.data) {
                audioScheduler.play(decode(part.inlineData.data));
              }
              if (part.text) {
                logPrompt(`AI result: ${part.text}`);
              }
            }
          }
          if (message.serverContent?.inputTranscription?.text) {
            const { text } = message.serverContent.inputTranscription;
            if (userRequestDone) {
              userRequest = '';
              requestToolCalls = [];
            }
            userRequestDone = false;
            userRequest += text;
            logPrompt(`User prompt: "${text}"`);
          }
          if (message.serverContent?.turnComplete) userRequestDone = true;
          if (message.serverContent?.interrupted) {
            audioScheduler.clear();
          }
        },
      },
    });
  } catch (error) {
    logPrompt(`⚠️ Error starting live: ${error.message}`);
    stopLive(micBtn);
  }
}

function stopLive(micBtn) {
  if (updateToolsTimeout) {
    clearTimeout(updateToolsTimeout);
    updateToolsTimeout = null;
  }
  lastToolsHash = null;
  lastStartParams = null;
  isReconnecting = false;
  resumeHandle = null;
  toolCallInProgress = false;
  userRequest = '';
  userRequestDone = true;
  requestToolCalls = [];
  if (liveSession) {
    const sessionToClose = liveSession;
    liveSession = null;
    try {
      sessionToClose.close();
    } catch {}
  }
  if (micCapture) {
    micCapture.stop();
    micCapture = null;
  }
  if (audioScheduler) {
    audioScheduler.clear();
    audioScheduler = null;
  }
  micBtn.classList.remove('active', 'listening', 'speaking');
  micBtn.querySelector('.mic-icon').style.display = 'block';
  micBtn.querySelector('.stop-icon').style.display = 'none';
}
