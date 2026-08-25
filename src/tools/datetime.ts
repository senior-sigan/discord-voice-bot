import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { textResult } from "./types.js";

const parameters = Type.Object(
  {
    timezone: Type.Optional(Type.String({ description: "Часовой пояс IANA, например Asia/Omsk" })),
  },
  { additionalProperties: false },
);

export const currentDateTimeTool: AgentTool<typeof parameters> = {
  name: "get_current_datetime",
  label: "Текущее время",
  description: "Возвращает точные текущие дату и время в указанном часовом поясе.",
  parameters,
  async execute(_toolCallId, args) {
    const timezone = args.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    return textResult({ utc: now.toISOString(), timezone, local });
  },
};
