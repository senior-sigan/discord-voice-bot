import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage, formatMessageTime, isRecord, log } from "../common.js";

export interface MemoryEntry {
  id: string;
  timestamp: string;
  date: string;
  time: string;
  fact: string;
  speaker: string;
  evidence: string;
  source_timestamp: string;
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
    // ponytail: append-only is sufficient for one bot process; add a file lock before multi-process writers.
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
    return entry;
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
    typeof value["source_timestamp"] === "string"
  );
}

function localDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}
