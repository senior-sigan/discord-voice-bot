import { readdirSync } from "node:fs";

import type { GeneratedAudio } from "sherpa-onnx-node";
import sherpa from "sherpa-onnx-node";

import { log } from "../common.js";
import { PiperTts } from "./piper.js";
import { QwenTts } from "./qwentts.js";
import type { Tts } from "./types.js";

export type { StreamingAudio, Tts, VoiceAudio } from "./types.js";

export async function createTts(modelDir: string): Promise<Tts> {
  const backend = (process.env["TTS_BACKEND"] ?? "local").trim().toLowerCase();
  if (backend === "local" || backend === "piper") return PiperTts.create(modelDir);
  if (backend === "qwen") return QwenTts.create();
  throw new Error(`Unsupported TTS_BACKEND: ${backend}`);
}

export function loadFillers(directory: string): GeneratedAudio[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".wav"))
    .sort();
  if (!files.length) throw new Error(`No WAV fillers found in ${directory}`);
  const fillers = files.map((file) => sherpa.readWave(`${directory}/${file}`));
  log("info", "fillers loaded", { count: fillers.length });
  return fillers;
}
