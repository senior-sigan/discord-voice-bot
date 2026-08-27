import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";

import { errorMessage, log } from "../common.js";
import type { AppConfig } from "../config.js";
import {
  AUTO_PARTICIPATION_PROMPT,
  AUTO_PARTICIPATION_TOOL,
  type AutoParticipationVerdict,
  parseAutoParticipationVerdict,
} from "./auto-participation.js";
import type { HistoryStore } from "./history.js";
import { SYSTEM_PROMPT, TOOL_ANNOUNCEMENT_PROMPT } from "./prompts.js";
import type { SkillStore } from "./skills.js";

export type ToolCallListener = (name: string, args: string, announcement: string | undefined) => void;

export class AgentRuntime {
  private readonly agent: Agent;
  private readonly toolStartedAt = new Map<string, number>();
  private completionQueue: Promise<void> = Promise.resolve();
  private onToolCall: ToolCallListener | undefined;
  private latestAssistantText = "";
  private model: Model<Api>;

  get modelName(): string {
    return `${this.model.provider}/${this.model.id}`;
  }

  constructor(
    private readonly models: Models,
    model: Model<Api>,
    tools: AgentTool[],
    private readonly history: HistoryStore,
    private readonly skills: SkillStore,
    private readonly config: AppConfig,
  ) {
    this.model = model;
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt(),
        model,
        thinkingLevel: "off",
        tools,
      },
      streamFn: models.streamSimple.bind(models),
      sessionId: randomUUID(),
      toolExecution: "parallel",
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  switchModel(requested: string): { provider: string; model: string } {
    const available = this.models.getModels(this.model.provider);
    const exact = available.find((candidate) => candidate.id.toLowerCase() === requested.trim().toLowerCase());
    const tokens = requested
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token && token !== "model" && token !== "модель");
    const matches = exact
      ? [exact]
      : available.filter(
          (candidate) => tokens.length && tokens.every((token) => candidate.id.toLowerCase().includes(token)),
        );
    if (matches.length !== 1) {
      throw new Error(
        `Model '${requested}' is ${matches.length ? "ambiguous" : "not available"}. Available: ${available.map((model) => model.id).join(", ")}`,
      );
    }
    const selected = matches[0];
    if (!selected) throw new Error("Model selection failed");
    this.config.setOverride("ai.model", selected.id);
    this.model = selected;
    this.agent.state.model = selected;
    log("info", "AI model switched", { provider: selected.provider, model: selected.id });
    return { provider: selected.provider, model: selected.id };
  }

  complete(context: string, onToolCall?: ToolCallListener): Promise<string> {
    return this.enqueue(() =>
      this.completePrompt(`Недавний разговор:\n${context}\n\nОтветь на обращение к Олегу.`, onToolCall),
    );
  }

  completeProactive(context: string, intent: string, onToolCall?: ToolCallListener): Promise<string> {
    return this.enqueue(() =>
      this.completePrompt(
        `Недавний разговор:\n${context}\n\nТы сам решил уместно включиться. Намерение: ${intent}\nОтветь естественно и по делу, максимум двумя короткими предложениями. Не упоминай автоматический режим или это решение.`,
        onToolCall,
      ),
    );
  }

  async decideAutoParticipation(context: string): Promise<AutoParticipationVerdict> {
    const response = await this.models.completeSimple(
      this.model,
      {
        systemPrompt: AUTO_PARTICIPATION_PROMPT,
        messages: [{ role: "user", content: `Недавний разговор:\n${context}`, timestamp: Date.now() }],
        tools: [AUTO_PARTICIPATION_TOOL],
      },
      { reasoning: "low", maxTokens: 512, timeoutMs: 30_000, sessionId: randomUUID() },
    );
    if (response.errorMessage) throw new Error(response.errorMessage);
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error("Auto participation decision failed");
    }
    const call = response.content.find(
      (content) => content.type === "toolCall" && content.name === AUTO_PARTICIPATION_TOOL.name,
    );
    if (call?.type !== "toolCall") throw new Error("LLM did not return an auto participation decision");
    return parseAutoParticipationVerdict(call.arguments, this.modelName);
  }

  completeScheduled(instruction: string): Promise<string> {
    return this.enqueue(() =>
      this.completePrompt(
        `Сработала сохранённая пользовательская задача. Выполни её сейчас, используя инструменты при необходимости. Если это напоминание — естественно напомни об этом. Не создавай новое расписание, если инструкция явно этого не требует.\n\nЗадача: ${instruction}`,
      ),
    );
  }

  private async completePrompt(prompt: string, onToolCall?: ToolCallListener): Promise<string> {
    this.agent.reset();
    this.agent.state.systemPrompt = this.systemPrompt();
    this.onToolCall = onToolCall;
    this.latestAssistantText = "";
    try {
      await this.agent.prompt(prompt);
      const final = this.agent.state.messages.findLast((message) => message.role === "assistant");
      if (final?.role !== "assistant") throw new Error("Pi agent returned no assistant message");
      const text = contentText(final.content).trim();
      if (!text) throw new Error(final.errorMessage || this.agent.state.errorMessage || "LLM returned no final answer");
      return text;
    } finally {
      this.onToolCall = undefined;
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.completionQueue.then(work, work);
    this.completionQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async toolAnnouncement(context: string, tool: string, args: string): Promise<string> {
    const response = await this.models.completeSimple(
      this.model,
      {
        systemPrompt: TOOL_ANNOUNCEMENT_PROMPT,
        messages: [
          {
            role: "user",
            content: `Последняя реплика: ${context.trim().split("\n").at(-1) ?? context}\nДействие: ${tool}\nАргументы: ${args}`,
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: 64, sessionId: randomUUID() },
    );
    const text = contentText(response.content).trim();
    if (!text) throw new Error(response.errorMessage || "LLM returned no tool announcement");
    return text;
  }

  abort(): void {
    this.agent.abort();
  }

  private systemPrompt(): string {
    const catalog = this.skills.catalogPrompt();
    return catalog ? `${SYSTEM_PROMPT}\n\n${catalog}` : SYSTEM_PROMPT;
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.latestAssistantText = contentText(event.message.content).trim();
      return;
    }
    if (event.type === "tool_execution_start") {
      const args = JSON.stringify(event.args);
      this.toolStartedAt.set(event.toolCallId, performance.now());
      log("info", "tool called", { tool: event.toolName, arguments: event.args });
      try {
        this.history.appendTool(event.toolName, event.args);
      } catch (error) {
        log("error", "tool history append failed", { tool: event.toolName, error: errorMessage(error) });
      }
      this.onToolCall?.(event.toolName, args, this.latestAssistantText || undefined);
      return;
    }
    if (event.type === "tool_execution_end") {
      const started = this.toolStartedAt.get(event.toolCallId);
      this.toolStartedAt.delete(event.toolCallId);
      log(event.isError ? "error" : "info", event.isError ? "tool failed" : "tool completed", {
        tool: event.toolName,
        ...(started !== undefined ? { elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s` } : {}),
        ...(event.isError ? { error: contentText(event.result.content) } : {}),
      });
    }
  }
}
