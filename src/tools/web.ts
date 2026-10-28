import { isIP } from "node:net";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { errorMessage, isRecord } from "../common.ts";
import { textResult, toolSignal } from "./types.ts";

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

export function createWebSearchTool(baseUrl: string): AgentTool<typeof searchParameters> {
  const endpoint = new URL(`${baseUrl.replace(/\/$/u, "")}/search/text`);
  return {
    name: "web_search",
    label: "Поиск в интернете",
    description: "Ищет актуальную информацию в интернете и возвращает заголовки, ссылки и фрагменты страниц.",
    parameters: searchParameters,
    async execute(_toolCallId, args, signal) {
      const query = args.query.trim();
      if (!query) throw new Error("Web search query must not be blank");
      const limit = args.limit ?? 5;
      const requestSignal = toolSignal(signal, 30_000);
      let response: Response;
      let body: unknown;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, max_results: limit, backend: "auto" }),
          signal: requestSignal,
        });
        const raw = await response.text();
        try {
          body = JSON.parse(raw);
        } catch {
          if (response.ok) throw new Error("Invalid DDGS search response: expected JSON");
        }
      } catch (error) {
        if (requestSignal.aborted) {
          throw new Error(signal?.aborted ? "Web search cancelled" : "DDGS search timed out after 30 seconds", {
            cause: error,
          });
        }
        throw new Error(
          `DDGS request failed at ${endpoint.origin}: ${errorMessage(error)}. Check mise run search:health`,
          { cause: error },
        );
      }
      if (!response.ok) {
        // DDGS 9.16 reports an empty search as HTTP 500.
        if (response.status === 500 && isRecord(body) && body["detail"] === "Search failed: No results found.") {
          return textResult({ query, results: [] });
        }
        const detail = isRecord(body) && typeof body["detail"] === "string" ? `: ${body["detail"].slice(0, 500)}` : "";
        throw new Error(`DDGS search failed: HTTP ${response.status}${detail}`);
      }
      if (!isRecord(body) || !Array.isArray(body["results"])) throw new Error("Invalid DDGS search response");
      const results = body["results"]
        .flatMap((result) =>
          isRecord(result) && typeof result["href"] === "string" && typeof result["title"] === "string"
            ? [
                {
                  title: result["title"],
                  url: result["href"],
                  snippet: typeof result["body"] === "string" ? result["body"].slice(0, 2_000) : "",
                },
              ]
            : [],
        )
        .slice(0, limit);
      if (body["results"].length > 0 && !results.length) throw new Error("Invalid DDGS search results");
      return textResult({ query, results });
    },
  };
}

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
