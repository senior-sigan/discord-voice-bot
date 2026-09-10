import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { isRecord } from "../common.js";
import { dataPath, loadConfig } from "../config.js";
import { sortMemeIndexFile } from "./export-memes.js";

const MEMES_DIR = dataPath("memes");
const INPUT_FILE = dataPath("memes", "images.jsonl");
const OUTPUT_FILE = dataPath("memes", "images_explained.jsonl");
const SYSTEM_PROMPT = `Ты создаёшь поисковый каталог частной коллекции мемов из Discord.

Проанализируй изображение как мем, чтобы другой агент позже мог найти подходящую картинку по ситуации, эмоции, персонажу, цитате или теме.

description: 1–3 ёмких предложения. Максимально дословно перепиши весь значимый текст на изображении, включая мат и сленг, затем опиши только уверенно видимые детали и объясни шутку, каламбур или контраст по самой картинке. Для комикса из нескольких панелей восстанови простейшую последовательность событий и причинно-следственную связь с последней панелью, не додумывая неразличимые действия. Главный приоритет — точность: не называй имена людей, персонажей, фильмы, игры, франшизы или источники, если название не написано прямо на изображении; не пиши про «отсылку» и никогда не угадывай происхождение по общей похожести.
use_for: одно конкретное предложение вида «Когда ...», описывающее наблюдаемую цепочку «триггер → событие или проверка → итоговая реакция». Выбери одну главную буквальную эмоцию финальной панели и описывай ситуацию, а не давай оценку чужому поступку. Не используй расплывчатые сочетания вроде «шокированное, но ироничное одобрение» или «саркастическое восхищение» и не пиши абстрактное «для шутки».
tags: 5–12 коротких поисковых тегов преимущественно на русском в нижнем регистре; точные цитаты, ошибки и названия сохраняй на языке изображения. Включай ключевую цитату или её опорные слова, тему, эмоцию, ситуацию и уверенно видимые объекты/тип шаблона. Не добавляй неподписанные имена или источники. Без #, дублей и общих тегов «мем», «юмор», «картинка».

Перед ответом молча проверь: текст переписан точно; панели связаны по порядку; не добавлены неподписанные имена/источники; use_for описывает конкретный триггер и итоговую реакцию.

Отвечай только объектом заданной JSON-схемы.`;

interface MemeRecord extends Record<string, unknown> {
  attachment_id: string;
  path: string;
  content_type: string | null;
}

export interface MemeExplanation {
  description: string;
  use_for: string;
  tags: string[];
}

export class MemeImageError extends Error {
  override readonly name = "MemeImageError";
}

export interface ExplainMemesArguments {
  limit?: number;
  channelName?: string;
  channelId?: string;
}

function optionValue(args: readonly string[], index: number, option: string): [string, number] {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return [value, index + 1];
}

function positiveLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return limit;
}

export function parseExplainMemesArguments(args: readonly string[]): ExplainMemesArguments {
  const options: ExplainMemesArguments = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === undefined) break;
    let option: "channelName" | "channelId" | "limit";
    let value: string;
    if (argument === "--channel") {
      option = "channelName";
      [value, index] = optionValue(args, index, argument);
    } else if (argument.startsWith("--channel=")) {
      option = "channelName";
      value = argument.slice("--channel=".length);
    } else if (argument === "--channel-id") {
      option = "channelId";
      [value, index] = optionValue(args, index, argument);
    } else if (argument.startsWith("--channel-id=")) {
      option = "channelId";
      value = argument.slice("--channel-id=".length);
    } else if (argument === "--limit") {
      option = "limit";
      [value, index] = optionValue(args, index, argument);
    } else if (argument.startsWith("--limit=")) {
      option = "limit";
      value = argument.slice("--limit=".length);
    } else if (!argument.startsWith("--")) {
      option = "limit";
      value = argument;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }

    if (options[option] !== undefined) throw new Error(`duplicate option: ${argument}`);
    if (option === "limit") options.limit = positiveLimit(value);
    else {
      value = value.trim();
      if (!value) throw new Error(`${argument.split("=")[0]} requires a non-empty value`);
      options[option] = value;
    }
  }
  if (options.channelName !== undefined && options.channelId !== undefined) {
    throw new Error("use either --channel or --channel-id, not both");
  }
  return options;
}

export function matchesMemeChannel(record: Record<string, unknown>, options: ExplainMemesArguments): boolean {
  if (options.channelId !== undefined) return record["channel_id"] === options.channelId;
  if (options.channelName !== undefined) return record["channel_name"] === options.channelName;
  return true;
}

