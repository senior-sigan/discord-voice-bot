import { errorMessage, isRecord, log } from "../common.js";
import { requiredToolForContext } from "../tools/index.js";
import type { AgentTool } from "../tools/types.js";
import { llmTool, parseToolArguments } from "../tools/types.js";
import type { HistoryStore } from "./history.js";
import type { LlmClient, LlmMessage } from "./llm-client.js";
import { llmText, needsThinkingPrefill } from "./llm-client.js";

const MAX_TOOL_ROUNDS = 100;

export type ToolCallListener = (name: string, args: string, announcement: string | undefined) => void;

export class AgentLoop {
  constructor(
    private readonly client: LlmClient,
    private readonly tools: AgentTool[],
    private readonly history?: HistoryStore,
  ) {}

  async toolAnnouncement(context: string, tool: string, args: string): Promise<string> {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "Ты Олег, живой участник разговора в Discord. Скажи одну естественную фразу до 12 слов о том, что сейчас сделаешь. Не сообщай результат, не упоминай инструменты или технические детали. Без Markdown и кавычек.",
      },
      {
        role: "user",
        content: `Последняя реплика: ${context.trim().split("\n").at(-1) ?? context}\nДействие: ${tool}\nАргументы: ${args}`,
      },
    ];
    if (needsThinkingPrefill(await this.client.modelName())) {
      messages.push({ role: "assistant", content: "<think>\n\n</think>\n\n" });
    }
    const message = await this.client.chat({
      messages,
      temperature: 0.9,
      maxTokens: 64,
      timeoutMs: 10_000,
    });
    const text = llmText(message["content"]);
    if (!text) throw new Error("LLM returned no tool announcement");
    return text;
  }

  async complete(context: string, onToolCall?: ToolCallListener): Promise<string> {
    const model = await this.client.modelName();
    const requiredTool = requiredToolForContext(context);
    const maxTokens = Math.max(64, Number(process.env["LLM_MAX_TOKENS"] ?? 1_024) || 1_024);
    const systemPrompt =
      "Ты Олег, старый матершинник и юморист с богатым опытом. Ты участник разговора в Discord. Отвечай по-русски, естественно и без Markdown. Давай короткие но ёмкие ответы. Учитывай реплики всех участников. Для точного времени, погоды, новостей и других актуальных фактов обязательно используй доступные инструменты. Сначала ищи, затем при необходимости прочитай найденную страницу. Когда просят вспомнить прошлый разговор или твой ответ, используй recall_history: он ищет по всей истории, включая старые запуски. Не выдумывай результаты инструментов. Перед каждым вызовом инструмента напиши в content одну короткую живую фразу о том, что ты сейчас сделаешь, не раскрывая будущий результат.";
    const prompt = `Недавний разговор:\n${context}\n\nОтветь на обращение к Олегу.`;
    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];
    if (needsThinkingPrefill(model)) messages.push({ role: "assistant", content: "<think>\n\n</think>\n\n" });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const availableTools =
        round === 0 && requiredTool ? this.tools.filter((tool) => tool.name === requiredTool) : this.tools;
      const message = await this.client.chat({
        messages,
        temperature: 0.6,
        maxTokens,
        timeoutMs: 60_000,
        tools: availableTools.map(llmTool),
        toolChoice: round === 0 && requiredTool ? "required" : "auto",
      });
      const calls = Array.isArray(message["tool_calls"]) ? message["tool_calls"].filter(isRecord) : [];
      if (!calls.length) {
        if (round === 0 && requiredTool) {
          const query = (context.trim().split("\n").at(-1) ?? context).replace(/^\[[^\]]+\]\s*[^:]+:\s*/, "");
          const args = JSON.stringify(
            requiredTool === "web_search"
              ? { query, limit: 5 }
              : requiredTool === "recall_history"
                ? { query, limit: 10 }
                : {},
          );
          const id = `forced-${requiredTool}`;
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [{ id, type: "function", function: { name: requiredTool, arguments: args } }],
          });
          messages.push({
            role: "tool",
            tool_call_id: id,
            content: await this.runTool(requiredTool, args, undefined, onToolCall),
          });
          continue;
        }
        const text = llmText(message["content"]);
        if (!text) throw new Error("LLM returned no final answer");
        return text;
      }

      messages.push({ role: "assistant", content: message["content"] ?? null, tool_calls: calls });
      for (const call of calls) {
        const id = call["id"];
        const fn = call["function"];
        if (
          typeof id !== "string" ||
          !isRecord(fn) ||
          typeof fn["name"] !== "string" ||
          typeof fn["arguments"] !== "string"
        ) {
          throw new Error("Invalid LLM tool call");
        }
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: await this.runTool(
            fn["name"],
            fn["arguments"],
            llmText(message["content"]) || undefined,
            onToolCall,
          ),
        });
      }
    }
    throw new Error(`LLM exceeded the ${MAX_TOOL_ROUNDS}-round tool limit`);
  }

  private async runTool(
    name: string,
    args: string,
    announcement: string | undefined,
    onToolCall?: ToolCallListener,
  ): Promise<string> {
    let loggedArgs: unknown = args;
    try {
      loggedArgs = JSON.parse(args);
    } catch {
      // Keep malformed arguments visible in the log; the dispatcher returns the validation error to the model.
    }
    log("info", "tool called", { tool: name, arguments: loggedArgs });
    onToolCall?.(name, args, announcement);
    const calledAt = new Date();
    const started = performance.now();
    try {
      const tool = this.tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const content = JSON.stringify(await tool.execute(parseToolArguments(args)));
      log("info", "tool completed", {
        tool: name,
        elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
      });
      return content;
    } catch (error) {
      log("error", "tool failed", { tool: name, error: errorMessage(error) });
      return JSON.stringify({ error: errorMessage(error) });
    } finally {
      try {
        this.history?.appendTool(name, loggedArgs, calledAt);
      } catch (error) {
        log("error", "tool history append failed", { tool: name, error: errorMessage(error) });
      }
    }
  }
}
