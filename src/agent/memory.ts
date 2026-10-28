import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage, isRecord, log } from "../common.ts";

export interface MemoryEntry {
  fact: string;
  speaker: string;
  timestamp: string;
}

export class MemoryStore {
  readonly entries: MemoryEntry[] = [];

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "");
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        // Old automatic reflections must never become explicit user notes.
        if (isRecord(value) && value["origin"] === "sleep") continue;
        if (!isMemoryEntry(value)) throw new Error("invalid entry shape");
        this.entries.push({ fact: value.fact, speaker: value.speaker, timestamp: value.timestamp });
      } catch (error) {
        log("error", "invalid memory entry skipped", { line: index + 1, error: errorMessage(error) });
      }
    }
    log("info", "memory loaded", { file: path, entries: this.entries.length });
  }

  remember(fact: string, speaker: string): MemoryEntry {
    if (!fact.trim() || fact.trim().length > 500 || !speaker.trim()) throw new Error("invalid memory note");
    const existing = this.entries.find(
      (entry) => normalized(entry.speaker) === normalized(speaker) && normalized(entry.fact) === normalized(fact),
    );
    if (existing) return existing;
    const entry: MemoryEntry = { fact: fact.trim(), speaker: speaker.trim(), timestamp: new Date().toISOString() };
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
    (value["origin"] === undefined || value["origin"] === "user") &&
    typeof value["fact"] === "string" &&
    value["fact"].trim().length > 0 &&
    typeof value["speaker"] === "string" &&
    value["speaker"].trim().length > 0 &&
    typeof value["timestamp"] === "string" &&
    Number.isFinite(Date.parse(value["timestamp"]))
  );
}
