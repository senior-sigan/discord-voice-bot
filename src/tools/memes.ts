import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { dataPath } from "../config.js";
import { type SearchResult, SearchStore } from "../search/index.js";

const parameters = Type.Object(
  {
    query: Type.String({ minLength: 1, description: "Описание нужного мема обычными словами" }),
    date: Type.Optional(
      Type.String({ description: "YYYY, YYYY-MM, YYYY-MM-DD, today, yesterday, this_year или last_year" }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  },
  { additionalProperties: false },
);

export function createMemeSearchTool(
  store: Pick<SearchStore, "search"> = new SearchStore(dataPath("search")),
): AgentTool<typeof parameters> {
  return {
    name: "search_memes",
    label: "Поиск мемов",
    description:
      "Ищет мемы по смыслу описаний с помощью локальной embedding-модели. Формулируй ситуацию естественными словами. Можно ограничить поиск датой или годом. Возвращает до пяти JSONL-строк; готовое абсолютное поле path передавай в discord_send_message как image_path.",
    parameters,
    async execute(_toolCallId, args) {
      const date = resolveDate(args.date, args.query);
      let ranked: SearchResult[];
      try {
        ranked = await store.search("memes", args.query, {
          limit: args.limit ?? 5,
          ...(date ? dateRange(date) : {}),
        });
      } catch (error) {
        throw new Error("Поиск мемов недоступен. Проверь индекс: mise exec -- npm run index-memes", { cause: error });
      }
      const results = ranked.map(({ metadata }) => {
        if (typeof metadata?.["raw"] !== "string") throw new Error("Meme search index has invalid metadata");
        return metadata["raw"];
      });
      return {
        content: [{ type: "text", text: results.join("\n") || "Подходящих мемов не найдено." }],
        details: {
          query: args.query,
          ...(date ? { date } : {}),
          count: results.length,
          results,
          scores: ranked.map(({ id, score }) => ({ id, score })),
        },
      };
    },
  };
}

function resolveDate(value: string | undefined, query: string, now = new Date()): string | undefined {
  const requested = value?.trim().toLocaleLowerCase("ru-RU");
  const source = requested || query.toLocaleLowerCase("ru-RU");
  if (requested && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(requested)) return requested;
  if (/(?:last_year|прошл(?:ый|ом)\s+год(?:у)?)/iu.test(source)) return String(now.getFullYear() - 1);
  if (/(?:this_year|эт(?:от|ом)\s+год(?:у)?)/iu.test(source)) return String(now.getFullYear());
  if (/(?:today|сегодня)/iu.test(source)) return localDate(now);
  if (/(?:yesterday|вчера)/iu.test(source)) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return localDate(yesterday);
  }
  if (requested) throw new Error(`Unsupported meme date: ${value}`);
  return undefined;
}

function dateRange(date: string): { from: string; to: string } {
  if (date.length === 4) return { from: `${date}-01-01`, to: `${date}-12-31` };
  if (date.length === 7) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    if (month < 1 || month > 12) throw new Error(`Invalid meme date: ${date}`);
    const last = new Date(year, month, 0).getDate();
    return { from: `${date}-01`, to: `${date}-${last}` };
  }
  return { from: date, to: date };
}

function localDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}
