import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type {
  APIAttachment,
  APIChannel,
  APIMessage,
  RESTGetAPIChannelMessagesResult,
  RESTGetAPIChannelThreadsArchivedPublicResult,
  RESTGetAPIGuildChannelsResult,
  RESTGetAPIGuildThreadsResult,
} from "discord.js";
import { ChannelType, REST, Routes } from "discord.js";

import { isRecord } from "../common.js";
import { dataPath, loadConfig } from "../config.js";

const OUTPUT_DIR = dataPath("memes");
const IMAGE_DIR = join(OUTPUT_DIR, "images");
const INDEX_FILE = join(OUTPUT_DIR, "images.jsonl");
const LOCK_FILE = join(OUTPUT_DIR, ".export.lock");
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const MESSAGE_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);
const THREAD_PARENT_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

interface SourceChannel {
  id: string;
  name: string;
  type: ChannelType;
  parent_id?: string | null;
}

export interface ImageRecord {
  timestamp: string;
  user_id: string;
  username: string;
  channel_id: string;
  channel_name: string;
  message_id: string;
  attachment_id: string;
  original_filename: string;
  content_type: string | null;
  path: string;
}

export function sortMemeRecordsChronologically(records: readonly ImageRecord[]): ImageRecord[] {
  return [...records].sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.attachment_id.localeCompare(right.attachment_id),
  );
}

export function isImageAttachment(attachment: Pick<APIAttachment, "content_type" | "filename">): boolean {
  return (
    attachment.content_type?.startsWith("image/") === true ||
    IMAGE_EXTENSIONS.has(extname(attachment.filename).toLowerCase())
  );
}

export function imageFileName(
  message: Pick<APIMessage, "id" | "timestamp" | "author">,
  attachment: APIAttachment,
): string {
  const timestamp = message.timestamp.replaceAll("-", "").replaceAll(":", "").replace(".", "_");
  const originalExtension = extname(attachment.filename).toLowerCase();
  const extension =
    MIME_EXTENSIONS[attachment.content_type ?? ""] ??
    (IMAGE_EXTENSIONS.has(originalExtension) ? originalExtension : ".img");
  return `${timestamp}__u-${message.author.id}__m-${message.id}__a-${attachment.id}${extension}`;
}

export function isDiscordForbidden(error: unknown): boolean {
  return isRecord(error) && error["status"] === 403;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error["code"] === "EPERM";
  }
}

export function acquireExportLock(path: string, pid = process.pid): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      const descriptor = openSync(path, "wx");
      try {
        writeFileSync(descriptor, `${pid}\n`);
      } finally {
        closeSync(descriptor);
      }
      return () => {
        try {
          unlinkSync(path);
        } catch (error) {
          if (!isRecord(error) || error["code"] !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (!isRecord(error) || error["code"] !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8").trim());
      if (Number.isSafeInteger(owner) && owner > 0 && processExists(owner)) {
        throw new Error(`meme export is already running with PID ${owner}`);
      }
      unlinkSync(path);
    }
  }
}

function sourceChannel(channel: {
  id: string;
  type: ChannelType;
  name?: string | null;
  parent_id?: string | null;
}): SourceChannel | undefined {
  if (!MESSAGE_CHANNEL_TYPES.has(channel.type) || typeof channel.name !== "string") return undefined;
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    ...(channel.parent_id === undefined ? {} : { parent_id: channel.parent_id }),
  };
}

function readRecords(path: string): Map<string, ImageRecord> {
  const records = new Map<string, ImageRecord>();
  if (!existsSync(path)) return records;
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as ImageRecord;
      if (records.has(record.attachment_id)) {
        throw new Error(`duplicate attachment_id ${record.attachment_id}`);
      }
      records.set(record.attachment_id, record);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`invalid meme record in ${path}:${index + 1}${detail}`);
    }
  }
  return records;
}

function existingRecords(): Map<string, ImageRecord> {
  return readRecords(INDEX_FILE);
}

