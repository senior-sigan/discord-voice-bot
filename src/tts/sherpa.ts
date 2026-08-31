import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";

import type { OfflineTts as OfflineTtsType } from "sherpa-onnx-node";
import sherpa from "sherpa-onnx-node";

import { floatMonoToStereoPcm } from "../audio.js";
import { errorMessage, log } from "../common.js";
import { spokenText } from "./text.js";
import { type StreamingAudio, SUPERTONIC_VOICES, type Tts } from "./types.js";

const { LinearResampler, OfflineTts } = sherpa;

type GenerationRequest =
  | { sid: number; speed: number }
  | { generationConfig: InstanceType<typeof sherpa.GenerationConfig> };

export class SherpaTts implements Tts {
  private constructor(
    private readonly tts: OfflineTtsType,
    private readonly generation: GenerationRequest = { sid: 0, speed: 1 },
  ) {}

  static async createPiper(modelDir: string, threads: number): Promise<SherpaTts> {
    const model = `${modelDir}/ru_RU-ruslan-medium.onnx`;
    const tokens = `${modelDir}/tokens.txt`;
    const dataDir = `${modelDir}/espeak-ng-data`;
    for (const path of [model, tokens, dataDir]) {
      if (!existsSync(path)) throw new Error(`TTS model file not found: ${path}`);
    }
    log("info", "loading Russian TTS", { model_dir: modelDir });
    const tts = await OfflineTts.createAsync({
      model: { vits: { model, tokens, dataDir } },
      numThreads: threads,
      provider: "cpu",
    });
    log("info", "TTS initialized", { provider: "cpu", voice: "ru_RU-ruslan-medium" });
    return new SherpaTts(tts);
  }

  static async createSupertonic(
    modelDir: string,
    threads: number,
    voice: string,
    speed: number,
    numSteps: number,
  ): Promise<SherpaTts> {
    const speakerId = supertonicSpeakerId(voice);
    const paths = {
      durationPredictor: `${modelDir}/duration_predictor.int8.onnx`,
      textEncoder: `${modelDir}/text_encoder.int8.onnx`,
      vectorEstimator: `${modelDir}/vector_estimator.int8.onnx`,
      vocoder: `${modelDir}/vocoder.int8.onnx`,
      ttsJson: `${modelDir}/tts.json`,
      unicodeIndexer: `${modelDir}/unicode_indexer.bin`,
      voiceStyle: `${modelDir}/voice.bin`,
    };
    for (const path of Object.values(paths)) {
      if (!existsSync(path)) throw new Error(`TTS model file not found: ${path}`);
    }
    log("info", "loading Supertonic TTS", { model_dir: modelDir });
    const tts = await OfflineTts.createAsync({
      model: { supertonic: paths, numThreads: threads, provider: "cpu" },
      maxNumSentences: 1,
    });
    log("info", "TTS initialized", { provider: "cpu", voice, language: "ru" });
    return new SherpaTts(tts, {
      generationConfig: new sherpa.GenerationConfig({
        sid: speakerId,
        speed,
        numSteps,
        extra: { lang: "ru" },
      }),
    });
  }

  synthesize(text: string): StreamingAudio {
    const input = spokenText(text);
    const started = performance.now();
    const stream = new PassThrough();
    stream.on("error", () => undefined);
    const resampler = new LinearResampler(this.tts.sampleRate, 48_000);
    let sampleCount = 0;
    let cancelled = false;
    const done = this.tts
      .generateAsync({
        text: input,
        ...this.generation,
        onProgress: ({ samples }) => {
          if (cancelled) return false;
          sampleCount += samples.length;
          const output = resampler.resample(samples);
          if (output.length) stream.write(floatMonoToStereoPcm(output));
          return true;
        },
      })
      .then(() => {
        if (cancelled) return sampleCount / this.tts.sampleRate;
        const tail = resampler.flush(new Float32Array());
        if (tail.length) stream.write(floatMonoToStereoPcm(tail));
        stream.end();
        const duration = sampleCount / this.tts.sampleRate;
        log("info", "speech synthesized", {
          duration: `${duration.toFixed(2)}s`,
          elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
        });
        return duration;
      })
      .catch((error: unknown) => {
        stream.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
        throw error;
      });
    void done.catch(() => undefined);
    return {
      stream,
      done,
      cancel: () => {
        cancelled = true;
        stream.end();
      },
    };
  }
}

export function supertonicSpeakerId(voice: string): number {
  const speakerId = SUPERTONIC_VOICES.indexOf(voice as (typeof SUPERTONIC_VOICES)[number]);
  if (speakerId < 0) throw new Error(`Unknown Supertonic voice: ${voice}`);
  return speakerId;
}
