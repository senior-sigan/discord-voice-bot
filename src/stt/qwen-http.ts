import type { VadConfig } from "sherpa-onnx-node";
import sherpa from "sherpa-onnx-node";

import { isFillerOnlyTranscript } from "../agent/transcript.js";
import { floatMonoToWav } from "../audio.js";
import { errorMessage, isRecord, log } from "../common.js";
import { SAMPLE_RATE, type SpeechInput, type Transcriber, type Transcript } from "./types.js";
import { createVadConfig, SpeechSegmenter } from "./vad.js";

const { Vad } = sherpa;

interface QwenHttpSettings {
  baseUrl: string;
  model: string;
  language: string | null;
  timeoutMs: number;
  apiKey: string;
}

export class QwenHttpTranscriber implements Transcriber {
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly settings: QwenHttpSettings,
    private readonly vadConfig: VadConfig,
  ) {}

  static async create(
    baseUrl: string,
    model: string,
    language: string | null,
    timeoutMs: number,
    apiKey: string,
    vadModel: string,
    vadThreshold: number,
  ): Promise<QwenHttpTranscriber> {
    const settings = { baseUrl: baseUrl.replace(/\/+$/u, ""), model, language, timeoutMs, apiKey };
    const vadConfig = createVadConfig(vadModel, vadThreshold);
    const response = await fetch(`${settings.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(await httpError("Qwen STT model discovery failed", response));
    const payload: unknown = await response.json();
    const available = isRecord(payload) && Array.isArray(payload["data"]) ? payload["data"] : [];
    if (!available.some((item) => isRecord(item) && item["id"] === model)) {
      throw new Error(`Qwen STT server does not expose configured model: ${model}`);
    }
    log("info", "transcriber initialized", {
      provider: "qwen-http",
      model,
      language: language ?? "auto",
      vad: "silero-v5",
      vad_threshold: vadThreshold,
    });
    return new QwenHttpTranscriber(settings, vadConfig);
  }

  createInput(
    meta: Omit<Transcript, "text" | "timestamp">,
    onTranscript: (transcript: Transcript) => void,
    signal: AbortSignal,
  ): SpeechInput {
    return new SpeechSegmenter(
      new Vad(this.vadConfig, 30),
      (samples) => {
        this.enqueue(samples, { ...meta, timestamp: new Date().toISOString() }, onTranscript, signal);
      },
      signal,
    );
  }

  private enqueue(
    samples: Float32Array,
    meta: Omit<Transcript, "text">,
    onTranscript: (transcript: Transcript) => void,
    signal: AbortSignal,
  ): void {
    this.queue = this.queue
      .then(async () => {
        if (signal.aborted) return;
        const started = performance.now();
        const body = new FormData();
        body.append("file", new Blob([floatMonoToWav(samples, SAMPLE_RATE)], { type: "audio/wav" }), "speech.wav");
        body.append("model", this.settings.model);
        if (this.settings.language) body.append("language", this.settings.language);
        const response = await fetch(`${this.settings.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.settings.apiKey}` },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.settings.timeoutMs)]),
        });
        if (!response.ok) throw new Error(await httpError("Qwen STT transcription failed", response));
        const payload: unknown = await response.json();
        if (!isRecord(payload) || typeof payload["text"] !== "string") {
          throw new Error("Qwen STT returned an invalid transcription response");
        }
        if (signal.aborted) return;
        const text = payload["text"].trim();
        if (!text || isFillerOnlyTranscript(text)) return;
        log("info", "transcript", {
          provider: "qwen-http",
          user: meta.user,
          duration: `${(samples.length / SAMPLE_RATE).toFixed(2)}s`,
          elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
          text,
        });
        onTranscript({ ...meta, text });
      })
      .catch((error: unknown) => {
        if (!signal.aborted) log("error", "transcription failed", { user: meta.user, error: errorMessage(error) });
      });
  }
}

async function httpError(prefix: string, response: Response): Promise<string> {
  const detail = (await response.text()).trim();
  return `${prefix}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`;
}
