import { realpathSync, statSync } from "node:fs";
import { extname, sep } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { textResult, toolSignal } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export interface DiscordToolsClient {
  voiceMembers(channel: string): Promise<Array<{ id: string; name: string; bot: boolean }>>;
  sendMessage(channel: string, content?: string, imagePath?: string): Promise<{ id: string; url: string }>;
  readMessages(
    channel: string,
    limit: number,
    beforeMessageId?: string,
    aroundDate?: Date,
  ): Promise<
    Array<{
      id: string;
      author: string;
      content: string;
      timestamp: string;
      url: string;
      images?: Array<{ filename: string; mime_type?: string }>;
    }>
  >;
  readImage?(
    channel: string,
    messageId?: string,
  ): Promise<{ messageId: string; url: string; filename: string; mimeType?: string }>;
  soundboardSounds(): Promise<Array<{ id: string; name: string; emoji?: string }>>;
  playSoundboard(channel: string, soundId: string): Promise<{ id: string; name: string }>;
}

const membersParameters = Type.Object({}, { additionalProperties: false });
const soundsParameters = Type.Object({}, { additionalProperties: false });
const playSoundParameters = Type.Object(
  { sound_id: Type.String({ minLength: 1, description: "ID подходящего звука из discord_soundboard_sounds" }) },
  { additionalProperties: false },
);
const sendParameters = Type.Object(
  {
    content: Type.Optional(Type.String({ maxLength: 2_000, description: "Текст сообщения или ссылки" })),
    image_path: Type.Optional(Type.String({ minLength: 1, description: "Путь к локальной картинке из workspace" })),
  },
  { additionalProperties: false },
);
const readMessagesParameters = Type.Object(
  {
    channel: Type.String({ minLength: 1, description: "Название или ID текстового канала Discord" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Число сообщений, от 1 до 100" })),
    before_message_id: Type.Optional(
      Type.String({ minLength: 1, description: "ID сообщения, перед которым читать более старую историю" }),
    ),
    around_date: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Дата и время в ISO 8601 с часовым поясом, вокруг которых искать сообщения",
      }),
    ),
  },
  { additionalProperties: false },
);
const readImageParameters = Type.Object(
  {
    channel: Type.String({ minLength: 1, description: "Название или ID текстового канала Discord" }),
    message_id: Type.Optional(Type.String({ minLength: 1, description: "ID сообщения с картинкой, если известен" })),
  },
  { additionalProperties: false },
);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function createDiscordTools(discord: DiscordToolsClient): AgentTool[] {
  const members: AgentTool<typeof membersParameters> = {
    name: "discord_channel_members",
    label: "Участники голосового канала",
    description: "Показывает, кто сейчас находится вместе с агентом в голосовом канале master.",
    parameters: membersParameters,
    async execute() {
      const users = await discord.voiceMembers("master");
      return textResult({ channel: "master", count: users.length, members: users });
    },
  };
  const send: AgentTool<typeof sendParameters> = {
    name: "discord_send_message",
    label: "Сообщение в Discord",
    description:
      "Отправляет в текстовый канал общак текст, одну или несколько ссылок и/или локальную картинку. Используй, когда пользователь просит прислать результат в чат.",
    parameters: sendParameters,
    async execute(_toolCallId, args) {
      const content = args.content?.trim() || undefined;
      const imagePath = args.image_path ? safeImagePath(args.image_path) : undefined;
      if (!content && !imagePath) throw new Error("content or image_path is required");
      const message = await discord.sendMessage("общак", content, imagePath);
      return textResult({ channel: "общак", ...message });
    },
  };
  const readMessages: AgentTool<typeof readMessagesParameters> = {
    name: "discord_read_messages",
    label: "Последние сообщения текстового канала Discord",
    description:
      "Читает сообщения указанного текстового канала. Без параметров возвращает последние сообщения; с before_message_id — историю перед этим сообщением; с around_date — сообщения около указанного момента в прошлом. У сообщения с картинкой будет поле images: передай его id в discord_view_image, чтобы посмотреть нужную картинку. around_date передавай в ISO 8601 с часовым поясом. Используй, когда спрашивают, что написано в общаке или другом текстовом канале; не заменяй этим голосовой контекст. При status unavailable доступа или данных нет — честно сообщи об этом и не выдумывай сообщения.",
    parameters: readMessagesParameters,
    async execute(_toolCallId, args) {
      const channel = args.channel.trim();
      if (!channel) throw new Error("channel must not be blank");
      const limit = Math.max(1, Math.min(100, Math.trunc(args.limit ?? 20)));
      const beforeMessageId = args.before_message_id?.trim() || undefined;
      if (beforeMessageId && args.around_date)
        throw new Error("before_message_id and around_date cannot be used together");
      const aroundDate = args.around_date ? parseDiscordDate(args.around_date) : undefined;
      try {
        const messages = await discord.readMessages(channel, limit, beforeMessageId, aroundDate);
        return textResult({
          status: "ok",
          channel,
          limit,
          before_message_id: beforeMessageId,
          ...(aroundDate ? { around_date: aroundDate.toISOString() } : {}),
          count: messages.length,
          messages,
        });
      } catch (error) {
        return textResult({
          status: "unavailable",
          channel,
          limit,
          before_message_id: beforeMessageId,
          ...(aroundDate ? { around_date: aroundDate.toISOString() } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
  const sounds: AgentTool<typeof soundsParameters> = {
    name: "discord_soundboard_sounds",
    label: "Звуки Discord soundboard",
    description:
      "Возвращает доступные звуки soundboard. Используй перед discord_soundboard_play, чтобы выбрать уместный звук по названию.",
    parameters: soundsParameters,
    async execute() {
      const items = await discord.soundboardSounds();
      return textResult({ count: items.length, sounds: items });
    },
  };
  const playSound: AgentTool<typeof playSoundParameters> = {
    name: "discord_soundboard_play",
    label: "Воспроизвести звук Discord",
    description:
      "Молча воспроизводит один выбранный soundboard-звук в голосовом канале master. Используй редко и только когда звук точно подходит к ситуации.",
    parameters: playSoundParameters,
    async execute(_toolCallId, args) {
      const soundId = args.sound_id.trim();
      if (!soundId) throw new Error("sound_id must not be blank");
      return textResult({ channel: "master", ...(await discord.playSoundboard("master", soundId)) });
    },
  };
  const readImage: AgentTool<typeof readImageParameters> = {
    name: "discord_view_image",
    label: "Посмотреть картинку из Discord",
    description:
      "Передаёт модели последнее изображение из указанного текстового канала или изображение из message_id. Используй, когда пользователь просит посмотреть присланный скриншот, фото или мем.",
    parameters: readImageParameters,
    async execute(_toolCallId, args, signal) {
      const channel = args.channel.trim();
      if (!channel) throw new Error("channel must not be blank");
      const messageId = args.message_id?.trim() || undefined;
      try {
        const image = await discord.readImage?.(channel, messageId);
        if (!image) throw new Error("Discord client does not support image reading");
        const target = new URL(image.url);
        if (target.protocol !== "https:" || !/(?:^|\.)discordapp\.(?:com|net)$/u.test(target.hostname)) {
          throw new Error("Discord attachment URL is invalid");
        }
        const response = await fetch(target, { signal: toolSignal(signal, 30_000) });
        if (!response.ok || !response.body) throw new Error(`Image download failed: HTTP ${response.status}`);
        const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || image.mimeType;
        if (!mimeType?.startsWith("image/")) throw new Error("Discord attachment is not an image");
        const declaredSize = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES)
          throw new Error("Discord image exceeds 10 MiB");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_IMAGE_BYTES) throw new Error("Discord image exceeds 10 MiB");
          chunks.push(bytes);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ channel, message_id: image.messageId, filename: image.filename, size }),
            },
            { type: "image", data: Buffer.concat(chunks).toString("base64"), mimeType },
          ],
          details: { status: "ok", channel, message_id: image.messageId, filename: image.filename, size },
        };
      } catch (error) {
        return textResult({
          status: "unavailable",
          channel,
          ...(messageId ? { message_id: messageId } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
  return [members, send, readMessages, sounds, playSound, readImage];
}

function parseDiscordDate(value: string): Date {
  const text = value.trim();
  const date = new Date(text);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text) || Number.isNaN(date.getTime())) {
    throw new Error("around_date must be an ISO 8601 date-time with a timezone");
  }
  return date;
}

export function safeImagePath(value: string): string {
  const root = `${realpathSync(".")}${sep}`;
  let path: string;
  try {
    path = realpathSync(value);
  } catch {
    throw new Error(`Image not found: ${value}`);
  }
  if (!path.startsWith(root) || !statSync(path).isFile()) throw new Error("Image must be a file inside the workspace");
  if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error("Unsupported image format");
  return path;
}
