import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { SkillStore } from "../agent/skills.js";
import { textResult } from "./types.js";

const viewParameters = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 64, description: "Имя скилла из доступного каталога" }) },
  { additionalProperties: false },
);

const createParameters = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      description: "Короткое имя в kebab-case",
    }),
    description: Type.String({
      minLength: 1,
      maxLength: 1_024,
      description: "Когда применять скилл; достаточно для выбора по каталогу",
    }),
    instructions: Type.String({
      minLength: 1,
      maxLength: 12_000,
      description: "Самодостаточная повторяемая процедура в Markdown",
    }),
  },
  { additionalProperties: false },
);

export function createSkillTools(store: SkillStore): AgentTool[] {
  const view: AgentTool<typeof viewParameters> = {
    name: "skill_view",
    label: "Загрузить скилл",
    description: "Загружает полные инструкции выбранного скилла. Вызывай, когда задача совпадает с его описанием.",
    parameters: viewParameters,
    async execute(_toolCallId, args) {
      const { skill, prompt } = store.view(args.name);
      return { content: [{ type: "text", text: prompt }], details: { name: skill.name, path: skill.filePath } };
    },
  };

  const create: AgentTool<typeof createParameters> = {
    name: "skill_create",
    label: "Создать скилл",
    description:
      "Создаёт новый skills/<name>/SKILL.md. Используй по просьбе пользователя или для действительно повторяемой многошаговой процедуры; не используй для фактов, разовых задач и текущего прогресса.",
    parameters: createParameters,
    async execute(_toolCallId, args) {
      const skill = await store.create(args.name.trim(), args.description.trim(), args.instructions.trim());
      return textResult({ created: true, name: skill.name, description: skill.description, path: skill.filePath });
    },
  };

  return [view, create];
}
