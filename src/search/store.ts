import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type ZVecCollection,
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  ZVecOpen,
} from "@zvec/zvec";
import { z } from "zod";

import { E5Embedder, type TextEmbedder } from "./embeddings.js";

const dateSchema = z.iso.date();
const documentSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
  date: dateSchema.optional(),
  metadata: z.record(z.string(), z.json()).optional(),
});
const manifestSchema = z.object({
  version: z.literal(1),
  generation: z.string().uuid(),
  model: z.string(),
  dimension: z.number().int().positive(),
  fingerprint: z.string(),
  documents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
});
type Manifest = z.infer<typeof manifestSchema>;
export type SearchDocument = z.infer<typeof documentSchema>;
export interface SearchResult extends SearchDocument {
  /** Cosine similarity, not a calibrated probability. */
  score: number;
}
export interface SearchOptions {
  limit?: number;
  from?: string;
  to?: string;
}
export interface IndexProgress {
  completed: number;
  total: number;
  embedded: number;
  reused: number;
}
export interface IndexResult extends IndexProgress {
  changed: boolean;
}
export interface SyncOptions {
  rebuild?: boolean;
  onProgress?: (progress: IndexProgress) => void;
}

/** Each topic is an independent, atomically published Zvec snapshot under root. */
export class SearchStore {
  readonly root: string;
  private readonly embedder: TextEmbedder;

  constructor(root: string, embedder?: TextEmbedder) {
    this.root = resolve(root);
    this.embedder = embedder ?? new E5Embedder(join(this.root, "models"));
  }

