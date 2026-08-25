import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export function textResult<T>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

export function toolSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
