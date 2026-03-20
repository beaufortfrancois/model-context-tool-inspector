/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

let ctx;
let stream;
let worklet;

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'start-mic') {
    startMic();
  } else if (message.type === 'stop-mic') {
    stopMic();
  }
});

async function startMic() {
  if (ctx) return;

  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));

    const source = ctx.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(ctx, 'audio-processor');
    source.connect(worklet);

    worklet.port.onmessage = (event) => {
      if (event.data.type === 'audio') {
        const float32Data = event.data.data;
        const int16Data = new Int16Array(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
          // Clamp and map Float32 to Int16
          const s = Math.max(-1, Math.min(1, float32Data[i]));
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        chrome.runtime.sendMessage({
          type: 'audio-data',
          data: Array.from(new Uint8Array(int16Data.buffer))
        });
      }
    };
  } catch (err) {
    console.error('Offscreen mic start failed:', err);
    chrome.runtime.sendMessage({ type: 'mic-error', error: err.message });
  }
}

function stopMic() {
  if (worklet) {
    worklet.port.onmessage = null;
    worklet.disconnect();
    worklet = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (ctx) {
    ctx.close();
    ctx = null;
  }
}
