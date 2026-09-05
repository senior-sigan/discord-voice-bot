import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { HistoryEntry, HistoryStore } from "../agent/history.js";
import { isTranscriptHistoryEntry, searchHistory } from "../agent/history.js";
import type { MemoryEntry, MemoryStore } from "../agent/memory.js";
import { normalized } from "../agent/memory.js";
import { textResult } from "./types.js";

const rememberParameters = Type.Object(
  {
    fact: Type.String({ minLength: 3, maxLength: 500, description: "Краткий устойчивый факт или предпочтение" }),
    source_quote: Type.String({
      minLength: 5,
      maxLength: 1_000,
      description: "Дословная цитата из пользовательской реплики, подтверждающая факт",
    }),
    speaker: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Имя участника" })),
  },
  { additionalProperties: false },
);

const searchParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, description: "Что нужно найти в сохранённой памяти" }),
    speaker: Type.Optional(Type.String({ description: "Имя участника" })),
    date: Type.Optional(Type.String({ description: "Дата сохранения YYYY-MM-DD, today или yesterday" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

export function createRememberTool(memory: MemoryStore, history: HistoryStore): AgentTool<typeof rememberParameters> {
  return {
    name: "remember",
    label: "Запомнить факт",
    description:
      "Сохраняет устойчивый факт, предпочтение или договорённость только когда пользователь явно просит запомнить. source_quote должна быть дословной цитатой пользовательской реплики.",
    parameters: rememberParameters,
    async execute(_toolCallId, args) {
      const fact = args.fact.trim();
      const evidence = args.source_quote.trim();
      if (!fact || !evidence) throw new Error("fact and source_quote must not be blank");
      const quote = normalized(evidence);
      const requestedSpeaker = args.speaker ? normalized(args.speaker) : undefined;
      if (args.speaker !== undefined && !requestedSpeaker) throw new Error("speaker must not be blank");
      const source = history.entries
        .filter(isTranscriptHistoryEntry)
        .findLast(
          (entry) =>
            (!requestedSpeaker || normalized(entry.speaker) === requestedSpeaker) &&
            normalized(entry.text).includes(quote),
        );
      if (!source) throw new Error("source_quote was not found in a user transcript");
      if (!/(?:запомни|запомнить|помни|учти\s+на\s+будущее)/iu.test(source.text)) {
        throw new Error("the user did not explicitly ask to remember this fact");
      }
      const before = memory.entries.length;
      const entry = memory.remember(fact, source.speaker, evidence, source.timestamp);
      return textResult({ saved: memory.entries.length > before, entry });
    },
  };
}

export function createSearchMemoryTool(memory: MemoryStore, timezone?: string): AgentTool<typeof searchParameters> {
  return {
    name: "search_memory",
    label: "Поиск в памяти",
    description:
      "Ищет fuzzy-поиском намеренно сохранённые факты, предпочтения и договорённости. Это не поиск по полному журналу разговора.",
    parameters: searchParameters,
    async execute(_toolCallId, args) {
      const projections = memory.entries.map((entry) => ({ entry, history: memoryProjection(entry) }));
      const memoryByProjection = new Map(projections.map(({ entry, history }) => [history, entry]));
      const results = searchHistory(
        projections.map(({ history }) => history),
        {
          query: args.query,
          ...(args.speaker ? { speaker: args.speaker } : {}),
          ...(args.date ? { date: args.date } : {}),
          limit: args.limit ?? 5,
        },
        new Date(),
        timezone,
      ).flatMap(({ entry }) => {
        const memoryEntry = memoryByProjection.get(entry);
        return memoryEntry ? [memoryEntry] : [];
      });
      return textResult({ query: args.query, count: results.length, results });
    },
  };
}

function memoryProjection(entry: MemoryEntry): HistoryEntry {
  return {
    timestamp: entry.timestamp,
    date: entry.date,
    time: entry.time,
    kind: "transcript",
    speaker: entry.speaker,
    text: `${entry.title ?? ""} ${entry.fact} ${entry.evidence}`,
  };
}
