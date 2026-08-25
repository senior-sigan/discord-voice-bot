import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
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

const OUTPUT_DIR = "memes";
const IMAGE_DIR = join(OUTPUT_DIR, "images");
const INDEX_FILE = join(OUTPUT_DIR, "images.jsonl");
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

interface ImageRecord {
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

function existingRecords(): Map<string, ImageRecord> {
  const records = new Map<string, ImageRecord>();
  if (!existsSync(INDEX_FILE)) return records;
  for (const [index, line] of readFileSync(INDEX_FILE, "utf8").split("\n").entries()) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as ImageRecord;
      records.set(record.attachment_id, record);
    } catch {
      throw new Error(`invalid JSON in ${INDEX_FILE}:${index + 1}`);
    }
  }
  return records;
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
  const temporaryPath = `${path}.part`;
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

async function main(): Promise<void> {
  const token = process.env["DISCORD_TOKEN"];
  const guildId = process.env["DISCORD_GUILD_ID"];
  if (!token || !guildId) throw new Error("DISCORD_TOKEN and DISCORD_GUILD_ID are required");

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
    for (const thread of await archivedThreads(rest, parent.id, "public")) {
      const source = sourceChannel(thread);
      if (source) channels.set(source.id, source);
    }
    if (parent.type === ChannelType.GuildText) {
      try {
        for (const thread of await archivedThreads(rest, parent.id, "private")) {
          const source = sourceChannel(thread);
          if (source) channels.set(source.id, source);
        }
      } catch (error) {
        if (!isRecord(error) || error["status"] !== 403) throw error;
        console.warn(`Skipping private archived threads in #${parent.name}: missing Manage Threads permission`);
      }
    }
  }

  if (channels.size === 0) throw new Error(`no readable message channels${filter ? ` matching ${filter}` : ""}`);
  mkdirSync(IMAGE_DIR, { recursive: true });
  appendFileSync(INDEX_FILE, "");
  const records = existingRecords();
  const total = { messages: 0, downloaded: 0, skipped: 0, failed: 0 };
  for (const channel of channels.values()) {
    const result = await exportChannel(rest, channel, records);
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += result[key];
  }
  console.log(
    `Done: channels=${channels.size} messages=${total.messages} downloaded=${total.downloaded} skipped=${total.skipped} failed=${total.failed}`,
  );
  if (total.failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
