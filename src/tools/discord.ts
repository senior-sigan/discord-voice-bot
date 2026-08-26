import { realpathSync, statSync } from "node:fs";
import { extname, sep } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { textResult } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export interface DiscordToolsClient {
  voiceMembers(channel: string): Promise<Array<{ id: string; name: string; bot: boolean }>>;
  sendMessage(channel: string, content?: string, imagePath?: string): Promise<{ id: string; url: string }>;
}

const membersParameters = Type.Object({}, { additionalProperties: false });
const sendParameters = Type.Object(
  {
    content: Type.Optional(Type.String({ maxLength: 2_000, description: "Текст сообщения или ссылки" })),
    image_path: Type.Optional(Type.String({ minLength: 1, description: "Путь к локальной картинке из workspace" })),
  },
  { additionalProperties: false },
);

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
  return [members, send];
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
