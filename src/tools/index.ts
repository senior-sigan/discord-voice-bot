import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { HistoryStore } from "../agent/history.js";
import type { MemoryStore } from "../agent/memory.js";
import type { SkillStore } from "../agent/skills.js";
import { currentDateTimeTool } from "./datetime.js";
import { createMemeSearchTool } from "./memes.js";
import { createRememberTool, createSearchMemoryTool } from "./memory.js";
import { createRecallHistoryTool } from "./recall.js";
import { createSkillTools } from "./skills.js";
import { webFetchTool, webSearchTool } from "./web.js";

export { isSafePublicUrl } from "./web.js";

export function createTools(history: HistoryStore, memory: MemoryStore, skills: SkillStore): AgentTool[] {
  return [
    currentDateTimeTool,
    webSearchTool,
    webFetchTool,
    createRecallHistoryTool(history),
    createRememberTool(memory, history),
    createSearchMemoryTool(memory),
    createMemeSearchTool(),
    ...createSkillTools(skills),
  ];
}
