import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Cron } from "croner";

import { errorMessage, isRecord, log } from "./common.js";

type ScheduledTaskBase = {
  id: string;
  created_at: string;
  instruction: string;
  timezone: string;
  status: "scheduled" | "running" | "completed" | "failed";
  runs: number;
  next_run_at?: string;
  last_run_at?: string;
  completed_at?: string;
  last_error?: string;
};

export type ScheduledTask = ScheduledTaskBase &
  ({ kind: "once"; run_at: string; cron?: never } | { kind: "cron"; cron: string; run_at?: never });

export type CreateTaskInput = {
  instruction: string;
  timezone: string;
  run_at?: string;
  cron?: string;
};

export class TaskScheduler {
  readonly tasks: ScheduledTask[] = [];
  private readonly jobs = new Map<string, Cron>();
  private started = false;

  constructor(
    readonly path: string,
    private readonly execute: (task: ScheduledTask) => Promise<void>,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "[]\n");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value)) throw new Error(`Invalid tasks file: ${path}`);
    for (const [index, task] of value.entries()) {
      if (isScheduledTask(task)) this.tasks.push(task);
      else log("error", "invalid scheduled task skipped", { index: index + 1 });
    }
    log("info", "scheduled tasks loaded", { file: path, entries: this.tasks.length });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks) {
      if (task.status === "running") {
        task.status = task.kind === "cron" ? "scheduled" : "failed";
        task.last_error = "Interrupted by restart";
      }
      try {
        this.schedule(task);
      } catch (error) {
        task.status = "failed";
        task.last_error = errorMessage(error);
        log("error", "scheduled task could not be restored", { id: task.id, error: task.last_error });
      }
    }
    this.save();
  }

  stop(): void {
    this.started = false;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  create(input: CreateTaskInput): ScheduledTask {
    const instruction = input.instruction.trim();
    const timezone = input.timezone.trim();
    const runAt = input.run_at?.trim();
    const cron = input.cron?.trim();
    if (instruction.length < 3 || instruction.length > 2_000) throw new Error("Invalid task instruction");
    validateTimezone(timezone);
    if ((!runAt && !cron) || (runAt && cron)) throw new Error("Provide exactly one of run_at or cron");

    const common = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      instruction,
      timezone,
      status: "scheduled" as const,
      runs: 0,
    };
    let task: ScheduledTask;
    if (runAt) {
      const next = new Date(runAt);
      if (Number.isNaN(next.getTime())) throw new Error("run_at must be an ISO 8601 datetime");
      if (next.getTime() < Date.now() - 5_000) throw new Error("run_at is in the past");
      task = { ...common, kind: "once", run_at: next.toISOString(), next_run_at: next.toISOString() };
    } else if (cron) {
      const probe = new Cron(cron, { timezone, mode: "5-part", paused: true });
      const next = probe.nextRun();
      probe.stop();
      if (!next) throw new Error("Cron expression has no future runs");
      task = { ...common, kind: "cron", cron, next_run_at: next.toISOString() };
    } else {
      throw new Error("Provide exactly one of run_at or cron");
    }

    this.tasks.push(task);
    this.save();
    if (this.started) this.schedule(task);
    return task;
  }

  list(includeCompleted = false): ScheduledTask[] {
    return this.tasks
      .filter((task) => includeCompleted || (task.status !== "completed" && task.status !== "failed"))
      .map((task) => ({ ...task }));
  }

  delete(id: string): ScheduledTask | undefined {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return undefined;
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    const deleted = this.tasks[index];
    if (!deleted) return undefined;
    this.tasks.splice(index, 1);
    this.save();
    return deleted;
  }

  private schedule(task: ScheduledTask): void {
    if (!this.started || task.status !== "scheduled") return;
    this.jobs.get(task.id)?.stop();
    const pattern =
      task.kind === "cron" ? task.cron : new Date(Math.max(Date.now() + 50, new Date(task.run_at).getTime()));
    const job = new Cron(
      pattern,
      {
        name: `task:${task.id}`,
        ...(task.kind === "cron" ? { timezone: task.timezone, mode: "5-part" as const } : { maxRuns: 1 }),
        protect: true,
      },
      () => this.run(task.id),
    );
    this.jobs.set(task.id, job);
    const next = job.nextRun();
    if (next) task.next_run_at = next.toISOString();
    else delete task.next_run_at;
  }

  private async run(id: string): Promise<void> {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (task?.status !== "scheduled") return;
    task.status = "running";
    task.last_run_at = new Date().toISOString();
    delete task.last_error;
    this.save();

    let failure: string | undefined;
    try {
      await this.execute({ ...task });
    } catch (error) {
      failure = errorMessage(error);
      log("error", "scheduled task failed", { id, error: failure });
    }

    const current = this.tasks.find((candidate) => candidate.id === id);
    if (!current) return;
    current.runs++;
    if (current.kind === "once") {
      current.status = failure ? "failed" : "completed";
      if (failure) current.last_error = failure;
      else current.completed_at = new Date().toISOString();
      delete current.next_run_at;
      this.jobs.delete(id);
    } else {
      current.status = "scheduled";
      if (failure) current.last_error = failure;
      const next = this.jobs.get(id)?.nextRun();
      if (next) current.next_run_at = next.toISOString();
      else delete current.next_run_at;
    }
    this.save();
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.tasks, null, 2)}\n`);
    renameSync(temporary, this.path);
  }
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Unknown IANA timezone: ${timezone}`);
  }
}

function isScheduledTask(value: unknown): value is ScheduledTask {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["created_at"] === "string" &&
    typeof value["instruction"] === "string" &&
    (value["kind"] === "once" || value["kind"] === "cron") &&
    typeof value["timezone"] === "string" &&
    ((value["kind"] === "once" && typeof value["run_at"] === "string" && value["cron"] === undefined) ||
      (value["kind"] === "cron" && typeof value["cron"] === "string" && value["run_at"] === undefined)) &&
    (value["status"] === "scheduled" ||
      value["status"] === "running" ||
      value["status"] === "completed" ||
      value["status"] === "failed") &&
    Number.isInteger(value["runs"]) &&
    (value["runs"] as number) >= 0 &&
    (value["next_run_at"] === undefined || typeof value["next_run_at"] === "string") &&
    (value["last_run_at"] === undefined || typeof value["last_run_at"] === "string") &&
    (value["completed_at"] === undefined || typeof value["completed_at"] === "string") &&
    (value["last_error"] === undefined || typeof value["last_error"] === "string")
  );
}
