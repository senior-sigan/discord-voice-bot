import { isIP } from "node:net";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { isRecord } from "../common.js";
import { textResult, toolSignal } from "./types.js";

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

const searchParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, description: "Поисковый запрос" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Количество результатов" })),
  },
  { additionalProperties: false },
);

export const webSearchTool: AgentTool<typeof searchParameters> = {
  name: "web_search",
  label: "Поиск в интернете",
  description: "Ищет актуальную информацию в интернете и возвращает заголовки, ссылки и фрагменты страниц.",
  parameters: searchParameters,
  async execute(_toolCallId, args, signal) {
    const query = args.query.trim();
    const limit = args.limit ?? 5;
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-name": "oleg-voice-agent",
        "x-tavily-access-mode": "keyless",
      },
      body: JSON.stringify({ query, max_results: limit }),
      signal: toolSignal(signal, 30_000),
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
    return textResult({ query, results });
  },
};

const fetchParameters = Type.Object(
  {
    url: Type.String({ minLength: 1, description: "Публичный HTTP(S) URL" }),
    max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 20_000 })),
  },
  { additionalProperties: false },
);

export const webFetchTool: AgentTool<typeof fetchParameters> = {
  name: "web_fetch",
  label: "Чтение веб-страницы",
  description:
    "Читает содержимое найденной публичной веб-страницы как текст. Используй после web_search, когда фрагмента недостаточно.",
  parameters: fetchParameters,
  async execute(_toolCallId, args, signal) {
    if (!isSafePublicUrl(args.url)) throw new Error("Only public HTTP(S) URLs are allowed");
    const target = new URL(args.url);
    target.hash = "";
    const response = await fetch(`https://r.jina.ai/${target.toString()}`, {
      headers: { accept: "text/plain", "x-return-format": "markdown" },
      signal: toolSignal(signal, 20_000),
    });
    if (!response.ok) throw new Error(`Web page fetch failed: HTTP ${response.status}`);
    return textResult({
      url: target.toString(),
      content: (await response.text()).slice(0, args.max_chars ?? 12_000),
    });
  },
};
