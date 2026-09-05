import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";

import type { HistoryStore } from "../agent/history.js";
import type { MemoryStore } from "../agent/memory.js";
import type { ProfileStore } from "../agent/profiles.js";
import type { SkillStore } from "../agent/skills.js";
import type { AppConfig, MutableConfigKey } from "../config.js";
import type { TaskScheduler } from "../scheduler.js";
import { currentDateTimeTool } from "./datetime.js";
import { createDiscordTools, type DiscordToolsClient } from "./discord.js";
import { createMemeSearchTool } from "./memes.js";
import { createRememberTool, createSearchMemoryTool } from "./memory.js";
import { createGetProfileTool } from "./profiles.js";
import { createRecallHistoryTool } from "./recall.js";
import { keepSilenceTool } from "./silence.js";
import { createSkillTools } from "./skills.js";
import { createTaskTools } from "./tasks.js";
import { textResult } from "./types.js";
import { webFetchTool, webSearchTool } from "./web.js";

export { isSafePublicUrl } from "./web.js";

export function createTools(
  history: HistoryStore,
  memory: MemoryStore,
  profiles: ProfileStore,
  skills: SkillStore,
  discord: DiscordToolsClient,
  scheduler: TaskScheduler,
  config: AppConfig,
  switchModel: (model: string) => { provider: string; model: string },
): AgentTool[] {
  return [
    currentDateTimeTool,
    webSearchTool,
    webFetchTool,
    createRecallHistoryTool(history, config.settings.agent.timezone),
    createRememberTool(memory, history),
    createSearchMemoryTool(memory, config.settings.agent.timezone),
    createGetProfileTool(profiles),
    keepSilenceTool,
    createMemeSearchTool(),
    ...createTaskTools(scheduler, config.settings.agent.timezone),
    ...createDiscordTools(discord),
    ...createSkillTools(skills),
    createRuntimeConfigTool(config, switchModel),
  ];
}

const runtimeConfigParameters = Type.Object(
  {
    setting: StringEnum(["ai.model", "tts.qwen.voice", "agent.auto_participation.mode"] as const),
    value: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

function createRuntimeConfigTool(
  config: AppConfig,
  switchModel: (model: string) => { provider: string; model: string },
): AgentTool<typeof runtimeConfigParameters> {
  return {
    name: "set_runtime_config",
    label: "Изменить настройку Олега",
    description: `Сохраняет runtime override. Используй по просьбе сменить текущую AI-модель, голос Qwen TTS или режим автоматического участия (off, shadow, on). Доступные голоса Qwen: ${config.settings.tts.qwen.voices.join(", ")}.`,
    parameters: runtimeConfigParameters,
    async execute(_toolCallId, args) {
      const setting: MutableConfigKey = args.setting;
      if (setting === "ai.model") return textResult({ setting, ...switchModel(args.value) });
      const settings = config.setOverride(setting, args.value);
      const value = setting === "tts.qwen.voice" ? settings.tts.qwen.voice : settings.agent.auto_participation.mode;
      return textResult({ setting, value });
    },
  };
}
