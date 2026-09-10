import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { dataPath } from "../config.js";
import { type SearchDocument, SearchStore } from "../search/index.js";

const memeSchema = z
  .object({
    attachment_id: z.string().min(1),
    timestamp: z.iso.datetime({ offset: true }),
    description: z.string().trim().min(1),
    path: z.string().min(1),
  })
  .passthrough();

/** Fail the whole import on malformed rows rather than silently publishing an incomplete catalog. */
export function readMemeDocuments(path: string): SearchDocument[] {
  const directory = dirname(resolve(path));
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        const meme = memeSchema.parse(JSON.parse(line));
        const timestamp = new Date(meme.timestamp);
        const date = [timestamp.getFullYear(), timestamp.getMonth() + 1, timestamp.getDate()]
          .map((part, position) => String(part).padStart(position === 0 ? 4 : 2, "0"))
          .join("-");
        return [
          {
            id: meme.attachment_id,
            text: meme.description,
            date,
            metadata: { raw: JSON.stringify({ ...meme, path: resolve(directory, meme.path) }) },
          },
        ];
      } catch (error) {
        throw new Error(`Invalid meme at ${path}:${index + 1}`, { cause: error });
      }
    });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--rebuild")) {
    throw new Error("Usage: npm run index-memes -- [--rebuild] (synchronizes the complete catalog)");
  }
  const documents = readMemeDocuments(dataPath("memes", "images_explained.jsonl"));
  if (!documents.length) throw new Error("Meme catalog is empty; run explain-memes first");
  console.log(`Indexing ${documents.length} memes with multilingual-e5-small (local ONNX CPU).`);
  const store = new SearchStore(dataPath("search"));
  const result = await store.sync("memes", documents, {
    rebuild: args.includes("--rebuild"),
    onProgress: (progress) => {
      if (progress.completed % 100 === 0 || progress.completed === progress.total) {
        console.log(
          `${progress.completed}/${progress.total}: embedded ${progress.embedded}, reused ${progress.reused} chunks`,
        );
      }
    },
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
