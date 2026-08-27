import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { isRecord, log } from "./common.js";

const autoParticipationModeSchema = z.enum(["off", "shadow", "on"]);
const nonBlankString = z.string().trim().min(1);
const qwenVoiceSchema = nonBlankString.regex(/^[a-z0-9_-]+$/iu);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const endpointUrl = z.url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password;
}, "Keep URL credentials in environment variables");

const settingsSchema = z.strictObject({
  discord: z.strictObject({ guild_id: z.string().trim() }),
  ai: z.strictObject({
    provider: z.enum(["openai-codex", "openai-compatible"]),
    model: nonBlankString,
    openai_compatible: z.strictObject({
      base_url: endpointUrl,
      context_window: positiveInteger.min(1_024),
      max_tokens: positiveInteger.min(64),
    }),
  }),
  stt: z.strictObject({
    model_dir: nonBlankString,
    vad_model: nonBlankString,
    vad_threshold: z.number().min(0).max(1),
    threads: positiveInteger,
  }),
  tts: z.strictObject({
    backend: z.enum(["piper", "qwen"]),
    piper: z.strictObject({
      model_dir: nonBlankString,
      threads: positiveInteger,
    }),
    qwen: z
      .strictObject({
        base_url: endpointUrl,
        sample_rate: positiveInteger,
        model: nonBlankString,
        voice: qwenVoiceSchema,
        voices: z.array(qwenVoiceSchema).min(1),
      })
      .refine(({ voice, voices }) => voices.includes(voice), {
        path: ["voice"],
        message: "Selected Qwen voice must be listed in voices",
      })
      .refine(({ voices }) => new Set(voices).size === voices.length, {
        path: ["voices"],
        message: "Qwen voices must be unique",
      }),
  }),
  agent: z.strictObject({
    timezone: nonBlankString,
    filler_dir: nonBlankString,
    wake_cooldown_ms: nonNegativeInteger,
    context_chars: positiveInteger.min(1_000),
    auto_participation: z.strictObject({
      mode: autoParticipationModeSchema,
      silence_ms: nonNegativeInteger,
      check_interval_ms: nonNegativeInteger,
      cooldown_ms: nonNegativeInteger,
      context_ms: positiveInteger,
    }),
  }),
  sleep: z.strictObject({
    max_tokens: positiveInteger.min(1_024),
    chunk_chars: positiveInteger.min(1_000),
  }),
  memes: z.strictObject({
    llm_base_url: endpointUrl,
    llm_model: nonBlankString,
  }),
});

const overridesSchema = z.strictObject({
  ai: z.strictObject({ model: nonBlankString.optional() }).optional(),
  tts: z.strictObject({ qwen: z.strictObject({ voice: qwenVoiceSchema.optional() }).optional() }).optional(),
  agent: z
    .strictObject({ auto_participation: z.strictObject({ mode: autoParticipationModeSchema.optional() }).optional() })
    .optional(),
});

const configDocumentSchema = z.strictObject({ defaults: settingsSchema, overrides: overridesSchema });

export type RuntimeSettings = z.infer<typeof settingsSchema>;
export type MutableConfigKey = "ai.model" | "tts.qwen.voice" | "agent.auto_participation.mode";
type ConfigDocument = z.infer<typeof configDocumentSchema>;

const INITIAL_DEFAULTS: RuntimeSettings = {
  discord: { guild_id: "" },
  ai: {
    provider: "openai-compatible",
    model: "auto",
    openai_compatible: {
      base_url: "http://127.0.0.1:1234/v1",
      context_window: 32_768,
      max_tokens: 1_024,
    },
  },
  stt: {
    model_dir: "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    vad_model: "models/vad/silero_vad_v5.onnx",
    vad_threshold: 0.6,
    threads: 2,
  },
  tts: {
    backend: "piper",
    piper: {
      model_dir: "models/vits-piper-ru_RU-ruslan-medium",
      threads: 2,
    },
    qwen: {
      base_url: "http://127.0.0.1:8000",
      sample_rate: 24_000,
      model: "tts-1",
      voice: "keltuzad",
      voices: ["keltuzad", "arthas", "sorceress"],
    },
  },
  agent: {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    filler_dir: "assets/fillers",
    wake_cooldown_ms: 5_000,
    context_chars: 12_000,
    auto_participation: {
      mode: "off",
      silence_ms: 4_000,
      check_interval_ms: 15_000,
      cooldown_ms: 120_000,
      context_ms: 300_000,
    },
  },
  sleep: { max_tokens: 8_192, chunk_chars: 60_000 },
  memes: {
    llm_base_url: "http://127.0.0.1:1234/v1",
    llm_model: "qwen/qwen3.6-35b-a3b",
  },
};

export interface AppSecrets {
  discordToken: string;
  openAiCompatibleApiKey?: string;
  memeLlmApiKey?: string;
  qwenTtsAuthorization?: string;
}

