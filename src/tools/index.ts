import type { HistoryStore } from "../agent/history.js";
import { currentDateTimeTool } from "./datetime.js";
import { createRecallHistoryTool } from "./recall.js";
import type { AgentTool } from "./types.js";
import { parseToolArguments } from "./types.js";
import { webFetchTool, webSearchTool } from "./web.js";

export type { AgentTool } from "./types.js";
export { isSafePublicUrl } from "./web.js";

export function createTools(history?: HistoryStore): AgentTool[] {
  return [currentDateTimeTool, webSearchTool, webFetchTool, createRecallHistoryTool(history)];
}

export async function executeTool(name: string, rawArguments: string, history?: HistoryStore): Promise<unknown> {
  const tool = createTools(history).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(parseToolArguments(rawArguments));
}

export function requiredToolForContext(context: string): string | undefined {
  const latest = context.trim().split("\n").at(-1) ?? "";
  if (/(?:помнишь|вспомни|вспомнить|мы\s+(?:говорили|обсуждали)|ты\s+(?:говорил|отвечал|рассказывал))/iu.test(latest)) {
    return "recall_history";
  }
  if (/(?:погод|последн|обновлен|новост|свеж|найди|поищи|интернет|когда\s+(?:выш|был|будет))/iu.test(latest)) {
    return "web_search";
  }
  if (
    /(?:который\s+час|сколько\s+времен|точн\S*\s+врем|какая\s+сейчас\s+дата|какое\s+сегодня\s+число)/iu.test(latest)
  ) {
    return "get_current_datetime";
  }
  return undefined;
}
