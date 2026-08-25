import type { Vad } from "sherpa-onnx-node";

export function containsSpeech(vad: Vad, samples: Float32Array): boolean {
  try {
    vad.acceptWaveform(samples);
    vad.flush();
    return !vad.isEmpty();
  } finally {
    vad.reset();
  }
}
