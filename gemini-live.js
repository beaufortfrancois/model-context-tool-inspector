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
        await chrome.windows.create({
          url,
          type: 'popup',
          width: 350,
          height: 250,
          focused: true,
          state: 'normal', // This is key to preventing full-screen inheritance on macOS
        });
        throw new Error('Permission required');
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
      console.error('MicCapture start failed:', err);
      if (err.message !== 'Permission required') {
        this.logPrompt(`⚠️ Mic Error: ${err.message}`);
      }
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

export async function initGeminiLive(params) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'mic-permission-granted') {
      if (!liveSession && lastStartParams) {
        startLive(lastStartParams);
      }
    }
  });

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
    const currentTools = lastStartParams.getTools?.() || [];
    const currentHash = JSON.stringify(
      currentTools.map((t) => [t.frameId, t.name, t.inputSchema]),
    );
    if (currentHash === lastToolsHash) return;
    lastToolsHash = currentHash;

    lastStartParams.logPrompt?.('Tools updated. Reconnecting Gemini Live session...');
    await startLive(lastStartParams);
  }, 200);
}

async function startLive({
  micBtn,
  getTools,
  getConfig,
  executeTool,
  logPrompt,
  addToTrace,
}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  lastToolsHash = JSON.stringify(
    (getTools() || []).map((t) => [t.frameId, t.name, t.inputSchema]),
  );

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
    } catch (micErr) {
      console.error('Initial mic start failed:', micErr);
      return;
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
          if (message.toolCall?.functionCalls) {
            const fcs = message.toolCall.functionCalls;
            (async () => {
              const responses = [];
              for (const fc of fcs) {
                let [frameId, toolName] = fc.name.split(/_(.*)/s)[1].split(/_(.*)/s);
                frameId = parseInt(frameId);
                const inputArgs = JSON.stringify(fc.args);
                logPrompt(`AI calling tool "${toolName}" with ${inputArgs}`);
                try {
                  const result = await executeTool(tab.id, toolName, inputArgs, frameId);
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { result: result === undefined ? null : result },
                  });
                  liveSession?.sendToolResponse({
                    functionResponses: [{
                      id: fc.id,
                      name: fc.name,
                      response: { result: result === undefined ? null : result },
                    }],
                  });
                  logPrompt(`Tool "${toolName}" result: ${result}`);
                } catch (e) {
                  responses.push({ id: fc.id, name: fc.name, response: { error: e.message } });
                  liveSession?.sendToolResponse({
                    functionResponses: [{
                      id: fc.id,
                      name: fc.name,
                      response: { error: e.message },
                    }],
                  });
                  logPrompt(`⚠️ Error executing tool "${toolName}": ${e.message}`);
                }
              }
              if (responses.length > 0) {
                addToTrace({ userPrompt: { message: responses, config } });
              }
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
            logPrompt(`User prompt: "${message.serverContent.inputTranscription.text}"`);
          }
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
