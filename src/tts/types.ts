import type { Readable } from "node:stream";

import type { GeneratedAudio } from "sherpa-onnx-node";

export interface StreamingAudio {
  stream: Readable;
  done: Promise<number>;
  cancel: () => void;
}

export type VoiceAudio = GeneratedAudio | StreamingAudio;

export interface Tts {
  synthesize(text: string): StreamingAudio;
}