export function sortMemeIndexFile(path = INDEX_FILE): void {
  if (!existsSync(path)) return;
  const records = [...readRecords(path).values()];
  const temporaryPath = `${path}.${process.pid}.sort.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      sortMemeRecordsChronologically(records)
        .map((record) => JSON.stringify(record))
        .join("\n") + (records.length ? "\n" : ""),
    );
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function archivedThreads(rest: REST, parentId: string, type: "public" | "private"): Promise<APIChannel[]> {
  const threads: APIChannel[] = [];
  let before: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const page = (await rest.get(Routes.channelThreads(parentId, type), {
      query,
    })) as RESTGetAPIChannelThreadsArchivedPublicResult;
    threads.push(...page.threads);
    const last = page.threads.at(-1);
    before = last && "thread_metadata" in last ? last.thread_metadata?.archive_timestamp : undefined;
    if (!page.has_more || !before) return threads;
  }
}

async function download(url: string, path: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.part`;
  rmSync(temporaryPath, { force: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  try {
    await pipeline(response.body, createWriteStream(temporaryPath));
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function exportChannel(
  rest: REST,
  channel: SourceChannel,
  records: Map<string, ImageRecord>,
): Promise<{ messages: number; downloaded: number; skipped: number; failed: number }> {
  const totals = { messages: 0, downloaded: 0, skipped: 0, failed: 0 };
  let before: string | undefined;
  console.log(`Scanning #${channel.name} (${channel.id})`);

  for (;;) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const messages = (await rest.get(Routes.channelMessages(channel.id), { query })) as RESTGetAPIChannelMessagesResult;
    totals.messages += messages.length;

    for (const message of messages) {
      for (const attachment of message.attachments.filter(isImageAttachment)) {
        const oldRecord = records.get(attachment.id);
        const relativePath = oldRecord?.path ?? join("images", imageFileName(message, attachment));
        const path = join(OUTPUT_DIR, relativePath);
        if (oldRecord && existsSync(path)) {
          totals.skipped++;
          continue;
        }
        try {
          await download(attachment.url, path);
          if (!oldRecord) {
            const record: ImageRecord = {
              timestamp: message.timestamp,
              user_id: message.author.id,
              username: message.author.username,
              channel_id: channel.id,
              channel_name: channel.name,
              message_id: message.id,
              attachment_id: attachment.id,
              original_filename: attachment.filename,
              content_type: attachment.content_type ?? null,
              path: relativePath,
            };
            appendFileSync(INDEX_FILE, `${JSON.stringify(record)}\n`);
            records.set(attachment.id, record);
          }
          totals.downloaded++;
          console.log(`  saved ${relativePath}`);
        } catch (error) {
          totals.failed++;
          console.error(`  failed ${attachment.url}:`, error);
        }
      }
    }

    before = messages.at(-1)?.id;
    if (messages.length < 100 || !before) return totals;
  }
}

async function exportMemes(): Promise<void> {
  const config = loadConfig();
  const token = config.discordToken;
  const guildId = config.settings.discord.guild_id;
  if (!guildId) throw new Error("Set defaults.discord.guild_id in config.json");

  const filter = process.argv[2];
  const rest = new REST({ version: "10" }).setToken(token);
  const guildChannels = (await rest.get(Routes.guildChannels(guildId))) as RESTGetAPIGuildChannelsResult;
  const selectedParents = guildChannels.filter(
    (channel) => !filter || channel.id === filter || channel.name === filter,
  );
  if (filter && selectedParents.length === 0) throw new Error(`channel not found: ${filter}`);

  const channels = new Map<string, SourceChannel>();
  for (const channel of selectedParents) {
    const source = sourceChannel(channel);
    if (source) channels.set(source.id, source);
  }

  const active = (await rest.get(Routes.guildActiveThreads(guildId))) as RESTGetAPIGuildThreadsResult;
  for (const thread of active.threads) {
    const source = sourceChannel(thread);
    if (
      source &&
      (!filter || source.name === filter || selectedParents.some((parent) => parent.id === source.parent_id))
    ) {
      channels.set(source.id, source);
    }
  }

  for (const parent of selectedParents.filter((channel) => THREAD_PARENT_TYPES.has(channel.type))) {
    try {
      for (const thread of await archivedThreads(rest, parent.id, "public")) {
        const source = sourceChannel(thread);
        if (source) channels.set(source.id, source);
      }
    } catch (error) {
      if (!isDiscordForbidden(error)) throw error;
      console.warn(`Skipping public archived threads in #${parent.name}: missing access`);
    }
    if (parent.type === ChannelType.GuildText) {
      try {
        for (const thread of await archivedThreads(rest, parent.id, "private")) {
          const source = sourceChannel(thread);
          if (source) channels.set(source.id, source);
        }
      } catch (error) {
        if (!isDiscordForbidden(error)) throw error;
        console.warn(`Skipping private archived threads in #${parent.name}: missing access`);
      }
    }
  }

  if (channels.size === 0) throw new Error(`no readable message channels${filter ? ` matching ${filter}` : ""}`);
  mkdirSync(IMAGE_DIR, { recursive: true });
  appendFileSync(INDEX_FILE, "");
  const records = existingRecords();
  const total = { messages: 0, downloaded: 0, skipped: 0, failed: 0 };
  let scannedChannels = 0;
  for (const channel of channels.values()) {
    try {
      const result = await exportChannel(rest, channel, records);
      scannedChannels++;
      for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += result[key];
    } catch (error) {
      if (!isDiscordForbidden(error)) throw error;
      console.warn(`Skipping #${channel.name} (${channel.id}): missing access`);
    }
  }
  if (!scannedChannels) throw new Error(`no accessible message channels${filter ? ` matching ${filter}` : ""}`);
  sortMemeIndexFile();
  console.log(
    `Done: channels=${scannedChannels} messages=${total.messages} downloaded=${total.downloaded} skipped=${total.skipped} failed=${total.failed}`,
  );
  if (total.failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const releaseLock = acquireExportLock(LOCK_FILE);
  try {
    await exportMemes();
  } finally {
    releaseLock();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
