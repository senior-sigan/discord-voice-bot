import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { TaskScheduler } from "../scheduler.js";
import { textResult } from "./types.js";

const createParameters = Type.Object(
  {
    instruction: Type.String({
      minLength: 3,
      maxLength: 2_000,
      description: "Самодостаточная инструкция, которую агент выполнит при срабатывании задачи",
    }),
    run_at: Type.Optional(
      Type.String({ description: "Точное время одноразового запуска в ISO 8601 с часовым поясом" }),
    ),
    cron: Type.Optional(
      Type.String({ description: "Пятичастное cron-выражение для повторяющейся задачи, например */15 * * * *" }),
    ),
    timezone: Type.Optional(Type.String({ description: "Часовой пояс IANA для cron, например Asia/Omsk" })),
  },
  { additionalProperties: false },
);

const listParameters = Type.Object(
  {
    include_completed: Type.Optional(Type.Boolean({ description: "Включить выполненные и неудачные задачи" })),
  },
  { additionalProperties: false },
);

const deleteParameters = Type.Object(
  { id: Type.String({ minLength: 1, description: "ID задачи из list_scheduled_tasks" }) },
  { additionalProperties: false },
);

export function createTaskTools(scheduler: TaskScheduler, defaultTimezone: string): AgentTool[] {
  const create: AgentTool<typeof createParameters> = {
    name: "create_scheduled_task",
    label: "Запланировать задачу",
    description:
      "Создаёт персистентную одноразовую или повторяющуюся задачу. Для относительного времени сначала вызови get_current_datetime и вычисли run_at. Передай ровно одно: run_at или пятичастный cron. В instruction сохрани только действие на момент запуска, без описания расписания.",
    parameters: createParameters,
    async execute(_toolCallId, args) {
      const task = scheduler.create({
        instruction: args.instruction,
        timezone: args.timezone?.trim() || defaultTimezone,
        ...(args.run_at ? { run_at: args.run_at } : {}),
        ...(args.cron ? { cron: args.cron } : {}),
      });
      return textResult({ created: true, task });
    },
  };

  const list: AgentTool<typeof listParameters> = {
    name: "list_scheduled_tasks",
    label: "Показать запланированные задачи",
    description: "Показывает активные напоминания и повторяющиеся задачи с ID и следующим временем запуска.",
    parameters: listParameters,
    async execute(_toolCallId, args) {
      const tasks = scheduler.list(args.include_completed ?? false);
      return textResult({ count: tasks.length, tasks });
    },
  };

  const remove: AgentTool<typeof deleteParameters> = {
    name: "delete_scheduled_task",
    label: "Удалить запланированную задачу",
    description: "Останавливает и удаляет задачу. Используй для отмены повторяющегося напоминания по его ID.",
    parameters: deleteParameters,
    async execute(_toolCallId, args) {
      const task = scheduler.delete(args.id);
      if (!task) throw new Error(`Scheduled task not found: ${args.id}`);
      return textResult({ deleted: true, task });
    },
  };

  return [create, list, remove];
}
