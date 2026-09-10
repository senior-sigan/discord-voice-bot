# Local semantic search

`SearchStore` is independent of Discord, memes, agent history, and application config.
The caller provides a database **directory** (Zvec uses multiple files), a topic,
and records containing `id`, `text`, optional `date` (`YYYY-MM-DD`), and JSON `metadata`.

```ts
import { SearchStore } from "./search/index.js";

const search = new SearchStore(".data/search");
await search.sync("memory", [
  { id: "fact-1", text: "Пользователь предпочитает локальное распознавание речи", metadata: { userId: "123" } },
]);
const matches = await search.search("memory", "Какой вариант STT предпочитает пользователь?", { limit: 5 });
```

`sync(topic, documents, { onProgress?, rebuild? })` receives the **complete desired snapshot** of
one topic. IDs absent from this snapshot disappear from subsequent searches. This
is not an append/upsert method: do not pass only the latest messages when syncing
history. `rebuild: true` ignores the previous index and recomputes all vectors;
it also allows repairing a corrupt manifest/database. Duplicate IDs and malformed documents fail before publication. An empty
snapshot intentionally clears the topic. Use stable message/fact IDs, not line numbers.

`search(topic, query, { limit?, from?, to? })` returns original records and cosine
similarity scores, ordered by the best matching chunk. Limits are 1–100. Dates are
inclusive prefilters applied inside Zvec, before top-k. Metadata is returned but
is not embedded or available as an arbitrary filter. Topics are separate physical
collections; the same document ID can exist independently in different topics.

## Embeddings and retrieval

- Local `Xenova/multilingual-e5-small`, pinned model revision, ONNX Q8, CPU.
- Correct E5 `query:` / `passage:` prefixes, mean pooling, L2 normalization.
- Documents over 480 tokens split into overlapping 480-token chunks with 32-token
  overlap. Search returns each original ID once, using its highest scoring chunk.
  Oversized queries are rejected instead of silently truncated.
- Zvec FLAT cosine index: exact vector search, no Levenshtein or lexical fallback.
  No fixed probability threshold: scores rank candidates, not semantic certainty.
- Missing/changed model identity requires a new `sync`; vectors from different
  models are never mixed. The model identity includes quantization and chunking.
- `TextEmbedder` can be supplied for another model or offline deterministic tests.
  It must return chunks and one finite nonzero vector of the declared size per text.

## Storage and publication

Each topic has `current.json` pointing to an immutable UUID directory containing
the Zvec database. A writer builds a new generation, reuses unchanged chunks from
the previous generation, closes the new DB, then atomically replaces the pointer.
Readers open the published generation read-only. A failed build leaves the previous
index available; concurrent writers for the same topic fail on `writer.lock`.
Different topics can be built independently. Unchanged snapshots skip model loading.

Published old generations are retained so a reader in another process cannot lose
its snapshot. They can be removed during offline maintenance when no searches or
indexers are running, preserving the generation named in `current.json` and models.
After a killed indexer, inspect the PID in `writer.lock`; remove a stale lock only
after confirming that process has exited. Failed unpublished generations may also
be removed offline. Normal exceptions release the lock and remove the failed build.

## Meme adapter

`src/scripts/index-memes.ts` reads `.data/memes/images_explained.jsonl`, uses
`attachment_id` as ID, and embeds **only description**. The full original record
with an absolute image path is stored in metadata for `search_memes`. Dates follow
the local timezone, matching the existing tool's date semantics. The JSONL catalog
remains the source of truth. Invalid lines fail the import; no partial catalog is
published. This command is separate from `explain-memes` and never calls an LLM API.

Run `mise exec -- npm run index-memes` after generating/updating descriptions.
Use `mise exec -- npm run index-memes -- --rebuild` to force a full rebuild.
The first use downloads model files; subsequent use can run from the local cache.
Indexing memory/history is a future adapter using the same store, not enabled here.
