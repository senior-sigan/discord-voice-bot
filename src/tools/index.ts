import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";

import type { HistoryStore } from "../agent/history.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { ProfileStore } from "../agent/profiles.ts";
import type { SkillStore } from "../agent/skills.ts";
import type { AppConfig, MutableConfigKey } from "../config.ts";
import type { TaskScheduler } from "../scheduler.ts";
import { currentDateTimeTool } from "./datetime.ts";
import { createDiscordTools, type DiscordToolsClient } from "./discord.ts";
import { createMemeSearchTool } from "./memes.ts";
import { createRememberTool, createSearchMemoryTool } from "./memory.ts";
import { createGetProfileTool } from "./profiles.ts";
import { createRecallHistoryTool } from "./recall.ts";
import { keepSilenceTool } from "./silence.ts";
import { createSkillTools } from "./skills.ts";
import { createTaskTools } from "./tasks.ts";
import { textResult } from "./types.ts";
import { webFetchTool, webSearchTool } from "./web.ts";

export { isSafePublicUrl } from "./web.ts";

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
    setting: StringEnum(["ai.model", "tts.qwen.voice", "tts.silero.voice", "agent.auto_participation.mode"] as const),
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
    description: `Сохраняет runtime override. Используй по просьбе сменить текущую AI-модель, голос Qwen/Silero TTS или режим автоматического участия (off, shadow, on). Доступные голоса Qwen: ${config.settings.tts.qwen.voices.join(", ")}. Доступные голоса Silero: ${config.settings.tts.silero.voices.join(", ")}.`,
    parameters: runtimeConfigParameters,
    async execute(_toolCallId, args) {
      const setting: MutableConfigKey = args.setting;
      if (setting === "ai.model") return textResult({ setting, ...switchModel(args.value) });
      const settings = config.setOverride(setting, args.value);
      const value =
        setting === "tts.qwen.voice"
          ? settings.tts.qwen.voice
          : setting === "tts.silero.voice"
            ? settings.tts.silero.voice
            : settings.agent.auto_participation.mode;
      return textResult({ setting, value });
    },
  };
}
