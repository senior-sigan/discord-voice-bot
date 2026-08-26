import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import sherpa from "sherpa-onnx-node";

import { stereoPcmToMono } from "../audio.js";
import { errorMessage } from "../common.js";
import { createTts } from "../tts/index.js";

const FILLERS = [
  ["01-hm-seychas.wav", "Хм, сейчас."],
  ["02-sekundu.wav", "Секунду."],
  ["03-ugu-pogodi.wav", "Угу, погоди."],
  ["04-tak-seychas.wav", "Так, сейчас."],
  ["05-odnu-sekundu.wav", "Одну секунду."],
  ["06-da-seychas.wav", "Да, сейчас."],
] as const;

async function run(): Promise<void> {
  const directory = process.env["FILLER_DIR"] ?? "assets/fillers";
  const tts = await createTts(process.env["TTS_MODEL_DIR"] ?? "models/vits-piper-ru_RU-ruslan-medium");
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
