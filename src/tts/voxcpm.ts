import { PassThrough } from "node:stream";

import sherpa from "sherpa-onnx-node";

import { floatMonoToStereoPcm, pcm16MonoToFloat } from "../audio.ts";
import { errorMessage, log } from "../common.ts";
import type { RuntimeSettings } from "../config.ts";
import { spokenText } from "./text.ts";
import type { StreamingAudio, Tts } from "./types.ts";

type Settings = RuntimeSettings["tts"]["voxcpm"];

export class VoxCpmTts implements Tts {
  private readonly settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  synthesize(text: string): StreamingAudio {
    const input = spokenText(text);
    const stream = new PassThrough();
    stream.on("error", () => undefined);
    const abort = new AbortController();
    let cancelled = false;
    const timeout = setTimeout(() => abort.abort(new Error("VoxCPM TTS generation timeout")), this.settings.timeout_ms);
    timeout.unref();
    const done = (async () => {
      const started = performance.now();
      try {
        const response = await fetch(this.settings.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.settings.model,
            input,
            voice: this.settings.voice,
            stream: false,
            response_format: this.settings.response_format,
          }),
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(`VoxCPM TTS generation failed: HTTP ${response.status} ${await response.text()}`);
        }
        const wav = Buffer.from(await response.arrayBuffer());
        if (cancelled) return 0;
        const { samples, sampleRate } = decodeWave(wav);
        const resampler = new sherpa.LinearResampler(sampleRate, 48_000);
        const output = resampler.resample(samples);
        const tail = resampler.flush(new Float32Array());
        if (output.length) stream.write(floatMonoToStereoPcm(output));
        if (tail.length) stream.write(floatMonoToStereoPcm(tail));
        const duration = samples.length / sampleRate;
        log("info", "speech synthesized", {
          provider: "voxcpm",
          duration: `${duration.toFixed(2)}s`,
          elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
        });
        return duration;
      } catch (error: unknown) {
        if (cancelled) return 0;
        stream.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
        throw error;
      } finally {
        clearTimeout(timeout);
        if (!stream.destroyed) stream.end();
      }
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

// Use the WAV header rather than assuming a sample rate.
function decodeWave(wav: Buffer): { samples: Float32Array; sampleRate: number } {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("VoxCPM TTS returned invalid WAV audio");
  }
  const end = wav.readUInt32LE(4) + 8;
  if (end !== wav.length) throw new Error("VoxCPM TTS returned truncated or invalid WAV audio");
  let sampleRate = 0;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset < end; ) {
    if (offset + 8 > end) throw new Error("VoxCPM TTS returned truncated WAV chunk");
    const kind = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + (size % 2) > end) throw new Error("VoxCPM TTS returned truncated WAV chunk");
    if (kind === "fmt ") {
      if (
        size < 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt16LE(start + 14) !== 16 ||
        wav.readUInt16LE(start + 12) !== 2
      ) {
        throw new Error("VoxCPM TTS requires mono PCM16 WAV audio");
      }
      sampleRate = wav.readUInt32LE(start + 4);
    } else if (kind === "data") {
      pcm = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !pcm?.length || pcm.length % 2) throw new Error("VoxCPM TTS returned empty or invalid WAV audio");
  return { samples: pcm16MonoToFloat(pcm), sampleRate };
}
