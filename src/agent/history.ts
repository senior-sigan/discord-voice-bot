import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage, formatMessageTime, isRecord, log } from "../common.js";
import { type AutoParticipationDecisionRecord, isAutoParticipationDecisionRecord } from "./auto-participation.js";

export type HistoryKind = "transcript" | "assistant" | "tool" | "auto_participation" | "voice_member_joined";

interface HistoryEntryBase {
  timestamp: string;
  date: string;
  time: string;
}

interface MessageHistoryEntryBase extends HistoryEntryBase {
  speaker: string;
  speaker_id?: string;
  text: string;
}

export interface TranscriptHistoryEntry extends MessageHistoryEntryBase {
  kind: "transcript";
}

export interface AssistantHistoryEntry extends MessageHistoryEntryBase {
  kind: "assistant";
  playback?: "played" | "interrupted" | "failed";
}

export interface VoiceMemberJoinedHistoryEntry extends MessageHistoryEntryBase {
  kind: "voice_member_joined";
  speaker_id: string;
  channel: string;
}

export interface ToolHistoryEntry extends HistoryEntryBase {
  kind: "tool";
  tool: string;
  arguments: unknown;
}

export interface AutoParticipationHistoryEntry extends HistoryEntryBase, AutoParticipationDecisionRecord {
  kind: "auto_participation";
}

export type HistoryEntry =
  | TranscriptHistoryEntry
  | AssistantHistoryEntry
  | VoiceMemberJoinedHistoryEntry
  | ToolHistoryEntry
  | AutoParticipationHistoryEntry;

export function isTranscriptHistoryEntry(entry: HistoryEntry): entry is TranscriptHistoryEntry {
  return entry.kind === "transcript";
}

export interface HistorySearch {
  query?: string;
  date?: string;
  speaker?: string;
  kind?: Exclude<HistoryKind, "auto_participation">;
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
    (value["kind"] !== "transcript" &&
      value["kind"] !== "assistant" &&
      value["kind"] !== "tool" &&
      value["kind"] !== "auto_participation" &&
      value["kind"] !== "voice_member_joined")
  )
    return false;
  if (value["kind"] === "auto_participation") return isAutoParticipationDecisionRecord(value);
  if (value["kind"] === "tool") return typeof value["tool"] === "string";
  if (value["kind"] === "voice_member_joined") {
    return (
      typeof value["speaker_id"] === "string" &&
      typeof value["speaker"] === "string" &&
      typeof value["text"] === "string" &&
      typeof value["channel"] === "string"
    );
  }
  return (
    (value["speaker_id"] === undefined || typeof value["speaker_id"] === "string") &&
    typeof value["speaker"] === "string" &&
    typeof value["text"] === "string" &&
    (value["kind"] !== "assistant" ||
      value["playback"] === undefined ||
      value["playback"] === "played" ||
      value["playback"] === "interrupted" ||
      value["playback"] === "failed")
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
  const previous = new Uint32Array(right.length + 1);
  for (let index = 0; index < previous.length; index++) previous[index] = index;
  let distance = right.length;
  for (let row = 1; row <= left.length; row++) {
    let diagonal = row - 1;
    let leftDistance = row;
    previous[0] = row;
    distance = row;
    for (const [column, above] of previous.entries()) {
      if (column === 0) continue;
      distance = Math.min(above + 1, leftDistance + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      previous[column] = distance;
      leftDistance = distance;
      diagonal = above;
    }
  }
  return 1 - distance / Math.max(left.length, right.length);
}

function historyText(entry: HistoryEntry): string {
  if (entry.kind === "tool") return `${entry.tool} ${JSON.stringify(entry.arguments)}`;
  if (entry.kind === "auto_participation") return "";
  return `${entry.speaker} ${entry.text}`;
}

function localDateOffset(now: Date, days: number, formatter: Intl.DateTimeFormat): string {
  const date = new Date(`${formatter.format(now)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function searchHistory(
  entries: HistoryEntry[],
  filters: HistorySearch,
  now = new Date(),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Array<{ entry: HistoryEntry; relevance: number }> {
  // ponytail: linear scan is enough for one Discord; move to SQLite FTS past ~100k entries.
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const rawQuery = filters.query?.trim() ?? "";
  const queryWords = normalizedWords(rawQuery);
  const inferredDate = /(?<![\p{L}\p{N}_])сегодня(?![\p{L}\p{N}_])/iu.test(rawQuery)
    ? localDateOffset(now, 0, dateFormatter)
    : /(?<![\p{L}\p{N}_])вчера(?![\p{L}\p{N}_])/iu.test(rawQuery)
      ? localDateOffset(now, -1, dateFormatter)
      : undefined;
  const requestedDate =
    filters.date === "today"
      ? localDateOffset(now, 0, dateFormatter)
      : filters.date === "yesterday"
        ? localDateOffset(now, -1, dateFormatter)
        : (filters.date ?? inferredDate);
  const requestedKind =
    filters.kind ??
    (/(?:ты|олег).*(?:говорил|отвечал|рассказывал)|тво[йи]\s+ответ/iu.test(rawQuery) ? "assistant" : undefined);
  const speaker = filters.speaker?.toLocaleLowerCase("ru-RU");
  const tool = filters.tool?.toLocaleLowerCase("en-US");

  return entries
    .flatMap((entry) => {
      if (entry.kind === "auto_participation") return [];
      if (entry.kind === "assistant" && entry.playback && entry.playback !== "played") return [];
      if (requestedDate && dateFormatter.format(new Date(entry.timestamp)) !== requestedDate) return [];
      if (requestedKind && entry.kind !== requestedKind) return [];
      if (speaker && (entry.kind === "tool" || !entry.speaker.toLocaleLowerCase("ru-RU").includes(speaker))) return [];
      if (tool && (entry.kind !== "tool" || !entry.tool.toLocaleLowerCase("en-US").includes(tool))) return [];
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
    const entry = {
      timestamp: at.toISOString(),
      date: formatMessageDate(at),
      time: formatMessageTime(at),
      speaker,
      ...(speakerId ? { speaker_id: speakerId } : {}),
      text,
    };
    this.append(kind === "transcript" ? { ...entry, kind: "transcript" } : { ...entry, kind: "assistant" });
  }

  appendSpeech(text: string, playback: "played" | "interrupted" | "failed"): void {
    const at = new Date();
    this.append({
      kind: "assistant",
      speaker: "Олег",
      text,
      playback,
      timestamp: at.toISOString(),
      date: formatMessageDate(at),
      time: formatMessageTime(at),
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

  appendAutoParticipation(decision: AutoParticipationDecisionRecord, at = new Date()): void {
    this.append({
      timestamp: at.toISOString(),
      date: formatMessageDate(at),
      time: formatMessageTime(at),
      kind: "auto_participation",
      ...decision,
    });
  }

  appendVoiceMemberJoined(speaker: string, speakerId: string, channel: string, at = new Date()): void {
    this.append({
      timestamp: at.toISOString(),
      date: formatMessageDate(at),
      time: formatMessageTime(at),
      kind: "voice_member_joined",
      speaker,
      speaker_id: speakerId,
      channel,
      text: `вошёл в голосовой канал ${channel}`,
    });
  }

  private append(entry: HistoryEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
  }
}
