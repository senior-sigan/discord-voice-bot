import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Guild, Interaction, VoiceChannel } from "discord.js";
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
  private moving = false;

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

  currentVoiceChannel(): string {
    const id = this.captures.get(this.guildId)?.connection.joinConfig.channelId;
    if (!id) throw new Error("The agent is not connected to a voice channel");
    return id;
  }

  async voiceChannels(): Promise<
    Array<{ id: string; name: string; category: string | null; current: boolean; joinable: boolean }>
  > {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    const current = this.captures.get(this.guildId)?.connection.joinConfig.channelId;
    return [...guild.channels.cache.values()]
      .filter((channel): channel is VoiceChannel => channel.type === ChannelType.GuildVoice && channel.viewable)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        category: channel.parent?.name ?? null,
        current: channel.id === current,
        joinable: channel.joinable && channel.speakable,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  }

  async moveVoice(requested: string, signal?: AbortSignal): Promise<{ id: string; name: string; moved: boolean }> {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Discord bot is stopped");
    if (this.moving) throw new Error("A voice channel move is already in progress");
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    const channel = this.resolveVoiceChannel(guild, requested);
    const capture = this.captures.get(guild.id);
    if (!capture) throw new Error("The agent is not connected; use /voice join first");
    const connection = capture.connection;
    const previousConfig = { ...connection.joinConfig };
    const previousId = previousConfig.channelId;
    if (!previousId) throw new Error("The current voice channel is unknown");
    if (previousId === channel.id && connection.state.status === VoiceConnectionStatus.Ready) {
      return { id: channel.id, name: channel.name, moved: false };
    }
    if (!channel.joinable || !channel.speakable)
      throw new Error("Cannot join or speak in the requested channel (permissions or channel capacity)");

    this.moving = true;
    try {
      capture.stop();
      this.captures.delete(guild.id);
      // Leave transport only: clearing the agent here would abort this tool's own run.
      // disconnect() also prevents entersState(Ready) from accepting the old channel's Ready state.
      if (!connection.disconnect() || !connection.rejoin({ ...previousConfig, channelId: channel.id })) {
        throw new Error("Discord rejected the voice channel move");
      }
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : 20_000,
      );
      signal?.throwIfAborted();
      this.attachVoice(guild, connection);
      log("info", "moved voice channel", { from: previousId, to: channel.id, channel: channel.name });
      return { id: channel.id, name: channel.name, moved: true };
    } catch (error) {
      // A concurrent /voice leave or shutdown destroys this connection; never resurrect it.
      if (!this.stopped && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try {
          if (!connection.disconnect() || !connection.rejoin(previousConfig))
            throw new Error("Voice rollback rejected");
          await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
          this.attachVoice(guild, connection);
        } catch (restoreError) {
          if ((connection.state.status as VoiceConnectionStatus) !== VoiceConnectionStatus.Destroyed)
            connection.destroy();
          log("error", "voice channel restore failed", { error: errorMessage(restoreError) });
        }
      }
      throw error;
    } finally {
      this.moving = false;
    }
  }

  async voiceMembers(channelName: string): Promise<Array<{ id: string; name: string; bot: boolean }>> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`Discord guild not found: ${this.guildId}`);
    const channel = this.resolveVoiceChannel(guild, channelName);
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
    const channel = this.resolveVoiceChannel(guild, channelName);
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
      log("error", "voice command failed", { error: errorMessage(error) });
      await interaction.editReply(`Ошибка: ${errorMessage(error)}`);
    }
  }

  private async joinVoice(guild: Guild, requestedName: string): Promise<string> {
    const channel = this.resolveVoiceChannel(guild, requestedName);
    if (!channel.joinable || !channel.speakable) throw new Error("Cannot join or speak in the requested channel");

    this.leaveVoice(guild.id);
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on("error", (error) => log("error", "voice connection failed", { error: error.message }));
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.attachVoice(guild, connection);
      log("info", "joined voice channel", { channel: channel.name });
      return channel.name;
    } catch (error) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw error;
    }
  }

  private attachVoice(guild: Guild, connection: VoiceConnection): void {
    if (this.stopped || connection.state.status !== VoiceConnectionStatus.Ready)
      throw new Error("Voice connection is no longer ready");
    const botUserId = this.client.user?.id;
    if (!botUserId) throw new Error("Discord client is not ready");
    this.captures.set(
      guild.id,
      new DiscordVoiceSession(connection, guild, this.transcriber, botUserId, (transcript) =>
        this.agent?.onTranscript(transcript),
      ),
    );
  }

  private resolveVoiceChannel(guild: Guild, requested: string): VoiceChannel {
    const name = requested.trim().toLocaleLowerCase("ru-RU");
    if (!name) throw new Error("channel must not be blank");
    const channels = [...guild.channels.cache.values()].filter(
      (channel): channel is VoiceChannel => channel.type === ChannelType.GuildVoice && channel.viewable,
    );
    const byId = channels.find((channel) => channel.id === name);
    if (byId) return byId;
    const matches = channels.filter((channel) => channel.name.toLocaleLowerCase("ru-RU") === name);
    if (matches.length > 1)
      throw new Error(
        `Ambiguous voice channel; use an ID: ${matches.map((channel) => `${channel.name} (${channel.id})`).join(", ")}`,
      );
    const channel = matches[0];
    if (!channel) throw new Error(`Voice channel not found: ${requested}`);
    return channel;
  }
}
