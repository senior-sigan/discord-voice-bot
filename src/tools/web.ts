import { isIP } from "node:net";

import { isRecord } from "../common.js";
import type { AgentTool } from "./types.js";
import { limitedInteger, requiredString } from "./types.js";

export function isSafePublicUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
  if (isIP(hostname) === 4) {
    const [a = 0, b = 0] = hostname.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(hostname) === 6) {
    return (
      !hostname.startsWith("::ffff:") &&
      hostname !== "::" &&
      hostname !== "::1" &&
      !hostname.startsWith("fc") &&
      !hostname.startsWith("fd") &&
      !hostname.startsWith("fe8") &&
      !hostname.startsWith("fe9") &&
      !hostname.startsWith("fea") &&
      !hostname.startsWith("feb")
    );
  }
  return true;
}

export const webSearchTool: AgentTool = {
  name: "web_search",
  description: "Ищет актуальную информацию в интернете и возвращает заголовки, ссылки и фрагменты страниц.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Поисковый запрос" },
      limit: { type: "integer", minimum: 1, maximum: 5, description: "Количество результатов" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(args) {
    const query = requiredString(args, "query");
    const limit = limitedInteger(args["limit"], 5, 1, 5);
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-name": "oleg-voice-agent",
        "x-tavily-access-mode": "keyless",
      },
      body: JSON.stringify({ query, max_results: limit }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Web search failed: HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body["results"])) throw new Error("Invalid web search response");
    const results = body["results"]
      .flatMap((result) =>
        isRecord(result) && typeof result["url"] === "string" && typeof result["title"] === "string"
          ? [
              {
                title: result["title"],
                url: result["url"],
                snippet: typeof result["content"] === "string" ? result["content"].slice(0, 2_000) : "",
              },
            ]
          : [],
      )
      .slice(0, limit);
    if (!results.length) throw new Error("Web search returned no results");
    return { query, results };
  },
};

export const webFetchTool: AgentTool = {
  name: "web_fetch",
  description:
    "Читает содержимое найденной публичной веб-страницы как текст. Используй после web_search, когда фрагмента недостаточно.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Публичный HTTP(S) URL" },
      max_chars: { type: "integer", minimum: 1000, maximum: 20000 },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(args) {
    const value = requiredString(args, "url");
    if (!isSafePublicUrl(value)) throw new Error("Only public HTTP(S) URLs are allowed");
    const maxChars = limitedInteger(args["max_chars"], 12_000, 1_000, 20_000);
    const target = new URL(value);
    target.hash = "";
    const response = await fetch(`https://r.jina.ai/${target.toString()}`, {
      headers: { accept: "text/plain", "x-return-format": "markdown" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Web page fetch failed: HTTP ${response.status}`);
    return { url: target.toString(), content: (await response.text()).slice(0, maxChars) };
  },
};
