import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { HistoryEntry, HistoryStore } from "../agent/history.ts";
import { isTranscriptHistoryEntry, searchHistory } from "../agent/history.ts";
import type { MemoryEntry, MemoryStore } from "../agent/memory.ts";
import { normalized } from "../agent/memory.ts";
import { textResult } from "./types.ts";

const rememberParameters = Type.Object(
  {
    fact: Type.String({
      minLength: 3,
      maxLength: 500,
      description: "Краткая заметка: только то, что попросили запомнить",
    }),
    source_quote: Type.String({
      minLength: 5,
      maxLength: 1_000,
      description: "Цитата из просьбы запомнить; нужна только для проверки, в память не сохраняется",
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
    label: "Сохранить заметку",
    description:
      "Сохраняет компактную заметку только по явной просьбе пользователя запомнить. Не извлекай факты из обычного разговора. Передай только запрошенную информацию, без вводных слов и дублирования цитаты. source_quote проверяется по истории и не сохраняется.",
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
      if (
        !/(?<![\p{L}\p{N}_])(?:запомни(?:те)?|сохрани(?:те)?\s+(?:это\s+)?в\s+памят[ьи]|учти\s+на\s+будущее)(?![\p{L}\p{N}_])/iu.test(
          source.text,
        ) ||
        /(?<![\p{L}\p{N}_])не\s+(?:надо\s+|нужно\s+)?(?:запомин|запом|сохран)/iu.test(source.text)
      ) {
        throw new Error("the user did not explicitly ask to remember this fact");
      }
      const before = memory.entries.length;
      const entry = memory.remember(fact, source.speaker);
      return textResult({ saved: memory.entries.length > before, entry });
    },
  };
}

export function createSearchMemoryTool(memory: MemoryStore, timezone?: string): AgentTool<typeof searchParameters> {
  return {
    name: "search_memory",
    label: "Поиск в памяти",
    description:
      "Быстро ищет по заметкам, которые пользователи явно просили запомнить. Поддерживает неточные формулировки. Возвращает только заметку, автора и время сохранения. Для полного разговора используй recall_history.",
    parameters: searchParameters,
    async execute(_toolCallId, args) {
      const projections = memory.entries.map((entry) => ({ entry, history: memoryProjection(entry) }));
      const memoryByProjection = new Map(projections.map(({ entry, history }) => [history, entry]));
      const results = searchHistory(
        projections.map(({ history }) => history),
        {
          query: args.query,
          kind: "transcript",
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
    date: entry.timestamp.slice(0, 10),
    time: entry.timestamp.slice(11, 19),
    kind: "transcript",
    speaker: entry.speaker,
    text: entry.fact,
  };
}
