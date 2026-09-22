import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { GeneratedAudio } from "sherpa-onnx-node";
import sherpa from "sherpa-onnx-node";

import { log } from "../common.ts";
import type { AppConfig } from "../config.ts";
import { QwenTts } from "./qwentts.ts";
import { SherpaTts } from "./sherpa.ts";
import type { Tts } from "./types.ts";

export type { StreamingAudio, Tts, VoiceAudio } from "./types.ts";

export async function createTts(config: AppConfig, voice?: string): Promise<Tts> {
  const { backend } = config.settings.tts;
  if (backend === "piper") {
    const { model_dir: modelDir, threads } = config.settings.tts.piper;
    return SherpaTts.createPiper(modelDir, threads);
  }
  if (backend === "supertonic") {
    const {
      model_dir: modelDir,
      threads,
      voice: configuredVoice,
      speed,
      num_steps: numSteps,
    } = config.settings.tts.supertonic;
    return SherpaTts.createSupertonic(modelDir, threads, voice ?? configuredVoice, speed, numSteps);
  }
  if (backend === "qwen") {
    return QwenTts.create(() => {
      const settings = config.settings.tts.qwen;
      return voice ? { ...settings, voice } : settings;
    }, config.qwenTtsAuthorization);
  }
  throw new Error(`Unsupported TTS backend: ${backend}`);
}

export function fillerDirectory(config: AppConfig, voice?: string): string {
  const { tts } = config.settings;
  if (tts.backend === "qwen") {
    return join(
      config.settings.agent.filler_dir,
      "qwen",
      encodeURIComponent(tts.qwen.model),
      encodeURIComponent(voice ?? tts.qwen.voice),
    );
  }
  if (tts.backend === "supertonic") {
    return join(
      config.settings.agent.filler_dir,
      "supertonic",
      encodeURIComponent(tts.supertonic.model_dir),
      encodeURIComponent(voice ?? tts.supertonic.voice),
    );
  }
  return join(config.settings.agent.filler_dir, "piper", "0");
}

export function loadFillers(config: AppConfig): () => [GeneratedAudio, ...GeneratedAudio[]] {
  const { tts } = config.settings;
  if (tts.backend === "piper") {
    const directory = fillerDirectory(config);
    const fillers = readFillers(
      waveFiles(directory).length > 0 ? directory : join(config.settings.agent.filler_dir, "piper"),
    );
    return () => fillers;
  }
  const voices = tts.backend === "qwen" ? tts.qwen.voices : tts.supertonic.voices;
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

function waveFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && file.name.endsWith(".wav"))
    .map((file) => file.name)
    .sort();
}

function readFillers(directory: string): [GeneratedAudio, ...GeneratedAudio[]] {
  if (!existsSync(directory)) throw new Error(`No prepared fillers for ${directory}; run npm run generate-fillers`);
  const files = waveFiles(directory);
  const [first, ...rest] = files.map((file) => sherpa.readWave(join(directory, file)));
  if (!first) throw new Error(`No WAV fillers found in ${directory}`);
  const fillers: [GeneratedAudio, ...GeneratedAudio[]] = [first, ...rest];
  log("info", "fillers loaded", { directory, count: fillers.length });
  return fillers;
}
