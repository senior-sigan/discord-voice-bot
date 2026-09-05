import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from "@discordjs/voice";
import type { Guild, Interaction } from "discord.js";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  SnowflakeUtil,
} from "discord.js";

import { errorMessage, log } from "../common.js";
import type { Transcriber, Transcript } from "../stt/index.js";
import type { VoiceAudio } from "../tts/index.js";
import { DiscordVoiceSession } from "./voice-session.js";

export interface DiscordAgent {
  onTranscript(transcript: Transcript): void;
  onVoiceMemberJoined(guildId: string, userId: string, user: string, channel: string): void;
  clear(guildId: string): void;
}

export function enteredVoiceChannel(
  oldChannelId: string | null,
  newChannelId: string | null,
  targetId: string,
): boolean {
  return oldChannelId !== targetId && newChannelId === targetId;
}

const voiceCommand = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("Manage the voice agent")
  .addSubcommand((command) =>
    command
      .setName("join")
      .setDescription("Join a voice channel")
      .addStringOption((option) =>
        option.setName("channel").setDescription("Voice channel name, for example master").setRequired(true),
      ),
  )
  .addSubcommand((command) => command.setName("leave").setDescription("Leave the voice channel"));

function isImageAttachment(attachment: { contentType: string | null; name: string }): boolean {
  return attachment.contentType?.startsWith("image/") || /\.(?:avif|bmp|gif|jpe?g|png|webp)$/iu.test(attachment.name);
}

