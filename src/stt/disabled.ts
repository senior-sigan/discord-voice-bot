import type { SpeechInput, Transcriber } from "./types.ts";

export class DisabledTranscriber implements Transcriber {
  readonly enabled = false;

  createInput(): SpeechInput {
    return {
      accept: () => undefined,
      finish: () => undefined,
    };
  }
}
