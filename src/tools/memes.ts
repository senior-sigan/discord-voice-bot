import { readFileSync } from "node:fs";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { HistoryEntry } from "../agent/history.js";
import { searchHistory } from "../agent/history.js";
import { formatMessageTime, isRecord } from "../common.js";
import { dataPath } from "../config.js";

const parameters = Type.Object(
  {
    query: Type.String({ minLength: 1, description: "Описание нужного мема обычными словами" }),
    date: Type.Optional(
      Type.String({ description: "YYYY, YYYY-MM, YYYY-MM-DD, today, yesterday, this_year или last_year" }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  },
  { additionalProperties: false },
);

interface IndexedMeme {
  entry: HistoryEntry;
  raw: string;
}

export function createMemeSearchTool(path = dataPath("memes", "images_explained.jsonl")): AgentTool<typeof parameters> {
  let memes: IndexedMeme[] | undefined;
  return {
    name: "search_memes",
    label: "Поиск мемов",
    description:
      "Ищет мемы fuzzy-поиском только по их описаниям. Можно ограничить поиск датой или годом. Возвращает до пяти исходных JSONL-строк.",
    parameters,
    async execute(_toolCallId, args) {
      memes ??= loadMemes(path);
      const date = resolveDate(args.date, args.query);
      const candidates = date ? memes.filter((meme) => meme.entry.date.startsWith(date)) : memes;
      const rawByEntry = new Map(candidates.map((meme) => [meme.entry, meme.raw]));
      const ranked = searchHistory(
        candidates.map((meme) => meme.entry),
        { query: cleanQuery(args.query), limit: 20 },
      );
      const minimumRelevance = Math.max(0.45, (ranked[0]?.relevance ?? 1) - 0.1);
      const results = ranked
        .filter(({ relevance }) => relevance >= minimumRelevance)
        .slice(0, Math.min(args.limit ?? 5, 5))
        .flatMap(({ entry }) => {
          const raw = rawByEntry.get(entry);
          return raw === undefined ? [] : [raw];
        });
      return {
        content: [{ type: "text", text: results.join("\n") || "Подходящих мемов не найдено." }],
        details: { query: args.query, ...(date ? { date } : {}), count: results.length, results },
      };
    },
  };
}

function loadMemes(path: string): IndexedMeme[] {
  const memes = readFileSync(path, "utf8")
    .split("\n")
    .flatMap((raw) => {
      if (!raw.trim()) return [];
      try {
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value) || typeof value["timestamp"] !== "string" || typeof value["description"] !== "string") {
          return [];
        }
        const timestamp = new Date(value["timestamp"]);
        if (Number.isNaN(timestamp.getTime())) return [];
        return [
          {
            raw,
            entry: {
              timestamp: value["timestamp"],
              date: localDate(timestamp),
              time: formatMessageTime(timestamp),
              kind: "transcript" as const,
              speaker: "",
              text: value["description"],
            },
          },
        ];
      } catch {
        return [];
      }
    });
  if (!memes.length) throw new Error(`No explained memes found in ${path}`);
  return memes;
}

function resolveDate(value: string | undefined, query: string, now = new Date()): string | undefined {
  const requested = value?.trim().toLocaleLowerCase("ru-RU");
  const source = requested || query.toLocaleLowerCase("ru-RU");
  if (requested && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(requested)) return requested;
  if (/(?:last_year|прошл(?:ый|ом)\s+год(?:у)?)/iu.test(source)) return String(now.getFullYear() - 1);
  if (/(?:this_year|эт(?:от|ом)\s+год(?:у)?)/iu.test(source)) return String(now.getFullYear());
  if (/(?:today|сегодня)/iu.test(source)) return localDate(now);
  if (/(?:yesterday|вчера)/iu.test(source)) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return localDate(yesterday);
  }
  if (requested) throw new Error(`Unsupported meme date: ${value}`);
  return undefined;
}

function cleanQuery(query: string): string {
  return query
    .replace(/(?:last_year|this_year|today|yesterday|сегодня|вчера)/giu, " ")
    .replace(/(?:в\s+)?(?:прошл(?:ом|ый)|эт(?:ом|от))\s+году?/giu, " ")
    .replace(/(?:найди|покажи|мем(?:а|ов|чик)?|картинк(?:а|у|и))/giu, " ")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .map((word) => (word.length > 5 ? word.replace(/(?:ами|ями|ого|ему|ому|ыми|ими|ой|ей|ом|ем|ах|ях)$/u, "") : word))
    .join(" ");
}

function localDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}
