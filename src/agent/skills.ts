import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { log } from "../common.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export class SkillStore {
  private readonly env: NodeExecutionEnv;
  private skills: Skill[] = [];
  readonly directory: string;

  constructor(directory = "skills") {
    this.directory = resolve(directory);
    this.env = new NodeExecutionEnv({ cwd: process.cwd() });
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const { skills, diagnostics } = await loadSkills(this.env, this.directory);
    this.skills = skills.sort((left, right) => left.name.localeCompare(right.name));
    for (const diagnostic of diagnostics) {
      log("error", "skill ignored", { path: diagnostic.path, error: diagnostic.message });
    }
    log("info", "skills loaded", { directory: this.directory, count: this.skills.length });
  }

  catalogPrompt(): string {
    if (!this.skills.length) return "";
    return (
      "Перед ответом просмотри каталог скиллов. Если задача совпадает с описанием, сначала вызови skill_view с его именем и следуй загруженной процедуре.\n\n" +
      formatSkillsForSystemPrompt(this.skills)
    );
  }

  view(name: string): { skill: Skill; prompt: string } {
    const skill = this.skills.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return { skill, prompt: formatSkillInvocation(skill) };
  }

  async create(name: string, description: string, instructions: string): Promise<Skill> {
    const skillName = name.trim();
    const skillDescription = description.trim();
    const skillInstructions = instructions.trim();
    if (!SKILL_NAME.test(skillName) || skillName.length > 64) {
      throw new Error("Skill name must use lowercase letters, numbers and single hyphens, up to 64 characters");
    }
    if (!skillDescription || skillDescription.length > 1_024) {
      throw new Error("Skill description must be 1-1024 characters");
    }
    if (!skillInstructions || skillInstructions.length > 12_000) {
      throw new Error("Skill instructions must be 1-12000 characters");
    }

    const directory = join(this.directory, skillName);
    await mkdir(directory);
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${JSON.stringify(skillName)}\ndescription: ${JSON.stringify(skillDescription)}\n---\n\n${skillInstructions}\n`,
      { flag: "wx" },
    );
    await this.load();
    return this.view(skillName).skill;
  }
}
