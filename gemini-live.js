/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from './js-genai.js';
import { getCommonSystemInstructions } from './sidebar.js';

// Model definition for Gemini Live
export const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

if (!localStorage.liveModel || localStorage.liveModel.includes('gemini-2.0')) {
  localStorage.liveModel = MODEL;
}

export class AudioScheduler {
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
    this.sources.forEach(source => {
      source.onended = null;
      try { source.stop(); } catch { }
    });
    this.sources.clear();
    this.nextStartTime = 0;
    this.onSpeaking?.(false);
    if (this.ctx) { try { this.ctx.close(); } catch {} ; this.ctx = null; }
  }
}

export class MicCapture {
  constructor() {
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
      chrome.runtime.onMessage.addListener(this._onMessage);

      // Create offscreen document if it doesn't exist
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['USER_MEDIA'],
          justification: 'Capture microphone for Gemini Live'
        });
      }

      chrome.runtime.sendMessage({ target: 'offscreen', type: 'start-mic' });
    } catch (err) {
      console.error('MicCapture start failed:', err);
      throw err;
    }
  }

  async stop() {
    chrome.runtime.onMessage.removeListener(this._onMessage);
    try {
      if (await chrome.offscreen.hasDocument()) {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-mic' });
        await chrome.offscreen.closeDocument();
      }
    } catch (err) {
      // Ignore errors if document is already closed
    }
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

function encode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function createBlob(data) {
  return { data: encode(new Uint8Array(data)), mimeType: "audio/pcm;rate=16000" };
}

let liveSession = null;
let audioScheduler = null;
let micCapture = null;

export async function initGeminiLive({ micBtn, apiKeyBtn, getGenAI, getTools, executeTool, logPrompt }) {
  micBtn.onclick = async () => {
    if (!localStorage.apiKey) { apiKeyBtn.click(); return; }
    if (liveSession) {
      stopLive(micBtn);
    } else {
      await startLive({ micBtn, getGenAI, getTools, executeTool, logPrompt });
    }
  };

  
  // Helper for mic permission in tab
  if (window.location.search.includes('requestMic=1')) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(t => t.stop());
        document.body.innerHTML = '<h1>Permission Granted!</h1><p>You can close this tab now.</p>';
        setTimeout(() => window.close(), 2000);
      })
      .catch(() => {
        document.body.innerHTML = '<h1>Permission Failed</h1>';
      });
  }
}

async function startLive({ micBtn, getGenAI, getTools, executeTool, logPrompt }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  micBtn.classList.add('active');
  micBtn.querySelector('.mic-icon').style.display = 'none';
  micBtn.querySelector('.stop-icon').style.display = 'block';

  audioScheduler = new AudioScheduler();
  audioScheduler.onSpeaking = (speaking) => micBtn.classList.toggle('speaking', speaking);

  micCapture = new MicCapture();
  micCapture.onListening = (listening) => micBtn.classList.toggle('listening', listening);

  const config = getLiveConfig(getTools());
  // Gemini Live requires v1alpha for the Multimodal Live API.
  const liveGenAI = new GoogleGenAI({ apiKey: localStorage.apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  
  try {
    liveSession = await liveGenAI.live.connect({
      model: localStorage.liveModel,
      config: {
        systemInstruction: { parts: [{ text: config.systemInstruction.join('\n') }] },
        responseModalities: ['AUDIO'],
        proactivity: { proactiveAudio: true },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        realtimeInputConfig: { activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' },
        tools: config.tools,
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
      },
      callbacks: {
        onopen: async () => {
          logPrompt(`Live session connected.`);
          try {
            await micCapture.start();
            micCapture.onAudioData = (data) => {
              if (liveSession) liveSession.sendRealtimeInput({ media: createBlob(data) });
            };
          } catch (micErr) {
            if (micErr.message !== 'Permission required') stopLive(micBtn);
          }
        },
        onclose: (e) => {
          logPrompt(`Live session closed. Reason: "${e.reason || 'No reason provided'}"`);
          stopLive(micBtn);
        },
        onerror: (err) => {
          logPrompt(`Live session error: ${err.message || err}`);
          stopLive(micBtn);
        },
        onmessage: (message) => {
          // 1. CRITICAL: Handle Tool Calls FIRST
          if (message.toolCall?.functionCalls) {
            const fcs = message.toolCall.functionCalls;
            (async () => {
              const responses = [];
              for (const fc of fcs) {
                logPrompt(`AI calling tool "${fc.name}"`);
                try {
                  const result = await executeTool(tab.id, fc.name, JSON.stringify(fc.args));
                  logPrompt(`Tool "${fc.name}" result: ${result}`);
                  responses.push({ id: fc.id, name: fc.name, response: { result }, scheduling: 'SILENT' });
                } catch (e) {
                  logPrompt(`⚠️ Error executing tool "${fc.name}": ${e.message}`);
                  responses.push({ id: fc.id, name: fc.name, response: { error: e.message }, scheduling: 'SILENT' });
                }
              }
              if (responses.length > 0 && liveSession) {
                liveSession.sendToolResponse({ functionResponses: responses });
              }
            })();
          }


          // 2. Handle Audio
          if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
              if (part.inlineData?.data) {
                audioScheduler.play(decode(part.inlineData.data));
              }
            }
          }

          // 3. Handle Text (Filter preambles)
          if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
              if (part.text) {
                // Silently ignore text that looks like a preamble (bold headers, "Considering", "Initiating", etc.)
                const isPreamble = part.text.startsWith('**') || /Initiating|Considering|Determining|Defining|Confirming/i.test(part.text);
                if (isPreamble) {
                   continue;
                }
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
        }
      }
    });
  } catch (error) {
    logPrompt(`⚠️ Error starting live: ${error.message}`);
    stopLive(micBtn);
  }
}

function stopLive(micBtn) {
  if (liveSession) {
    try { liveSession.close(); } catch {}
    liveSession = null;
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

function getLiveConfig(currentTools) {
  const systemInstruction = getCommonSystemInstructions();

  // Map function declarations to their own tool entry
  const tools = currentTools.map((tool) => {
    return {
      functionDeclarations: [{
        name: tool.name,
        description: tool.description,
        behavior: 'NON_BLOCKING',
        parametersJsonSchema: tool.inputSchema ? JSON.parse(tool.inputSchema) : { type: 'object', properties: {} },
      }]
    };
  });
  return { systemInstruction, tools };
}
