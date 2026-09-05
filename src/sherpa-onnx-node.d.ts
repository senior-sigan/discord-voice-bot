declare module "sherpa-onnx-node" {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OfflineRecognizerResult {
    text: string;
  }

  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads: number;
      provider: "cpu";
      modelType: "nemo_transducer";
    };
    decodingMethod: "greedy_search";
    maxActivePaths: number;
  }

  export class OfflineStream {
    acceptWaveform(waveform: Waveform): void;
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
  }

  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number);
    resample(samples: Float32Array): Float32Array;
    flush(samples: Float32Array): Float32Array;
  }

  export interface VadConfig {
    sileroVad: {
      model: string;
      threshold: number;
      minSilenceDuration: number;
      minSpeechDuration: number;
      windowSize: number;
      maxSpeechDuration: number;
    };
    sampleRate: number;
    numThreads: number;
    provider: "cpu";
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
    pop(): void;
    reset(): void;
    flush(): void;
  }

  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface TtsProgress {
    samples: Float32Array;
    progress: number;
  }

  export interface OfflineTtsConfig {
    model: {
      vits?: { model: string; tokens: string; dataDir: string };
      supertonic?: {
        durationPredictor: string;
        textEncoder: string;
        vectorEstimator: string;
        vocoder: string;
        ttsJson: string;
        unicodeIndexer: string;
        voiceStyle: string;
      };
      numThreads?: number;
      provider?: "cpu";
    };
    numThreads?: number;
    provider?: "cpu";
    maxNumSentences?: number;
  }

  export class GenerationConfig {
    constructor(config: { sid: number; speed: number; numSteps: number; extra: { lang: string } });
  }

  export class OfflineTts {
    readonly sampleRate: number;
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    generateAsync(request: {
      text: string;
      sid?: number;
      speed?: number;
      generationConfig?: GenerationConfig;
      onProgress?: (progress: TtsProgress) => boolean | undefined;
    }): Promise<GeneratedAudio>;
  }

  const sherpa: {
    LinearResampler: typeof LinearResampler;
    OfflineRecognizer: typeof OfflineRecognizer;
    OfflineTts: typeof OfflineTts;
    GenerationConfig: typeof GenerationConfig;
    Vad: typeof Vad;
    readWave(filename: string): GeneratedAudio;
    writeWave(filename: string, audio: GeneratedAudio): boolean;
  };
  export default sherpa;
}
