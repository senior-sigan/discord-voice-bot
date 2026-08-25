import { PassThrough } from "node:stream";

import sherpa from "sherpa-onnx-node";

import { floatMonoToStereoPcm, pcm16MonoWavToFloat } from "../audio.js";
import { errorMessage, log } from "../common.js";
import { spokenText } from "./text.js";
import type { StreamingAudio, Tts } from "./types.js";

const { LinearResampler } = sherpa;
const DEFAULT_INSTRUCT = "A warm, calm narrator with a clear and engaging delivery.";

export class QwenTts implements Tts {
  private constructor(
    private readonly baseUrl: string,
    private readonly language: string,
    private readonly instruct: string,
    private readonly chunkSize: number,
  ) {}

  static async create(): Promise<QwenTts> {
    const baseUrl = (process.env["QWEN_TTS_BASE_URL"] ?? "http://127.0.0.1:7860").replace(/\/$/, "");
    const language = process.env["QWEN_TTS_LANGUAGE"] ?? "Russian";
    const instruct = process.env["QWEN_TTS_INSTRUCT"] ?? DEFAULT_INSTRUCT;
    const chunkSize = Number(process.env["QWEN_TTS_CHUNK_SIZE"] ?? 4);
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 12) {
      throw new Error("QWEN_TTS_CHUNK_SIZE must be an integer from 1 to 12");
    }

    const response = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Qwen TTS status failed: HTTP ${response.status}`);
    const status = (await response.json()) as Record<string, unknown>;
    if (status["loaded"] !== true) throw new Error("Qwen TTS model is not loaded");
    if (status["model_type"] !== "voice_design") {
      throw new Error(`Qwen TTS must have a VoiceDesign model loaded, got ${String(status["model_type"])}`);
    }
    log("info", "TTS initialized", { provider: "qwen", model: status["model"], base_url: baseUrl });
    return new QwenTts(baseUrl, language, instruct, chunkSize);
  }

  synthesize(text: string): StreamingAudio {
    const input = spokenText(text);
    const stream = new PassThrough();
    stream.on("error", () => undefined);
    const abort = new AbortController();
    let cancelled = false;
    let sampleCount = 0;
    let sampleRate = 0;

    const done = (async () => {
      const started = performance.now();
      let resampler: InstanceType<typeof LinearResampler> | undefined;
      let pending = "";
      let completed = false;
      try {
        const form = new FormData();
        form.set("text", input);
        form.set("language", this.language);
        form.set("mode", "voice_design");
        form.set("instruct", this.instruct);
        form.set("chunk_size", String(this.chunkSize));
        form.set("non_streaming_mode", "true");
        const response = await fetch(`${this.baseUrl}/generate/stream`, {
          method: "POST",
          body: form,
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(`Qwen TTS generation failed: HTTP ${response.status} ${await response.text()}`);
        }
        if (!response.body) throw new Error("Qwen TTS returned an empty response");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (!cancelled) {
          const part = await reader.read();
          pending = (pending + decoder.decode(part.value, { stream: !part.done })).replace(/\r\n/g, "\n");
          let boundary = pending.indexOf("\n\n");
          while (boundary !== -1) {
            const eventText = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            boundary = pending.indexOf("\n\n");
            const data = eventText
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const event = JSON.parse(data) as Record<string, unknown>;
            if (event["type"] === "error") throw new Error(String(event["message"] ?? "Qwen TTS failed"));
            if (event["type"] === "done") {
              completed = true;
              continue;
            }
            if (event["type"] !== "chunk" || typeof event["audio_b64"] !== "string") continue;

            const audio = pcm16MonoWavToFloat(Buffer.from(event["audio_b64"], "base64"));
            if (!resampler) {
              sampleRate = audio.sampleRate;
              resampler = new LinearResampler(sampleRate, 48_000);
              log("info", "Qwen speech started", {
                ttfa: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
                model_ttfa_ms: event["ttfa_ms"],
              });
            } else if (audio.sampleRate !== sampleRate) {
              throw new Error(`Qwen TTS sample rate changed from ${sampleRate} to ${audio.sampleRate}`);
            }
            sampleCount += audio.samples.length;
            const output = resampler.resample(audio.samples);
            if (output.length && !cancelled) stream.write(floatMonoToStereoPcm(output));
          }
          if (part.done) break;
        }
        if (!cancelled && !completed) throw new Error("Qwen TTS stream ended before completion");
        if (!cancelled && resampler) {
          const tail = resampler.flush(new Float32Array());
          if (tail.length) stream.write(floatMonoToStereoPcm(tail));
        }
      } catch (error: unknown) {
        if (!cancelled) {
          stream.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
          throw error;
        }
      } finally {
        if (!stream.destroyed) stream.end();
      }

      const duration = sampleRate ? sampleCount / sampleRate : 0;
      if (!cancelled) {
        log("info", "speech synthesized", {
          provider: "qwen",
          duration: `${duration.toFixed(2)}s`,
          elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
        });
      }
      return duration;
    })();
    void done.catch(() => undefined);
    return {
      stream,
      done,
      cancel: () => {
        cancelled = true;
        abort.abort();
        stream.end();
      },
    };
  }
}
