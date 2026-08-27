import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage, formatMessageTime, isRecord, log } from "../common.js";

export type MemoryKind = "person" | "topic" | "story" | "moment" | "activity" | "summary";

export interface MemoryEntry {
  id: string;
  timestamp: string;
  date: string;
  time: string;
  fact: string;
  speaker: string;
  evidence: string;
  source_timestamp: string;
  kind?: MemoryKind;
  origin?: "sleep";
  subject_ids?: string[];
  importance?: number;
  evidence_refs?: MemoryEvidence[];
  reflection_day?: string;
  title?: string;
  started_at?: string;
  ended_at?: string;
}

export interface MemoryEvidence {
  source_timestamp: string;
  speaker_id: string;
  speaker: string;
  quote: string;
}

export interface ReflectionMemoryInput {
  kind: MemoryKind;
  fact: string;
  subjects: Array<{ id: string; name: string }>;
  importance: number;
  evidence: MemoryEvidence[];
  day: string;
  title?: string;
  started_at?: string;
  ended_at?: string;
}

export class MemoryStore {
  readonly entries: MemoryEntry[] = [];

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "");
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (!isMemoryEntry(entry)) throw new Error("invalid entry shape");
        this.entries.push(entry);
      } catch (error) {
        log("error", "invalid memory entry skipped", { line: index + 1, error: errorMessage(error) });
      }
    }
    log("info", "memory loaded", { file: path, entries: this.entries.length });
  }

  remember(fact: string, speaker: string, evidence: string, sourceTimestamp: string): MemoryEntry {
    const existing = this.entries.find(
      (entry) => normalized(entry.speaker) === normalized(speaker) && normalized(entry.fact) === normalized(fact),
    );
    if (existing) return existing;
    const now = new Date();
    const entry: MemoryEntry = {
      id: randomUUID(),
      timestamp: now.toISOString(),
      date: localDate(now),
      time: formatMessageTime(now),
      fact: fact.trim(),
      speaker,
      evidence: evidence.trim(),
      source_timestamp: sourceTimestamp,
    };
    this.append(entry);
    return entry;
  }

  rememberReflection(input: ReflectionMemoryInput): MemoryEntry {
    const fact = input.fact.trim();
    const primary = input.evidence[0];
    if (!fact || !input.subjects.length || !primary || ![3, 4, 5].includes(input.importance)) {
      throw new Error("invalid reflection memory");
    }
    const subjects = [...input.subjects].sort((left, right) => left.id.localeCompare(right.id));
    const subjectKey = subjects.map((subject) => subject.id).join("\n");
    const speaker = subjects.map((subject) => subject.name).join(", ");
    const existing = this.entries.find(
      (entry) =>
        normalized(entry.fact) === normalized(fact) &&
        entry.kind === input.kind &&
        (input.kind !== "activity" || (entry.started_at === input.started_at && entry.ended_at === input.ended_at)) &&
        (input.kind !== "summary" || entry.reflection_day === input.day) &&
        (entry.subject_ids
          ? [...entry.subject_ids].sort().join("\n") === subjectKey
          : normalized(entry.speaker) === normalized(speaker)),
    );
    if (existing) return existing;
    const now = new Date();
    const entry: MemoryEntry = {
      id: randomUUID(),
      timestamp: now.toISOString(),
      date: localDate(now),
      time: formatMessageTime(now),
      fact,
      speaker,
      evidence: primary.quote,
      source_timestamp: primary.source_timestamp,
      kind: input.kind,
      origin: "sleep",
      subject_ids: subjects.map((subject) => subject.id),
      importance: input.importance,
      evidence_refs: input.evidence,
      reflection_day: input.day,
      ...(input.title ? { title: input.title } : {}),
      ...(input.started_at ? { started_at: input.started_at } : {}),
      ...(input.ended_at ? { ended_at: input.ended_at } : {}),
    };
    this.append(entry);
    return entry;
  }

  private append(entry: MemoryEntry): void {
    // ponytail: append-only is sufficient for one bot process; add a file lock before multi-process writers.
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
  }
}

export function normalized(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["timestamp"] === "string" &&
    typeof value["date"] === "string" &&
    typeof value["time"] === "string" &&
    typeof value["fact"] === "string" &&
    typeof value["speaker"] === "string" &&
    typeof value["evidence"] === "string" &&
    typeof value["source_timestamp"] === "string" &&
    (value["kind"] === undefined ||
      value["kind"] === "person" ||
      value["kind"] === "topic" ||
      value["kind"] === "story" ||
      value["kind"] === "moment" ||
      value["kind"] === "activity" ||
      value["kind"] === "summary") &&
    (value["origin"] === undefined || value["origin"] === "sleep") &&
    (value["subject_ids"] === undefined ||
      (Array.isArray(value["subject_ids"]) && value["subject_ids"].every((item) => typeof item === "string"))) &&
    (value["importance"] === undefined || typeof value["importance"] === "number") &&
    (value["evidence_refs"] === undefined ||
      (Array.isArray(value["evidence_refs"]) && value["evidence_refs"].every(isMemoryEvidence))) &&
    (value["reflection_day"] === undefined || typeof value["reflection_day"] === "string") &&
    (value["title"] === undefined || typeof value["title"] === "string") &&
    (value["started_at"] === undefined || typeof value["started_at"] === "string") &&
    (value["ended_at"] === undefined || typeof value["ended_at"] === "string")
  );
}

function isMemoryEvidence(value: unknown): value is MemoryEvidence {
  return (
    isRecord(value) &&
    typeof value["source_timestamp"] === "string" &&
    typeof value["speaker_id"] === "string" &&
    typeof value["speaker"] === "string" &&
    typeof value["quote"] === "string"
  );
}

function localDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}
