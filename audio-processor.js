/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AudioWorklet processor for capturing microphone audio
// Runs in a separate thread for lower latency

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Buffer size of 2048 samples at 16kHz is approx 128ms
    // This is a good balance between latency and WebSocket packet overhead
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    const length = channelData.length;

    for (let i = 0; i < length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];

      if (this.bufferIndex >= this.bufferSize) {
        // Send a copy of the buffer to the main thread
        // We use a TypedArray copy to avoid shared memory issues in some environments
        this.port.postMessage({
          type: 'audio',
          data: new Float32Array(this.buffer)
        });
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
