import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";

import { errorMessage, log } from "../common.js";
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

  constructor(
    private readonly models: Models,
    private readonly model: Model<Api>,
    tools: AgentTool[],
    private readonly history: HistoryStore,
    private readonly skills: SkillStore,
  ) {
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

  complete(context: string, onToolCall?: ToolCallListener): Promise<string> {
    return this.enqueue(() =>
      this.completePrompt(`Недавний разговор:\n${context}\n\nОтветь на обращение к Олегу.`, onToolCall),
    );
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
