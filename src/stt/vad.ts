import { existsSync } from "node:fs";

import type { Vad, VadConfig } from "sherpa-onnx-node";

import { SAMPLE_RATE, type SpeechInput } from "./types.js";

export function createVadConfig(model: string, threshold: number): VadConfig {
  if (!existsSync(model)) throw new Error(`VAD model file not found: ${model}`);
  return {
    sileroVad: {
      model,
      threshold,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.3,
      windowSize: 512,
      maxSpeechDuration: 20,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: "cpu",
  };
}

/** Each speaker owns a detector; completed native segments are drained immediately. */
export class SpeechSegmenter implements SpeechInput {
  constructor(
    private readonly vad: Vad,
    private readonly onSegment: (samples: Float32Array) => void,
    private readonly signal: AbortSignal,
  ) {}

  accept(samples: Float32Array): void {
    if (this.signal.aborted) return;
    // Feed bounded frames even when a decoder hands us a large buffer.
    for (let offset = 0; offset < samples.length; offset += 512) {
      this.vad.acceptWaveform(samples.subarray(offset, offset + 512));
      this.drain();
    }
  }

  finish(): void {
    try {
      if (!this.signal.aborted) {
        this.vad.flush();
        this.drain();
      }
    } finally {
      this.vad.reset();
    }
  }

  private drain(): void {
    while (!this.vad.isEmpty()) {
      // Request an owned copy: pop() releases the native segment.
      const { samples } = this.vad.front(false);
      this.vad.pop();
      if (!this.signal.aborted && samples.length) this.onSegment(samples);
    }
  }
}