export class AppConfig {
  readonly file: string;
  readonly discordToken: string;
  readonly openAiCompatibleApiKey: string | undefined;
  readonly memeLlmApiKey: string | undefined;
  readonly qwenTtsAuthorization: string | undefined;
  private document: ConfigDocument;
  private effectiveSettings: RuntimeSettings;

  constructor(
    readonly dataDir: string,
    secrets: AppSecrets,
  ) {
    this.file = join(dataDir, "config.json");
    this.discordToken = secrets.discordToken;
    this.openAiCompatibleApiKey = secrets.openAiCompatibleApiKey;
    this.memeLlmApiKey = secrets.memeLlmApiKey;
    this.qwenTtsAuthorization = secrets.qwenTtsAuthorization;
    if (!existsSync(this.file)) this.saveDocument({ defaults: INITIAL_DEFAULTS, overrides: {} });
    this.document = this.readDocument();
    this.effectiveSettings = effectiveSettings(this.document);
    log("info", "config loaded", {
      file: this.file,
      model: this.effectiveSettings.ai.model,
      tts_voice: this.effectiveSettings.tts.qwen.voice,
      auto_participation: this.effectiveSettings.agent.auto_participation.mode,
    });
  }

  get settings(): RuntimeSettings {
    return this.effectiveSettings;
  }

  get aiAuthFile(): string {
    return this.dataPath("auth.json");
  }

  get historyFile(): string {
    return this.dataPath("history.jsonl");
  }

  get memoryFile(): string {
    return this.dataPath("memory.jsonl");
  }

  get profilesFile(): string {
    return this.dataPath("profiles.json");
  }

  get tasksFile(): string {
    return this.dataPath("tasks.json");
  }

  dataPath(...parts: string[]): string {
    return join(this.dataDir, ...parts);
  }

  setOverride(key: MutableConfigKey, rawValue: string): RuntimeSettings {
    const next = structuredClone(this.document);
    if (key === "ai.model") {
      next.overrides.ai ??= {};
      next.overrides.ai.model = nonBlankString.parse(rawValue);
    } else if (key === "tts.qwen.voice") {
      next.overrides.tts ??= {};
      next.overrides.tts.qwen ??= {};
      next.overrides.tts.qwen.voice = nonBlankString.parse(rawValue);
    } else {
      next.overrides.agent ??= {};
      next.overrides.agent.auto_participation ??= {};
      next.overrides.agent.auto_participation.mode = autoParticipationModeSchema.parse(rawValue.trim().toLowerCase());
    }
    const document = configDocumentSchema.parse(next);
    const settings = effectiveSettings(document);
    this.saveDocument(document);
    this.document = document;
    this.effectiveSettings = settings;
    log("info", "config override changed", { key, value: rawValue });
    return settings;
  }

  private readDocument(): ConfigDocument {
    const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    const parsed = configDocumentSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new Error(`Invalid config ${this.file}: ${z.prettifyError(parsed.error)}`);
  }

  private saveDocument(document: ConfigDocument): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    renameSync(temporary, this.file);
  }
}

export function loadConfig(): AppConfig {
  const discordToken = process.env["DISCORD_TOKEN"];
  if (!discordToken) throw new Error("DISCORD_TOKEN is required");
  const openAiCompatibleApiKey = secret("OPENAI_COMPATIBLE_API_KEY", "LLM_API_KEY");
  const memeLlmApiKey = secret("MEME_LLM_API_KEY", "LLM_API_KEY");
  const qwenAuthorization = qwenTtsAuthorization();
  return new AppConfig(process.env["DATA_DIR"]?.trim() || ".data", {
    discordToken,
    ...(openAiCompatibleApiKey ? { openAiCompatibleApiKey } : {}),
    ...(memeLlmApiKey ? { memeLlmApiKey } : {}),
    ...(qwenAuthorization ? { qwenTtsAuthorization: qwenAuthorization } : {}),
  });
}

export function dataPath(...parts: string[]): string {
  return join(process.env["DATA_DIR"]?.trim() || ".data", ...parts);
}

function effectiveSettings(document: ConfigDocument): RuntimeSettings {
  return settingsSchema.parse(deepMerge(document.defaults, document.overrides));
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = deepMerge(base[key], value);
  return result;
}

function secret(primary: string, legacy?: string): string | undefined {
  return process.env[primary]?.trim() || (legacy ? process.env[legacy]?.trim() : undefined);
}

function qwenTtsAuthorization(): string | undefined {
  const apiKey = secret("QWEN_TTS_API_KEY");
  if (apiKey) return `Bearer ${apiKey}`;
  const username = secret("QWEN_TTS_USERNAME");
  const password = secret("QWEN_TTS_PASSWORD");
  if (username || password) {
    if (!username || !password) throw new Error("QWEN_TTS_USERNAME and QWEN_TTS_PASSWORD must be set together");
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }
  return undefined;
}
