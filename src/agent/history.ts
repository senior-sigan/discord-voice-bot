import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage, formatMessageTime, isRecord, log } from "../common.js";

export type HistoryKind = "transcript" | "assistant" | "tool";

export interface HistoryEntry {
  timestamp: string;
  date: string;
  time: string;
  kind: HistoryKind;
  speaker?: string;
  speaker_id?: string;
  text?: string;
  tool?: string;
  arguments?: unknown;
}

export interface HistorySearch {
  query?: string;
  date?: string;
  speaker?: string;
  kind?: HistoryKind;
  tool?: string;
  limit?: number;
}

function formatMessageDate(date = new Date()): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (
    !isRecord(value) ||
    typeof value["timestamp"] !== "string" ||
    typeof value["date"] !== "string" ||
    typeof value["time"] !== "string" ||
    (value["kind"] !== "transcript" && value["kind"] !== "assistant" && value["kind"] !== "tool")
  )
    return false;
  return (
    (value["speaker_id"] === undefined || typeof value["speaker_id"] === "string") &&
    (value["kind"] === "tool"
      ? typeof value["tool"] === "string"
      : typeof value["speaker"] === "string" && typeof value["text"] === "string")
  );
}

function normalizedWords(value: string): string[] {
  const ignored = new Set([
    "олег",
    "помнишь",
    "вспомни",
    "вспомнить",
    "сегодня",
    "вчера",
    "говорил",
    "говорили",
    "отвечал",
    "рассказывал",
    "обсуждали",
    "пожалуйста",
    "когда",
    "который",
    "какой",
    "какая",
    "про",
    "что",
    "это",
    "нам",
    "мне",
    "тебе",
    "твой",
    "твои",
    "свой",
  ]);
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !ignored.has(word));
}

function wordSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column]!;
      previous[column] = Math.min(
        above + 1,
        previous[column - 1]! + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length);
}

function historyText(entry: HistoryEntry): string {
  return entry.kind === "tool"
    ? `${entry.tool ?? ""} ${JSON.stringify(entry.arguments ?? {})}`
    : `${entry.speaker ?? ""} ${entry.text ?? ""}`;
}

function localDateOffset(now: Date, days: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  return formatMessageDate(date);
}

export function searchHistory(
  entries: HistoryEntry[],
  filters: HistorySearch,
  now = new Date(),
): Array<{ entry: HistoryEntry; relevance: number }> {
  // ponytail: linear scan is enough for one Discord; move to SQLite FTS past ~100k entries.
  const rawQuery = filters.query?.trim() ?? "";
  const queryWords = normalizedWords(rawQuery);
  const inferredDate = /\bсегодня\b/iu.test(rawQuery)
    ? localDateOffset(now, 0)
    : /\bвчера\b/iu.test(rawQuery)
      ? localDateOffset(now, -1)
      : undefined;
  const requestedDate =
    filters.date === "today"
      ? localDateOffset(now, 0)
      : filters.date === "yesterday"
        ? localDateOffset(now, -1)
        : (filters.date ?? inferredDate);
  const requestedKind =
    filters.kind ??
    (/(?:ты|олег).*(?:говорил|отвечал|рассказывал)|тво[йи]\s+ответ/iu.test(rawQuery) ? "assistant" : undefined);
  const speaker = filters.speaker?.toLocaleLowerCase("ru-RU");
  const tool = filters.tool?.toLocaleLowerCase("en-US");

  return entries
    .flatMap((entry) => {
      if (requestedDate && entry.date !== requestedDate) return [];
      if (requestedKind && entry.kind !== requestedKind) return [];
      if (speaker && !entry.speaker?.toLocaleLowerCase("ru-RU").includes(speaker)) return [];
      if (tool && !entry.tool?.toLocaleLowerCase("en-US").includes(tool)) return [];
      if (!queryWords.length) return [{ entry, relevance: 1 }];
      const words = normalizedWords(historyText(entry));
      if (!words.length) return [];
      const relevance =
        queryWords.reduce(
          (sum, queryWord) => sum + Math.max(...words.map((word) => wordSimilarity(queryWord, word))),
          0,
        ) / queryWords.length;
      return relevance >= 0.45 ? [{ entry, relevance }] : [];
    })
    .sort(
      (left, right) => right.relevance - left.relevance || right.entry.timestamp.localeCompare(left.entry.timestamp),
    )
    .slice(0, Math.max(1, Math.min(20, filters.limit ?? 10)));
}

export class HistoryStore {
  readonly entries: HistoryEntry[] = [];

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "");
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (!isHistoryEntry(entry)) throw new Error("invalid entry shape");
        this.entries.push(entry);
      } catch (error) {
        log("error", "invalid history entry skipped", { line: index + 1, error: errorMessage(error) });
      }
    }
    log("info", "history loaded", { file: path, entries: this.entries.length });
  }

  appendMessage(
    kind: "transcript" | "assistant",
    speaker: string,
    text: string,
    at = new Date(),
    speakerId?: string,
  ): void {
    this.append({
      timestamp: at.toISOString(),
      date: formatMessageDate(at),
      time: formatMessageTime(at),
      kind,
      speaker,
      ...(speakerId ? { speaker_id: speakerId } : {}),
      text,
    });
  }

  appendTool(tool: string, args: unknown, at = new Date()): void {
    this.append({
      timestamp: at.toISOString(),
      date: formatMessageDate(at),
      time: formatMessageTime(at),
      kind: "tool",
      tool,
      arguments: args,
    });
  }

  private append(entry: HistoryEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
  }
}
