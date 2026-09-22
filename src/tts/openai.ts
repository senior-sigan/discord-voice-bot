import { PassThrough } from "node:stream";

import sherpa from "sherpa-onnx-node";

import { floatMonoToStereoPcm, pcm16MonoToFloat } from "../audio.ts";
import { errorMessage, log } from "../common.ts";
import type { RuntimeSettings } from "../config.ts";
import { spokenText } from "./text.ts";
import type { StreamingAudio, Tts } from "./types.ts";

const { LinearResampler } = sherpa;

type Provider = "qwen" | "silero";
type SpeechSettings = RuntimeSettings["tts"][Provider];

export class OpenAiTts implements Tts {
  private readonly provider: Provider;
  private readonly settings: () => SpeechSettings;
  private readonly authorization: string | undefined;

  private constructor(provider: Provider, settings: () => SpeechSettings, authorization: string | undefined) {
    this.provider = provider;
    this.settings = settings;
    this.authorization = authorization;
  }

  static async create(provider: Provider, settings: () => SpeechSettings, authorization?: string): Promise<OpenAiTts> {
    const current = settings();
    log("info", "TTS initialized", {
      provider,
      model: current.model,
      voice: current.voice,
      endpoint: speechEndpoint(current.base_url),
    });
    return new OpenAiTts(provider, settings, authorization);
  }

  synthesize(text: string): StreamingAudio {
    const settings = this.settings();
    const endpoint = speechEndpoint(settings.base_url);
    const input = spokenText(text);
    const stream = new PassThrough();
    stream.on("error", () => undefined);
    const abort = new AbortController();
    let cancelled = false;
    let sampleCount = 0;
    let timeout = setTimeout(() => abort.abort(new Error(`${this.provider} TTS first audio timeout`)), 30_000);
    timeout.unref();

    const done = (async () => {
      const started = performance.now();
      const resampler = new LinearResampler(settings.sample_rate, 48_000);
      let pending = Buffer.alloc(0);
      let startedSpeaking = false;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.authorization ? { Authorization: this.authorization } : {}),
          },
          body: JSON.stringify({ input, model: settings.model, voice: settings.voice, response_format: "pcm" }),
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(`${this.provider} TTS generation failed: HTTP ${response.status} ${await response.text()}`);
        }
        if (!response.body) throw new Error(`${this.provider} TTS returned an empty response`);

        const reader = response.body.getReader();
        while (!cancelled) {
          const part = await reader.read();
          if (part.value?.length) {
            const pcm = Buffer.concat([pending, Buffer.from(part.value)]);
            const completeSize = pcm.length - (pcm.length % 2);
            pending = pcm.subarray(completeSize);
            const samples = pcm16MonoToFloat(pcm.subarray(0, completeSize));
            if (samples.length && !startedSpeaking) {
              startedSpeaking = true;
              log("info", `${this.provider} speech started`, {
                ttfa: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
              });
            }
            if (samples.length) {
              clearTimeout(timeout);
              timeout = setTimeout(() => abort.abort(new Error(`${this.provider} TTS audio stream stalled`)), 10_000);
              timeout.unref();
            }
            sampleCount += samples.length;
            const output = resampler.resample(samples);
            if (output.length && !cancelled) stream.write(floatMonoToStereoPcm(output));
          }
          if (part.done) break;
        }
        if (!cancelled) {
          if (pending.length) throw new Error(`${this.provider} TTS returned truncated PCM audio`);
          const tail = resampler.flush(new Float32Array());
          if (tail.length) stream.write(floatMonoToStereoPcm(tail));
        }
      } catch (error: unknown) {
        if (!cancelled) {
          stream.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
          throw error;
        }
      } finally {
        clearTimeout(timeout);
        if (!stream.destroyed) stream.end();
      }

      const duration = sampleCount / settings.sample_rate;
      if (!cancelled) {
        log("info", "speech synthesized", {
          provider: this.provider,
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
        clearTimeout(timeout);
        abort.abort();
        stream.end();
      },
    };
  }
}

function speechEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1/audio/speech")
    ? path
    : path.endsWith("/v1")
      ? `${path}/audio/speech`
      : `${path}/v1/audio/speech`;
  return url.toString();
}
