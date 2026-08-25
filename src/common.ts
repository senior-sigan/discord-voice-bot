export type LogLevel = "error" | "info";
export type LogFields = Record<string, unknown>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  console[level](`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix ? ` ${suffix}` : ""}`);
}

export function formatMessageTime(date = new Date()): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