export class DiscordBot {
  private readonly captures = new Map<string, DiscordVoiceSession>();
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  private agent: DiscordAgent | undefined;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly guildId: string,
    private readonly transcriber: Transcriber,
  ) {}

  setAgent(agent: DiscordAgent): void {
    this.agent = agent;
  }

  async start(autoJoinChannel?: string): Promise<void> {
    if (!this.agent) throw new Error("Discord agent is not configured");
    const ready = new Promise<Client<true>>((resolve) => this.client.once(Events.ClientReady, resolve));
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction);
    });
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const targetId = this.captures.get(newState.guild.id)?.connection.joinConfig.channelId;
      const member = newState.member;
      if (
        !targetId ||
        !member ||
        member.user.bot ||
        !enteredVoiceChannel(oldState.channelId, newState.channelId, targetId)
      ) {
        return;
      }
      this.agent?.onVoiceMemberJoined(
        newState.guild.id,
        member.id,
        member.displayName,
        newState.channel?.name ?? targetId,
      );
    });
    await this.client.login(this.token);
    const readyClient = await ready;
    const rest = new REST().setToken(this.token);
    await rest.put(Routes.applicationGuildCommands(readyClient.user.id, this.guildId), {
      body: [voiceCommand.toJSON()],
    });
    log("info", "bot is ready", { user: readyClient.user.tag });
    if (autoJoinChannel) {
      const guild = readyClient.guilds.cache.get(this.guildId);
      if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
      try {
        await this.joinVoice(guild, autoJoinChannel);
      } catch (error) {
        this.leaveVoice(guild.id);
        log("error", "automatic voice join failed", { channel: autoJoinChannel, error: errorMessage(error) });
      }
    }
  }

  async speak(guildId: string, audio: VoiceAudio): Promise<void> {
    const capture = this.captures.get(guildId);
    if (!capture) {
      if ("stream" in audio) audio.cancel();
      throw new Error("Voice connection is no longer active");
    }
    await capture.speak(audio);
  }

  async voiceMembers(channelName: string): Promise<Array<{ id: string; name: string; bot: boolean }>> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    const channel = guild.channels.cache.find(
      (candidate) => candidate.isVoiceBased() && candidate.name.toLowerCase() === channelName.toLowerCase(),
    );
    if (!channel?.isVoiceBased()) throw new Error(`voice channel not found: ${channelName}`);
    return [...channel.members.values()]
      .filter((member) => member.id !== this.client.user?.id)
      .map((member) => ({ id: member.id, name: member.displayName, bot: member.user.bot }))
      .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  }

  async sendMessage(channelName: string, content?: string, imagePath?: string): Promise<{ id: string; url: string }> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    const channel = guild.channels.cache.find(
      (candidate) => candidate.name.toLowerCase() === channelName.toLowerCase() && candidate.isSendable(),
    );
    if (!channel?.isSendable()) throw new Error(`sendable channel not found: ${channelName}`);
    const message = await channel.send({
      ...(content ? { content } : {}),
      ...(imagePath ? { files: [imagePath] } : {}),
      allowedMentions: { parse: [] },
    });
    return { id: message.id, url: message.url };
  }

  async readMessages(
    requestedChannel: string,
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
  > {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    const channel = guild.channels.cache.find(
      (candidate) =>
        candidate.isTextBased() &&
        (candidate.id === requestedChannel || candidate.name.toLowerCase() === requestedChannel.toLowerCase()),
    );
    if (!channel?.isTextBased()) throw new Error(`text channel not found: ${requestedChannel}`);
    const messages = await channel.messages.fetch({
      limit,
      ...(beforeMessageId ? { before: beforeMessageId } : {}),
      ...(aroundDate ? { around: SnowflakeUtil.generate({ timestamp: aroundDate }).toString() } : {}),
    });
    return [...messages.values()]
      .toSorted((left, right) => left.createdTimestamp - right.createdTimestamp)
      .map((message) => {
        const images = [...message.attachments.values()].filter(isImageAttachment).map((attachment) => ({
          filename: attachment.name,
          ...(attachment.contentType ? { mime_type: attachment.contentType } : {}),
        }));
        return {
          id: message.id,
          author: message.author.username,
          content: message.content,
          timestamp: message.createdAt.toISOString(),
          url: message.url,
          ...(images.length ? { images } : {}),
        };
      });
  }

  async readImage(
    requestedChannel: string,
    messageId?: string,
  ): Promise<{ messageId: string; url: string; filename: string; mimeType?: string }> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    const channel = guild.channels.cache.find(
      (candidate) =>
        candidate.isTextBased() &&
        (candidate.id === requestedChannel || candidate.name.toLowerCase() === requestedChannel.toLowerCase()),
    );
    if (!channel?.isTextBased()) throw new Error(`text channel not found: ${requestedChannel}`);
    const messages = messageId
      ? [await channel.messages.fetch(messageId)]
      : [...(await channel.messages.fetch({ limit: 20 })).values()];
    for (const message of messages) {
      const attachment = message.attachments.find(isImageAttachment);
      if (attachment) {
        return {
          messageId: message.id,
          url: attachment.url,
          filename: attachment.name,
          ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
        };
      }
    }
    throw new Error(messageId ? `no image in message: ${messageId}` : "no recent image in channel");
  }

  async soundboardSounds(): Promise<Array<{ id: string; name: string; emoji?: string }>> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    return [...(await guild.soundboardSounds.fetch()).values()]
      .filter((sound) => sound.available)
      .map((sound) => ({
        id: sound.soundId,
        name: sound.name,
        ...(sound.emoji ? { emoji: sound.emoji.toString() } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  }

  async playSoundboard(channelName: string, soundId: string): Promise<{ id: string; name: string }> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    const channel = guild.channels.cache.find(
      (candidate) =>
        candidate.type === ChannelType.GuildVoice && candidate.name.toLowerCase() === channelName.toLowerCase(),
    );
    if (channel?.type !== ChannelType.GuildVoice) throw new Error(`voice channel not found: ${channelName}`);
    const sound = await guild.soundboardSounds.fetch(soundId);
    if (!sound.available) throw new Error(`soundboard sound is unavailable: ${soundId}`);
    await channel.sendSoundboardSound(sound);
    return { id: sound.soundId, name: sound.name };
  }

  interrupt(guildId: string): void {
    this.captures.get(guildId)?.interruptSpeech();
  }

  isVoiceQuiet(guildId: string): boolean {
    return this.captures.get(guildId)?.isQuiet() ?? false;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const guildId of this.captures.keys()) this.leaveVoice(guildId);
    this.leaveVoice(this.guildId);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    this.client.destroy();
  }

  private leaveVoice(guildId: string): boolean {
    const capture = this.captures.get(guildId);
    capture?.stop();
    this.captures.delete(guildId);
    this.agent?.clear(guildId);
    const connection = capture?.connection ?? getVoiceConnection(guildId);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
      log("info", "left voice channel");
    }
    return Boolean(connection);
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "voice") return;
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "Команда доступна только на сервере.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (interaction.options.getSubcommand() === "leave") {
        const left = this.leaveVoice(interaction.guildId);
        await interaction.editReply(left ? "Отключился от голосового канала." : "Я не подключён к голосовому каналу.");
        return;
      }

      const channelName = await this.joinVoice(interaction.guild, interaction.options.getString("channel", true));
      await interaction.editReply(`Подключился к **${channelName}**.`);
    } catch (error: unknown) {
      this.leaveVoice(interaction.guildId);
      log("error", "voice command failed", { error: errorMessage(error) });
      await interaction.editReply(`Ошибка: ${errorMessage(error)}`);
    }
  }

  private async joinVoice(guild: Guild, requestedName: string): Promise<string> {
    const channel = guild.channels.cache.find(
      (candidate) => candidate.isVoiceBased() && candidate.name.toLowerCase() === requestedName.toLowerCase(),
    );
    if (!channel) throw new Error(`voice channel not found: ${requestedName}`);

    this.leaveVoice(guild.id);
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on("error", (error) => log("error", "voice connection failed", { error: error.message }));
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    const botUserId = this.client.user?.id;
    if (!botUserId) throw new Error("Discord client is not ready");
    this.captures.set(
      guild.id,
      new DiscordVoiceSession(connection, guild, this.transcriber, botUserId, (transcript) =>
        this.agent?.onTranscript(transcript),
      ),
    );
    log("info", "joined voice channel", { channel: channel.name });
    return channel.name;
  }
}
