import { isRecord } from "../common.js";

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Tool arguments are not valid JSON");
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed;
}

export function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Tool argument '${name}' is required`);
  return value.trim();
}

export function limitedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

export function llmTool(tool: AgentTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
