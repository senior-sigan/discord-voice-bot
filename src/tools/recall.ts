import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";

import type { HistorySearch, HistoryStore } from "../agent/history.js";
import { searchHistory } from "../agent/history.js";
import { textResult } from "./types.js";

const parameters = Type.Object(
  {
    query: Type.Optional(Type.String({ description: "Что нужно вспомнить; можно передать неточную фразу" })),
    date: Type.Optional(Type.String({ description: "Локальная дата YYYY-MM-DD, today или yesterday" })),
    speaker: Type.Optional(Type.String({ description: "Имя участника" })),
    kind: Type.Optional(StringEnum(["transcript", "assistant", "tool"] as const, { description: "Тип записи" })),
    tool: Type.Optional(Type.String({ description: "Имя вызванного инструмента" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

export function createRecallHistoryTool(history: HistoryStore): AgentTool<typeof parameters> {
  return {
    name: "recall_history",
    label: "Поиск по истории",
    description:
      "Ищет по всей сохранённой истории разговоров, ответов Олега и вызовов инструментов. Поддерживает неточный поиск и фильтры.",
    parameters,
    async execute(_toolCallId, args) {
      const filters: HistorySearch = {
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.date !== undefined ? { date: args.date } : {}),
        ...(args.speaker !== undefined ? { speaker: args.speaker } : {}),
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.tool !== undefined ? { tool: args.tool } : {}),
        limit: args.limit ?? 10,
      };
      const results = searchHistory(history.entries, filters).map(({ entry, relevance }) => ({
        ...entry,
        relevance: Number(relevance.toFixed(2)),
      }));
      return textResult({ filters, count: results.length, results });
    },
  };
}
