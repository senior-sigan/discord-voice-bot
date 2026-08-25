import { isRecord, log } from "../common.js";

export type LlmMessage = Record<string, unknown>;

export interface ChatRequest {
  messages: LlmMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: "auto" | "required";
}

export interface LlmClient {
  modelName(): Promise<string>;
  chat(request: ChatRequest): Promise<LlmMessage>;
}

export function needsThinkingPrefill(model: string): boolean {
  return /(^|[/_-])qwen3(?:\.\d+)?([/_-]|$)/i.test(model);
}

export function selectLlmModel(configured: string | undefined, available: string[]): string | undefined {
  const chatModels = available.filter((model) => !model.startsWith("text-embedding-"));
  if (!configured) return chatModels[0];
  if (chatModels.includes(configured)) return configured;
  const aliases = chatModels.filter((model) => model.startsWith(`${configured}-`));
  return aliases.length === 1 ? aliases[0] : undefined;
}

export function llmText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
    .join("")
    .trim();
}

export class LocalLlmClient implements LlmClient {
  private model: string | undefined;

  constructor(private readonly baseUrl: string) {}

  async modelName(): Promise<string> {
    if (this.model) return this.model;
    const response = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`LLM models request failed: HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body["data"])) throw new Error("Invalid LLM models response");
    const available = body["data"].flatMap((candidate) =>
      isRecord(candidate) && typeof candidate["id"] === "string" ? [candidate["id"]] : [],
    );
    const configured = process.env["LLM_MODEL"];
    this.model = selectLlmModel(configured, available);
    if (!this.model) {
      throw new Error(configured ? `LLM model '${configured}' not found` : "No chat model loaded in LLM server");
    }
    if (configured && configured !== this.model) {
      log("info", "resolved LLM model alias", { configured, model: this.model });
    }
    return this.model;
  }

  async chat(request: ChatRequest): Promise<LlmMessage> {
    const model = await this.modelName();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env["LLM_API_KEY"]) headers["authorization"] = `Bearer ${process.env["LLM_API_KEY"]}`;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(request.timeoutMs),
      body: JSON.stringify({
        model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
        ...(needsThinkingPrefill(model) ? { reasoning_effort: "none" } : {}),
      }),
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`LLM request failed: HTTP ${response.status}: ${details}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body["choices"])) throw new Error("Invalid LLM response");
    const choice = body["choices"][0];
    const message = isRecord(choice) ? choice["message"] : undefined;
    if (!isRecord(message)) throw new Error("Invalid LLM message");
    return message;
  }
}
