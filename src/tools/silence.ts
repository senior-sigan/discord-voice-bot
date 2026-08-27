import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { textResult } from "./types.js";

const parameters = Type.Object({}, { additionalProperties: false });

export const keepSilenceTool: AgentTool<typeof parameters> = {
  name: "keep_silence",
  label: "Промолчать",
  description:
    "Завершает проверку follow-up без ответа и без звука. Используй только когда текущий prompt явно описывает follow-up-окно, а последняя реплика не обращена к Олегу.",
  parameters,
  async execute() {
    return { ...textResult({ silent: true }), terminate: true };
  },
};
