import type { AgentTool } from "./types.js";

export const currentDateTimeTool: AgentTool = {
  name: "get_current_datetime",
  description: "Возвращает точные текущие дату и время в указанном часовом поясе.",
  parameters: {
    type: "object",
    properties: {
      timezone: { type: "string", description: "Часовой пояс IANA, например Asia/Omsk" },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const timezone =
      typeof args["timezone"] === "string" && args["timezone"].trim()
        ? args["timezone"].trim()
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    let local: string;
    try {
      local = new Intl.DateTimeFormat("ru-RU", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
    } catch {
      throw new Error(`Unknown IANA timezone: ${timezone}`);
    }
    return { utc: now.toISOString(), timezone, local };
  },
};
