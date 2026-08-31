import type { Readable } from "node:stream";

import type { GeneratedAudio } from "sherpa-onnx-node";

export const SUPERTONIC_VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const;

export interface StreamingAudio {
  stream: Readable;
  done: Promise<number>;
  cancel: () => void;
}

export type VoiceAudio = GeneratedAudio | StreamingAudio;

export interface Tts {
  synthesize(text: string): StreamingAudio;
}
