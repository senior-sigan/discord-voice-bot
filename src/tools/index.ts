import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { HistoryStore } from "../agent/history.js";
import type { MemoryStore } from "../agent/memory.js";
import type { ProfileStore } from "../agent/profiles.js";
import type { SkillStore } from "../agent/skills.js";
import type { TaskScheduler } from "../scheduler.js";
import { currentDateTimeTool } from "./datetime.js";
import { createDiscordTools, type DiscordToolsClient } from "./discord.js";
import { createMemeSearchTool } from "./memes.js";
import { createRememberTool, createSearchMemoryTool } from "./memory.js";
import { createGetProfileTool } from "./profiles.js";
import { createRecallHistoryTool } from "./recall.js";
import { createSkillTools } from "./skills.js";
import { createTaskTools } from "./tasks.js";
import { webFetchTool, webSearchTool } from "./web.js";

export { isSafePublicUrl } from "./web.js";

export function createTools(
  history: HistoryStore,
  memory: MemoryStore,
  profiles: ProfileStore,
  skills: SkillStore,
  discord: DiscordToolsClient,
  scheduler: TaskScheduler,
  timezone: string,
): AgentTool[] {
  return [
    currentDateTimeTool,
    webSearchTool,
    webFetchTool,
    createRecallHistoryTool(history),
    createRememberTool(memory, history),
    createSearchMemoryTool(memory),
    createGetProfileTool(profiles),
    createMemeSearchTool(),
    ...createTaskTools(scheduler, timezone),
    ...createDiscordTools(discord),
    ...createSkillTools(skills),
  ];
}