  private topicPath(topic: string): string {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(topic) || topic === "models") {
      throw new Error(`Invalid search topic: ${topic}`);
    }
    return join(this.root, topic);
  }

  private manifest(directory: string): Manifest | undefined {
    const path = join(directory, "current.json");
    if (!existsSync(path)) return undefined;
    return manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /** Synchronizes a COMPLETE topic snapshot. Omitted IDs are removed; unchanged chunks reuse vectors. */
  async sync(topic: string, input: readonly SearchDocument[], options: SyncOptions = {}): Promise<IndexResult> {
    const directory = this.topicPath(topic);
    const documents = input.map((document) => documentSchema.parse(document)).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(documents.map(({ id }) => id)).size !== documents.length)
      throw new Error("Duplicate search document ID");
    mkdirSync(directory, { recursive: true });
    const lockPath = join(directory, "writer.lock");
    const lock = openSync(lockPath, "wx");
    const generation = randomUUID();
    const generationPath = join(directory, generation);
    let previous: ZVecCollection | undefined;
    let next: ZVecCollection | undefined;
    let published = false;
    const progress: IndexProgress = { completed: 0, total: documents.length, embedded: 0, reused: 0 };
    try {
      writeFileSync(lock, String(process.pid));
      const current = options.rebuild ? undefined : this.manifest(directory);
      const fingerprint = hash(JSON.stringify(documents));
      const compatible =
        current?.model === this.embedder.identity &&
        current.dimension === this.embedder.dimension &&
        existsSync(join(directory, current.generation));
      if (compatible && current.fingerprint === fingerprint) {
        return { ...progress, completed: documents.length, reused: current.chunks, changed: false };
      }
      if (compatible) previous = ZVecOpen(join(directory, current.generation), { readOnly: true });
      next = ZVecCreateAndOpen(
        generationPath,
        new ZVecCollectionSchema({
          name: topic,
          fields: ["text", "document", "date"].map((name) => ({ name, dataType: ZVecDataType.STRING })),
          vectors: {
            name: "embedding",
            dataType: ZVecDataType.VECTOR_FP32,
            dimension: this.embedder.dimension,
            // Exact search avoids approximate-recall losses; adequate for this local catalog.
            indexParams: { indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE },
          },
        }),
      );
      let count = 0;
      for (const document of documents) {
        const chunks = await this.embedder.split(document.text);
        if (!chunks.length) throw new Error(`No searchable chunks for ${document.id}`);
        const ids = chunks.map((_, index) => hash(`${document.id}\0${index}`));
        const cached = previous?.fetchSync(ids) ?? {};
        // Small batches bound ONNX memory even for long history messages.
        for (let start = 0; start < chunks.length; start += 8) {
          const batch = chunks.slice(start, start + 8);
          const missing = batch.filter((text, offset) => cached[ids[start + offset] ?? ""]?.fields["text"] !== text);
          const vectors = await this.embedder.embed(missing, "passage");
          if (vectors.length !== missing.length) throw new Error("Embedding count does not match input");
          let vectorIndex = 0;
          const rows = batch.map((text, offset) => {
            const id = ids[start + offset];
            if (!id) throw new Error("Missing chunk ID");
            const old = cached[id];
            const reusable = old?.fields["text"] === text;
            const vector = reusable ? old.vectors["embedding"] : vectors[vectorIndex++];
            const normalized = normalizedVector(vector, this.embedder.dimension);
            if (reusable) progress.reused++;
            else progress.embedded++;
            return {
              id,
              fields: { text, document: JSON.stringify(document), date: document.date ?? "" },
              vectors: { embedding: normalized },
            };
          });
          for (const status of next.insertSync(rows)) {
            if (!status.ok) throw new Error(`Zvec insert failed: ${status.code}: ${status.message}`);
          }
          count += rows.length;
        }
        progress.completed++;
        options.onProgress?.({ ...progress });
      }
      await next.optimize();
      next.closeSync();
      next = undefined;
      const manifest: Manifest = {
        version: 1,
        generation,
        model: this.embedder.identity,
        dimension: this.embedder.dimension,
        fingerprint,
        documents: documents.length,
        chunks: count,
      };
      const temporary = join(directory, `${generation}.json`);
      writeFileSync(temporary, JSON.stringify(manifest));
      renameSync(temporary, join(directory, "current.json"));
      published = true;
      return { ...progress, changed: true };
    } finally {
      next?.closeSync();
      previous?.closeSync();
      if (!published) rmSync(generationPath, { recursive: true, force: true });
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  }

  async search(topic: string, query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const directory = this.topicPath(topic);
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Search limit must be between 1 and 100");
    if (!query.trim()) throw new Error("Search query must not be empty");
    const clauses: string[] = [];
    if (options.from) clauses.push(`date >= '${dateSchema.parse(options.from)}'`);
    if (options.to) clauses.push(`date <= '${dateSchema.parse(options.to)}'`);
    if (options.from && options.to && options.from > options.to) throw new Error("Invalid search date range");
    const current = this.manifest(directory);
    if (!current) throw new Error(`Search topic '${topic}' is not indexed`);
    if (current.model !== this.embedder.identity || current.dimension !== this.embedder.dimension) {
      throw new Error(`Search model changed; rebuild topic '${topic}'`);
    }
    if (!current.chunks) return [];
    const vectors = await this.embedder.embed([query.trim()], "query");
    const vector = normalizedVector(vectors[0], this.embedder.dimension);
    const collection = ZVecOpen(join(directory, current.generation), { readOnly: true });
    try {
      let topk = Math.min(limit, current.chunks);
      while (true) {
        const rows = await collection.query({
          fieldName: "embedding",
          vector,
          topk,
          outputFields: ["document"],
          ...(clauses.length ? { filter: clauses.join(" AND ") } : {}),
        });
        const results = new Map<string, SearchResult>();
        for (const row of rows) {
          const document = documentSchema.parse(JSON.parse(String(row.fields["document"])));
          // Zvec COSINE returns distance (0 = identical), so expose similarity.
          if (!results.has(document.id)) results.set(document.id, { ...document, score: 1 - row.score });
        }
        if (results.size >= limit || rows.length < topk || topk === current.chunks) {
          return [...results.values()].slice(0, limit);
        }
        topk = Math.min(topk * 2, current.chunks);
      }
    } finally {
      collection.closeSync();
    }
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizedVector(value: unknown, dimension: number): number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new Error("Invalid embedding vector");
  const vector = Array.from(value as ArrayLike<number>);
  if (vector.length !== dimension || vector.some((number) => !Number.isFinite(number))) {
    throw new Error("Invalid embedding dimensions or values");
  }
  const norm = Math.hypot(...vector);
  if (!norm) throw new Error("Embedding vector must not be zero");
  return vector.map((number) => number / norm);
}
