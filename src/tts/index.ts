import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { GeneratedAudio } from "sherpa-onnx-node";
import sherpa from "sherpa-onnx-node";

import { log } from "../common.js";
import type { AppConfig } from "../config.js";
import { PiperTts } from "./piper.js";
import { QwenTts } from "./qwentts.js";
import type { Tts } from "./types.js";

export type { StreamingAudio, Tts, VoiceAudio } from "./types.js";

export async function createTts(config: AppConfig, qwenVoice?: string): Promise<Tts> {
  const { backend } = config.settings.tts;
  if (backend === "piper") {
    const { model_dir: modelDir, threads } = config.settings.tts.piper;
    return PiperTts.create(modelDir, threads);
  }
  if (backend === "qwen") {
    return QwenTts.create(() => {
      const settings = config.settings.tts.qwen;
      return qwenVoice ? { ...settings, voice: qwenVoice } : settings;
    }, config.qwenTtsAuthorization);
  }
  throw new Error(`Unsupported TTS backend: ${backend}`);
}

export function fillerDirectory(config: AppConfig, qwenVoice?: string): string {
  const { tts } = config.settings;
  if (tts.backend === "qwen") {
    return join(
      config.settings.agent.filler_dir,
      "qwen",
      encodeURIComponent(tts.qwen.model),
      encodeURIComponent(qwenVoice ?? tts.qwen.voice),
    );
  }
  return join(config.settings.agent.filler_dir, "piper", encodeURIComponent(tts.piper.model_dir));
}

export function loadFillers(config: AppConfig): () => [GeneratedAudio, ...GeneratedAudio[]] {
  const voices = config.settings.tts.backend === "qwen" ? config.settings.tts.qwen.voices : [undefined];
  const fillers = new Map(
    voices.map((voice) => [fillerDirectory(config, voice), readFillers(fillerDirectory(config, voice))]),
  );
  return () => {
    const directory = fillerDirectory(config);
    const selected = fillers.get(directory);
    if (!selected) throw new Error(`No prepared fillers for ${directory}; run npm run generate-fillers`);
    return selected;
  };
}

function readFillers(directory: string): [GeneratedAudio, ...GeneratedAudio[]] {
  if (!existsSync(directory)) throw new Error(`No prepared fillers for ${directory}; run npm run generate-fillers`);
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".wav"))
    .sort();
  const [first, ...rest] = files.map((file) => sherpa.readWave(join(directory, file)));
  if (!first) throw new Error(`No WAV fillers found in ${directory}`);
  const fillers: [GeneratedAudio, ...GeneratedAudio[]] = [first, ...rest];
  log("info", "fillers loaded", { directory, count: fillers.length });
  return fillers;
}
