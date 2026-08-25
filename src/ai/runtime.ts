import { type Api, createModels, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

import { isRecord, log } from "../common.js";
import type { AppConfig } from "../config.js";
import { ConsolePrompter } from "./console.js";
import { JsonCredentialStore } from "./credentials.js";

export type AiProviderId = "openai-codex" | "openai-compatible";

export interface AiRuntime {
  models: Models;
  model: Model<Api>;
}

export async function createAiRuntime(config: AppConfig, interactive: boolean): Promise<AiRuntime> {
  const prompt = interactive ? new ConsolePrompter() : undefined;
  try {
    const provider = interactive
      ? await prompt!.choose<AiProviderId>("Провайдер модели", [
          { id: "openai-codex", label: "OpenAI Codex — подписка ChatGPT Plus/Pro" },
          { id: "openai-compatible", label: "OpenAI-compatible — LM Studio, llama.cpp, vLLM" },
        ])
      : normalizeProvider(config.aiProvider);
    return await (provider === "openai-codex"
      ? setupOpenAiCodex(config, prompt)
      : setupOpenAiCompatible(config, prompt));
  } finally {
    prompt?.close();
  }
}

function normalizeProvider(value: string): AiProviderId {
  const provider = value.trim().toLowerCase();
  if (provider === "openai-codex") return provider;
  if (provider === "openai-compatible" || provider === "lm-studio" || provider === "lmstudio") {
    return "openai-compatible";
  }
  throw new Error(`Unsupported AI_PROVIDER: ${value}`);
}

async function setupOpenAiCodex(config: AppConfig, prompt?: ConsolePrompter): Promise<AiRuntime> {
  const models = createModels({ credentials: new JsonCredentialStore(config.aiAuthFile) });
  models.setProvider(openaiCodexProvider());
  if (!(await models.checkAuth("openai-codex"))) {
    if (!prompt) {
      throw new Error("OpenAI Codex is not authenticated. Run: npm run ai:login");
    }
    await models.login("openai-codex", "oauth", prompt.authInteraction());
  }
  const model = await chooseModel(models, "openai-codex", config.aiModel ?? "gpt-5.6-terra", prompt);
  log("info", "AI model selected", { provider: model.provider, model: model.id });
  return { models, model };
}

async function setupOpenAiCompatible(config: AppConfig, prompt?: ConsolePrompter): Promise<AiRuntime> {
  const discovered = await discoverOpenAiCompatibleModels(
    config.openAiCompatibleBaseUrl,
    config.openAiCompatibleApiKey,
  );
  const catalog = discovered.map(
    (id): Model<"openai-completions"> => ({
      id,
      name: id,
      api: "openai-completions",
      provider: "openai-compatible",
      baseUrl: config.openAiCompatibleBaseUrl,
      reasoning: /(?:qwen.?3|deepseek.?r1|gpt-oss)/iu.test(id),
      thinkingLevelMap: { off: "none" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.aiContextWindow,
      maxTokens: config.aiMaxTokens,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    }),
  );
  const provider = createProvider({
    id: "openai-compatible",
    name: "OpenAI-compatible",
    baseUrl: config.openAiCompatibleBaseUrl,
    auth: {
      apiKey: {
        name: "OpenAI-compatible API key",
        resolve: async () => ({
          auth: { apiKey: config.openAiCompatibleApiKey ?? "local" },
        }),
      },
    },
    models: catalog,
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const model = await chooseModel(models, "openai-compatible", config.aiModel ?? discovered[0], prompt);
  log("info", "AI model selected", {
    provider: model.provider,
    model: model.id,
    base_url: config.openAiCompatibleBaseUrl,
  });
  return { models, model };
}

async function chooseModel(
  models: Models,
  provider: AiProviderId,
  configured: string | undefined,
  prompt?: ConsolePrompter,
): Promise<Model<Api>> {
  const available = models.getModels(provider);
  if (!available.length) throw new Error(`No models available for provider: ${provider}`);
  if (prompt) {
    const id = await prompt.choose(
      "Модель",
      available.map((model) => ({ id: model.id, label: `${model.name} (${model.id})` })),
    );
    return models.getModel(provider, id)!;
  }
  const model = configured ? models.getModel(provider, configured) : available[0];
  if (!model) {
    throw new Error(
      `AI model '${configured}' not found for ${provider}. Available: ${available.map((item) => item.id).join(", ")}`,
    );
  }
  return model;
}

async function discoverOpenAiCompatibleModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OpenAI-compatible models request failed: HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body["data"])) {
    throw new Error("Invalid OpenAI-compatible models response");
  }
  const models = body["data"].flatMap((entry) =>
    isRecord(entry) && typeof entry["id"] === "string" && !entry["id"].startsWith("text-embedding-")
      ? [entry["id"]]
      : [],
  );
  if (!models.length) throw new Error("OpenAI-compatible server returned no chat models");
  return models;
}
