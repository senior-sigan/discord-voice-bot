import { existsSync } from "node:fs";
import type { OfflineRecognizer as OfflineRecognizerType, VadConfig } from "sherpa-onnx-node";
import sherpa from "sherpa-onnx-node";

import { isFillerOnlyTranscript } from "../agent/transcript.js";
import { errorMessage, log } from "../common.js";
import type { SpeechInput, Transcriber, Transcript } from "./types.js";
import { SpeechSegmenter } from "./vad.js";

const { OfflineRecognizer, Vad } = sherpa;

export const SAMPLE_RATE = 16_000;

export class ParakeetTranscriber implements Transcriber {
  // ponytail: one queue avoids native decoder contention; add a small worker pool if STT latency reaches audio duration.
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly recognizer: OfflineRecognizerType,
    private readonly vadConfig: VadConfig,
  ) {}

  static async create(
    modelDir: string,
    vadModel: string,
    vadThreshold: number,
    threads: number,
  ): Promise<ParakeetTranscriber> {
    const files = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
    for (const file of files) {
      const path = `${modelDir}/${file}`;
      if (!existsSync(path)) throw new Error(`Parakeet model file not found: ${path}`);
    }
    if (!existsSync(vadModel)) throw new Error(`VAD model file not found: ${vadModel}`);

    log("info", "loading Parakeet", { model_dir: modelDir });
    const recognizer = await OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: `${modelDir}/encoder.int8.onnx`,
          decoder: `${modelDir}/decoder.int8.onnx`,
          joiner: `${modelDir}/joiner.int8.onnx`,
        },
        tokens: `${modelDir}/tokens.txt`,
        numThreads: threads,
        provider: "cpu",
        modelType: "nemo_transducer",
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
    });
    const vadConfig: VadConfig = {
      sileroVad: {
        model: vadModel,
        threshold: vadThreshold,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.3,
        windowSize: 512,
        maxSpeechDuration: 20,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
    };
    log("info", "transcriber initialized", {
      provider: "cpu",
      model: "parakeet-tdt-0.6b-v3-int8",
      vad: "silero-v5",
      vad_threshold: vadThreshold,
    });
    return new ParakeetTranscriber(recognizer, vadConfig);
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