export function resizeImageForLlm(imagePath: string): Buffer {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      imagePath,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1536,iw)':'min(1536,ih)':force_original_aspect_ratio=decrease",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "pipe:1",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw new MemeImageError(`failed to resize ${imagePath}: ${result.error.message}`);
  if (result.status !== 0 || !result.stdout.length) {
    throw new MemeImageError(
      `failed to resize ${imagePath}: ${result.stderr.toString().trim() || `ffmpeg exited ${result.status}`}`,
    );
  }
  return result.stdout;
}

export function isRetryableLlmError(status: number, body: string): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    (status === 400 &&
      /peer_keepalive_timeout|channel error|model has crashed|connection entered error state/iu.test(body))
  );
}

function parseRecord(line: string, location: string): MemeRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`invalid JSON at ${location}`);
  }
  if (
    !isRecord(value) ||
    typeof value["attachment_id"] !== "string" ||
    typeof value["path"] !== "string" ||
    (value["content_type"] !== null && typeof value["content_type"] !== "string")
  ) {
    throw new Error(`invalid meme record at ${location}`);
  }
  return value as MemeRecord;
}

export function parseExplanation(value: unknown): MemeExplanation {
  if (typeof value === "string") {
    const json = value
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "")
      .trim();
    try {
      value = JSON.parse(json);
    } catch {
      throw new Error("LLM returned invalid JSON");
    }
  }
  if (
    !isRecord(value) ||
    typeof value["description"] !== "string" ||
    typeof value["use_for"] !== "string" ||
    !Array.isArray(value["tags"]) ||
    !value["tags"].every((tag) => typeof tag === "string")
  ) {
    throw new Error("LLM returned an invalid meme explanation");
  }
  const description = value["description"].trim();
  const useFor = value["use_for"].trim();
  const tags = [
    ...new Set(value["tags"].map((tag) => tag.trim().replace(/^#+/u, "").toLocaleLowerCase("ru-RU"))),
  ].filter((tag) => tag && !/^мем(?:\s|$)/u.test(tag));
  if (!description || !useFor || tags.length < 3 || tags.length > 15) {
    throw new Error("LLM returned an incomplete meme explanation");
  }
  return { description, use_for: useFor, tags };
}

function responseText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body["choices"])) throw new Error("invalid LLM response");
  const choice = body["choices"][0];
  const message = isRecord(choice) ? choice["message"] : undefined;
  const content =
    isRecord(message) && message["content"]
      ? message["content"]
      : isRecord(message)
        ? message["reasoning_content"]
        : undefined;
  const text =
    typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
            .flatMap((part) => (isRecord(part) && typeof part["text"] === "string" ? [part["text"]] : []))
            .join("")
            .trim()
        : "";
  if (!text) throw new Error(`LLM returned no content: ${JSON.stringify(body).slice(0, 2_000)}`);
  return text;
}

async function explain(
  record: MemeRecord,
  options: { baseUrl: string; model: string; apiKey?: string },
): Promise<MemeExplanation> {
  const memesRoot = `${resolve(MEMES_DIR)}${sep}`;
  const imagePath = resolve(MEMES_DIR, record.path);
  if (!imagePath.startsWith(memesRoot)) throw new Error(`image path escapes memes directory: ${record.path}`);
  const mime = record.content_type ?? "image/jpeg";
  if (!mime.startsWith("image/")) throw new Error(`invalid image content type: ${mime}`);
  const image = resizeImageForLlm(imagePath);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey) headers["authorization"] = `Bearer ${options.apiKey}`;
  const body = JSON.stringify({
    model: options.model,
    temperature: 0.2,
    max_tokens: 600,
    reasoning_effort: "none",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Опиши этот мем для поискового каталога." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "meme_explanation",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["description", "use_for", "tags"],
          properties: {
            description: { type: "string" },
            use_for: { type: "string" },
            tags: { type: "array", minItems: 5, maxItems: 12, items: { type: "string" } },
          },
        },
      },
    },
  });
  for (let attempt = 1; attempt <= 4; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(300_000),
        body,
      });
    } catch (error) {
      if (attempt === 4) throw new Error("LLM request failed after 4 attempts", { cause: error });
      const delay = 2 ** attempt;
      console.warn(`[LLM retry ${attempt}/3 in ${delay}s] ${error instanceof Error ? error.message : String(error)}`);
      await sleep(delay * 1_000);
      continue;
    }
    const responseBody = await response.text();
    if (response.ok) {
      try {
        return parseExplanation(responseText(JSON.parse(responseBody)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 4) {
          throw new Error(
            `LLM returned an invalid response after 4 attempts: ${message}; raw: ${responseBody.slice(0, 500)}`,
          );
        }
        const delay = 2 ** attempt;
        console.warn(`[LLM retry ${attempt}/3 in ${delay}s] invalid response: ${message}`);
        await sleep(delay * 1_000);
        continue;
      }
    }
    const error = `HTTP ${response.status}: ${responseBody.slice(0, 500)}`;
    if (attempt === 4 || !isRetryableLlmError(response.status, responseBody)) {
      throw new Error(`LLM request failed: ${error}`);
    }
    const delay = 2 ** attempt;
    console.warn(`[LLM retry ${attempt}/3 in ${delay}s] ${error}`);
    await sleep(delay * 1_000);
  }
  throw new Error("unreachable");
}

