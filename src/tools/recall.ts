import type { HistorySearch, HistoryStore } from "../agent/history.js";
import { searchHistory } from "../agent/history.js";
import type { AgentTool } from "./types.js";
import { limitedInteger } from "./types.js";

export function createRecallHistoryTool(history?: HistoryStore): AgentTool {
  return {
    name: "recall_history",
    description:
      "Ищет по всей сохранённой истории разговоров, ответов Олега и вызовов инструментов. Поддерживает неточный поиск и фильтры.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Что нужно вспомнить; можно передать неточную фразу" },
        date: { type: "string", description: "Локальная дата YYYY-MM-DD, today или yesterday" },
        speaker: { type: "string", description: "Имя участника" },
        kind: { type: "string", enum: ["transcript", "assistant", "tool"], description: "Тип записи" },
        tool: { type: "string", description: "Имя вызванного инструмента" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    async execute(args) {
      if (!history) throw new Error("Conversation history is not configured");
      const kind = args["kind"];
      if (kind !== undefined && kind !== "transcript" && kind !== "assistant" && kind !== "tool") {
        throw new Error("History kind must be transcript, assistant, or tool");
      }
      const filters: HistorySearch = {
        ...(typeof args["query"] === "string" ? { query: args["query"] } : {}),
        ...(typeof args["date"] === "string" ? { date: args["date"] } : {}),
        ...(typeof args["speaker"] === "string" ? { speaker: args["speaker"] } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(typeof args["tool"] === "string" ? { tool: args["tool"] } : {}),
        limit: limitedInteger(args["limit"], 10, 1, 20),
      };
      const results = searchHistory(history.entries, filters).map(({ entry, relevance }) => ({
        ...entry,
        relevance: Number(relevance.toFixed(2)),
      }));
      return { filters, count: results.length, results };
    },
  };
}
