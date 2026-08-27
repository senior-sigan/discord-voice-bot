export interface Transcript {
  guildId: string;
  userId: string;
  user: string;
  timestamp: string;
  text: string;
}

export interface Transcriber {
  enqueue(samples: Float32Array, meta: Omit<Transcript, "text">, onTranscript: (transcript: Transcript) => void): void;
}