export function pendingAttachmentIds(inputIds: readonly string[], completedIds: readonly string[]): string[] {
  const input = new Set(inputIds);
  if (input.size !== inputIds.length) throw new Error(`${INPUT_FILE} has duplicate attachment_id values`);
  const completed = new Set<string>();
  for (const id of completedIds) {
    if (!input.has(id)) throw new Error(`${OUTPUT_FILE} contains attachment_id missing from ${INPUT_FILE}: ${id}`);
    if (completed.has(id)) throw new Error(`${OUTPUT_FILE} has duplicate attachment_id: ${id}`);
    completed.add(id);
  }
  return inputIds.filter((id) => !completed.has(id));
}

function completedAttachmentIds(input: Array<{ raw: string; record: MemeRecord }>): Set<string> {
  if (!existsSync(OUTPUT_FILE)) return new Set();
  const lines = readFileSync(OUTPUT_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  const outputIds: string[] = [];
  for (const [index, line] of lines.entries()) {
    const output = parseRecord(line, `${OUTPUT_FILE}:${index + 1}`);
    parseExplanation(output);
    outputIds.push(output.attachment_id);
  }
  const inputIds = input.map(({ record }) => record.attachment_id);
  pendingAttachmentIds(inputIds, outputIds);
  return new Set(outputIds);
}

async function main(): Promise<void> {
  sortMemeIndexFile(OUTPUT_FILE);
  try {
    const arguments_ = parseExplainMemesArguments(process.argv.slice(2));
    const config = loadConfig();
    const options = {
      baseUrl: config.settings.memes.llm_base_url,
      model: config.settings.memes.llm_model,
      ...(config.memeLlmApiKey ? { apiKey: config.memeLlmApiKey } : {}),
    };
    const input = readFileSync(INPUT_FILE, "utf8")
      .split("\n")
      .flatMap((raw, index) => (raw.trim() ? [{ raw, record: parseRecord(raw, `${INPUT_FILE}:${index + 1}`) }] : []));
    const completed = completedAttachmentIds(input);
    const selected = input.filter(({ record }) => matchesMemeChannel(record, arguments_));
    if ((arguments_.channelName !== undefined || arguments_.channelId !== undefined) && selected.length === 0) {
      throw new Error(`channel not found in ${INPUT_FILE}`);
    }
    const selectedCompleted = selected.filter(({ record }) => completed.has(record.attachment_id)).length;
    const pending = selected.filter(({ record }) => !completed.has(record.attachment_id));
    const limit = arguments_.limit ?? pending.length;
    let explainedCount = 0;
    let brokenCount = 0;

    for (const [offset, item] of pending.slice(0, limit).entries()) {
      console.log(`[${selectedCompleted + offset + 1}/${selected.length}]`);
      console.log(item.raw);
      let explanation: MemeExplanation;
      try {
        explanation = await explain(item.record, options);
      } catch (error) {
        if (!(error instanceof MemeImageError)) throw error;
        brokenCount++;
        console.error(`Skipped broken image attachment_id=${item.record.attachment_id}: ${error.message}`);
        continue;
      }
      console.log(JSON.stringify(explanation));
      appendFileSync(OUTPUT_FILE, `${JSON.stringify({ ...item.record, ...explanation })}\n`);
      explainedCount++;
    }
    console.log(
      `Done: selected=${selected.length} already_explained=${selectedCompleted} explained=${explainedCount} broken=${brokenCount}`,
    );
    if (brokenCount) {
      process.exitCode = 1;
    }
  } finally {
    sortMemeIndexFile(OUTPUT_FILE);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
