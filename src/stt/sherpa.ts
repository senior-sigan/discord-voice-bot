import { existsSync } from "node:fs";
import type { OfflineRecognizer as OfflineRecognizerType, VadConfig } from "sherpa-onnx-node";
import sherpa from "sherpa-onnx-node";

import { isFillerOnlyTranscript } from "../agent/transcript.ts";
import { errorMessage, log } from "../common.ts";
import { SAMPLE_RATE, type SpeechInput, type Transcriber, type Transcript } from "./types.ts";
import { createVadConfig, SpeechSegmenter } from "./vad.ts";

const { OfflineRecognizer, Vad } = sherpa;

export class SherpaTranscriber implements Transcriber {
  // ponytail: one queue avoids native decoder contention; add a small worker pool if STT latency reaches audio duration.
  private queue: Promise<void> = Promise.resolve();

  private readonly recognizer: OfflineRecognizerType;
  private readonly vadConfig: VadConfig;

  private constructor(recognizer: OfflineRecognizerType, vadConfig: VadConfig) {
    this.recognizer = recognizer;
    this.vadConfig = vadConfig;
  }

  static async create(
    backend: "parakeet" | "gigaam",
    modelDir: string,
    vadModel: string,
    vadThreshold: number,
    threads: number,
  ): Promise<SherpaTranscriber> {
    const gigaam = backend === "gigaam";
    const encoder = "encoder.int8.onnx";
    const decoder = gigaam ? "decoder.onnx" : "decoder.int8.onnx";
    const joiner = gigaam ? "joiner.onnx" : "joiner.int8.onnx";
    const files = [encoder, decoder, joiner, "tokens.txt"];
    for (const file of files) {
      const path = `${modelDir}/${file}`;
      if (!existsSync(path)) throw new Error(`${backend} model file not found: ${path}`);
    }
    log("info", "loading STT model", { backend, model_dir: modelDir });
    const vadConfig = createVadConfig(vadModel, vadThreshold);
    const recognizer = await OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: gigaam ? 64 : 80 },
      modelConfig: {
        transducer: {
          encoder: `${modelDir}/${encoder}`,
          decoder: `${modelDir}/${decoder}`,
          joiner: `${modelDir}/${joiner}`,
        },
        tokens: `${modelDir}/tokens.txt`,
        numThreads: threads,
        provider: "cpu",
        modelType: "nemo_transducer",
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
    });
    log("info", "transcriber initialized", {
      provider: "cpu",
      model: gigaam ? "gigaam-v3-rnnt-int8" : "parakeet-tdt-0.6b-v3-int8",
      vad: "silero-v5",
      vad_threshold: vadThreshold,
    });
    return new SherpaTranscriber(recognizer, vadConfig);
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
        const stream = this.recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        const result = await this.recognizer.decodeAsync(stream);
        if (signal.aborted) return;
        const text = result.text.trim();
        if (!text || isFillerOnlyTranscript(text)) return;
        log("info", "transcript", {
          user: meta.user,
          duration: `${(samples.length / SAMPLE_RATE).toFixed(2)}s`,
          elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
          text,
        });
        onTranscript({ ...meta, text });
      })
      .catch((error: unknown) => log("error", "transcription failed", { user: meta.user, error: errorMessage(error) }));
  }
}
