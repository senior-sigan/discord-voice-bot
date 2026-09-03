import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage, isRecord, log } from "../common.js";
import type { MemoryEvidence } from "./memory.js";

export const PROFILE_SECTIONS = [
  "games",
  "work_projects",
  "life_stories",
  "current_challenges",
  "interests",
  "media",
  "plans",
] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];
export type ProfileStatus = "current" | "recurring" | "past" | "uncertain";

export interface ProfileClaim {
  summary: string;
  status: ProfileStatus;
  last_seen_at: string;
  evidence: MemoryEvidence[];
}

export type ProfileSections = Record<ProfileSection, ProfileClaim[]>;

export interface PersonProfile {
  user_id: string;
  name: string;
  updated_at: string;
  source_from: string;
  source_to: string;
  sections: ProfileSections;
}

export class ProfileStore {
  readonly profiles: PersonProfile[] = [];

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "[]\n");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value)) throw new Error(`Invalid profiles file: ${path}`);
    for (const [index, profile] of value.entries()) {
      try {
        if (!isPersonProfile(profile)) throw new Error("invalid profile shape");
        this.profiles.push(profile);
      } catch (error) {
        log("error", "invalid profile skipped", { index: index + 1, error: errorMessage(error) });
      }
    }
    log("info", "profiles loaded", { file: path, entries: this.profiles.length });
  }

  upsert(profile: PersonProfile): void {
    if (!isPersonProfile(profile)) throw new Error("invalid profile");
    const index = this.profiles.findIndex((candidate) => candidate.user_id === profile.user_id);
    if (index < 0) this.profiles.push(profile);
    else this.profiles[index] = profile;
    this.save();
  }

  find(query: string): PersonProfile[] {
    const needle = query.toLocaleLowerCase("ru-RU").trim();
    if (!needle) return [];
    return this.profiles.filter(
      (profile) => profile.user_id === needle || profile.name.toLocaleLowerCase("ru-RU").includes(needle),
    );
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.profiles, null, 2)}\n`);
    renameSync(temporary, this.path);
  }
}

export function emptyProfileSections(): ProfileSections {
  return {
    games: [],
    work_projects: [],
    life_stories: [],
    current_challenges: [],
    interests: [],
    media: [],
    plans: [],
  };
}

function isPersonProfile(value: unknown): value is PersonProfile {
  const sections = isRecord(value) ? value["sections"] : undefined;
  if (
    !isRecord(value) ||
    typeof value["user_id"] !== "string" ||
    typeof value["name"] !== "string" ||
    typeof value["updated_at"] !== "string" ||
    typeof value["source_from"] !== "string" ||
    typeof value["source_to"] !== "string" ||
    !isRecord(sections)
  ) {
    return false;
  }
  return PROFILE_SECTIONS.every(
    (section) => Array.isArray(sections[section]) && sections[section].every(isProfileClaim),
  );
}

function isProfileClaim(value: unknown): value is ProfileClaim {
  return (
    isRecord(value) &&
    typeof value["summary"] === "string" &&
    (value["status"] === "current" ||
      value["status"] === "recurring" ||
      value["status"] === "past" ||
      value["status"] === "uncertain") &&
    typeof value["last_seen_at"] === "string" &&
    Array.isArray(value["evidence"]) &&
    value["evidence"].length > 0 &&
    value["evidence"].every(isMemoryEvidence)
  );
}

function isMemoryEvidence(value: unknown): value is MemoryEvidence {
  return (
    isRecord(value) &&
    typeof value["source_timestamp"] === "string" &&
    typeof value["speaker_id"] === "string" &&
    typeof value["speaker"] === "string" &&
    typeof value["quote"] === "string" &&
    (value["quoteReworded"] === undefined || typeof value["quoteReworded"] === "boolean")
  );
}
