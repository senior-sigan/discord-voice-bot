import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { z } from "zod";

import { errorMessage, log } from "./common.js";

const speakRequestSchema = z.strictObject({ text: z.string().trim().min(1).max(1_000) });
const MAX_BODY_BYTES = 4_096;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  speak: (text: string) => Promise<void>,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/speak") {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      sendJson(response, 413, { error: "request body is too large" });
      return;
    }
    chunks.push(buffer);
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "invalid JSON" });
    return;
  }
  const parsed = speakRequestSchema.safeParse(json);
  if (!parsed.success) {
    sendJson(response, 400, { error: "text must contain 1–1000 characters" });
    return;
  }

  try {
    log("info", "local speech requested", { text: parsed.data.text });
    await speak(parsed.data.text);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    log("error", "local speech failed", { error: errorMessage(error) });
    sendJson(response, 503, { error: errorMessage(error) });
  }
}

export async function startLocalControlServer(
  host: string,
  port: number,
  speak: (text: string) => Promise<void>,
): Promise<Server> {
  const server = createServer((request, response) => {
    void handleRequest(request, response, speak).catch((error: unknown) => {
      log("error", "local control request failed", { error: errorMessage(error) });
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  log("info", "local control server started", {
    url: `http://${host}:${address && typeof address !== "string" ? address.port : port}`,
  });
  return server;
}
