import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { AutoModel, AutoTokenizer, FeatureExtractionPipeline } from "@huggingface/transformers";

export interface TextEmbedder {
  readonly identity: string;
  readonly dimension: number;
  split(text: string): Promise<string[]>;
  embed(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]>;
}

/** E5 expects English task prefixes even when the content is Russian. */
export class E5Embedder implements TextEmbedder {
  readonly identity = "Xenova/multilingual-e5-small@761b726/q8/mean/normalized/chunks480-overlap32-v1";
  readonly dimension = 384;
  private extractor: Promise<FeatureExtractionPipeline> | undefined;

  constructor(private readonly cacheDir: string) {}

  private load(): Promise<FeatureExtractionPipeline> {
    const cached = resolve(this.cacheDir, "Xenova/multilingual-e5-small/761b726");
    const local = ["tokenizer.json", "tokenizer_config.json", "config.json", "onnx/model_quantized.onnx"].every(
      (file) => existsSync(join(cached, file)),
    );
    const source = local ? cached : "Xenova/multilingual-e5-small";
    const options = {
      revision: "761b726",
      dtype: "q8" as const,
      device: "cpu" as const,
      cache_dir: resolve(this.cacheDir),
      local_files_only: local,
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    };
    // Use an explicit local path after download: Transformers.js 4 tokenizer
    // discovery otherwise probes main instead of the pinned revision/cache.
    this.extractor ??= Promise.all([
      AutoTokenizer.from_pretrained(source, options),
      AutoModel.from_pretrained(source, options),
    ])
      .then(([tokenizer, model]) => new FeatureExtractionPipeline({ task: "feature-extraction", tokenizer, model }))
      .catch((error: unknown) => {
        this.extractor = undefined;
        throw error;
      });
    return this.extractor;
  }

  async split(text: string): Promise<string[]> {
    const { tokenizer } = await this.load();
    const ids = tokenizer.encode(text, { add_special_tokens: false });
    if (ids.length <= 480) return [text];
    const chunks: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 448) {
      chunks.push(tokenizer.decode(ids.slice(offset, offset + 480), { skip_special_tokens: true }));
      if (offset + 480 >= ids.length) break;
    }
    return chunks;
  }

  async embed(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]> {
    if (!texts.length) return [];
    const extractor = await this.load();
    const inputs = texts.map((text) => `${purpose}: ${text}`);
    for (const input of inputs) {
      if (extractor.tokenizer.encode(input).length > 512) {
        throw new Error("E5 input exceeds 512 tokens; split documents or shorten the search query");
      }
    }
    const output = await extractor(inputs, { pooling: "mean", normalize: true });
    return output.tolist() as number[][];
  }
}
