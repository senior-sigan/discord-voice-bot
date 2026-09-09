export const SAMPLE_RATE = 16_000;

export interface Transcript {
  guildId: string;
  userId: string;
  user: string;
  timestamp: string;
  text: string;
}

export interface SpeechInput {
  accept(samples: Float32Array): void;
  finish(): void;
}

export interface Transcriber {
  readonly enabled?: boolean;
  createInput(
    meta: Omit<Transcript, "text" | "timestamp">,
    onTranscript: (transcript: Transcript) => void,
    signal: AbortSignal,
  ): SpeechInput;
}
