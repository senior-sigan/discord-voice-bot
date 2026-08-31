import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import sherpa from "sherpa-onnx-node";

import { stereoPcmToMono } from "../audio.js";
import { errorMessage } from "../common.js";
import { loadConfig } from "../config.js";
import { createTts, fillerDirectory, type Tts } from "../tts/index.js";

const FILLERS = [
  ["01-hm-seychas.wav", "Хм, сейчас."],
  ["02-sekundu.wav", "Секунду."],
  ["03-ugu-pogodi.wav", "Угу, погоди."],
  ["04-tak-seychas.wav", "Так, сейчас."],
  ["05-odnu-sekundu.wav", "Одну секунду."],
  ["06-da-seychas.wav", "Да, сейчас."],
] as const;

async function run(): Promise<void> {
  const config = loadConfig();
  const { tts } = config.settings;
  if (tts.backend === "qwen" || tts.backend === "supertonic") {
    const voices = tts.backend === "qwen" ? tts.qwen.voices : tts.supertonic.voices;
    for (const voice of voices) {
      await generate(await createTts(config, voice), fillerDirectory(config, voice));
    }
    return;
  }
  await generate(await createTts(config), fillerDirectory(config));
}

async function generate(tts: Tts, directory: string): Promise<void> {
  mkdirSync(directory, { recursive: true });

  for (const [file, text] of FILLERS) {
    const audio = tts.synthesize(text);
    const chunks: Buffer[] = [];
    await Promise.all([
      audio.done,
      (async () => {
        for await (const chunk of audio.stream) chunks.push(Buffer.from(chunk));
      })(),
    ]);
    const path = join(directory, file);
    if (!sherpa.writeWave(path, { samples: stereoPcmToMono(Buffer.concat(chunks)), sampleRate: 48_000 })) {
      throw new Error(`Failed to write filler: ${path}`);
    }
    console.log(path);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
