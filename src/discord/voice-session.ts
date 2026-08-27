import { Readable } from "node:stream";

import opus from "@discordjs/opus";
import type { AudioPlayer, AudioReceiveStream, VoiceConnection } from "@discordjs/voice";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  StreamType,
} from "@discordjs/voice";
import type { Guild } from "discord.js";
import sherpa from "sherpa-onnx-node";

import { floatMonoToStereoPcm, stereoPcmToMono } from "../audio.js";
import { errorMessage, log } from "../common.js";
import type { Transcriber, Transcript } from "../stt/index.js";
import { SAMPLE_RATE } from "../stt/index.js";
import type { VoiceAudio } from "../tts/index.js";

const { OpusEncoder } = opus;
const { LinearResampler } = sherpa;

export class DiscordVoiceSession {
  private readonly active = new Map<string, AudioReceiveStream>();
  private readonly onStart: (userId: string) => void;
  private readonly player: AudioPlayer;
  private readonly pendingAudio = new Set<VoiceAudio>();
  private playbackQueue: Promise<void> = Promise.resolve();
  private playbackGeneration = 0;
  private stopped = false;

  constructor(
    readonly connection: VoiceConnection,
    private readonly guild: Guild,
    private readonly transcriber: Transcriber,
    private readonly botUserId: string,
    private readonly onTranscript: (transcript: Transcript) => void,
  ) {
    this.player = createAudioPlayer();
    if (!connection.subscribe(this.player)) throw new Error("Failed to subscribe audio player");
    this.player.on("error", (error) =>
      log("error", "audio playback failed", {
        error: error.message,
      }),
    );
    this.onStart = (userId) => this.capture(userId);
    connection.receiver.speaking.on("start", this.onStart);
  }

  private capture(userId: string): void {
    if (userId === this.botUserId || this.active.has(userId)) return;
    const user = this.guild.members.cache.get(userId)?.displayName ?? "unknown";
    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterInactivity, duration: 400 },
    });
    const decoder = new OpusEncoder(48_000, 2);
    const resampler = new LinearResampler(48_000, SAMPLE_RATE);
    const chunks: Float32Array[] = [];
    let sampleCount = 0;
    let finished = false;
    this.active.set(userId, stream);

    stream.on("data", (packet: Buffer) => {
      try {
        const samples = resampler.resample(stereoPcmToMono(decoder.decode(packet)));
        if (samples.length) {
          chunks.push(samples);
          sampleCount += samples.length;
        }
      } catch (error) {
        log("error", "audio packet failed", { user, error: errorMessage(error) });
      }
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      this.active.delete(userId);
      try {
        const tail = resampler.flush(new Float32Array());
        if (tail.length) {
          chunks.push(tail);
          sampleCount += tail.length;
        }
      } catch (error) {
        log("error", "audio resampler flush failed", { user, error: errorMessage(error) });
      }
      if (sampleCount < SAMPLE_RATE / 5) return;

      const samples = new Float32Array(sampleCount);
      let offset = 0;
      for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      this.transcriber.enqueue(
        samples,
        { guildId: this.guild.id, userId, user, timestamp: new Date().toISOString() },
        this.onTranscript,
      );
    };

    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", (error: Error) => {
      log("error", "audio stream failed", { user, error: error.message });
      finish();
    });
  }

  speak(audio: VoiceAudio): Promise<void> {
    const generation = this.playbackGeneration;
    this.pendingAudio.add(audio);
    const next = this.playbackQueue
      .then(() => {
        if (generation !== this.playbackGeneration || this.stopped) {
          if ("stream" in audio) audio.cancel();
          return;
        }
        return this.playNow(audio, generation);
      })
      .finally(() => this.pendingAudio.delete(audio));
    this.playbackQueue = next.catch(() => undefined);
    return next;
  }

  isQuiet(): boolean {
    return (
      !this.stopped &&
      this.active.size === 0 &&
      this.pendingAudio.size === 0 &&
      this.player.state.status === AudioPlayerStatus.Idle
    );
  }

  private async playNow(audio: VoiceAudio, generation: number): Promise<void> {
    if (this.stopped) return;
    if ("stream" in audio) {
      const resource = createAudioResource(audio.stream, { inputType: StreamType.Raw });
      this.player.play(resource);
      await entersState(this.player, AudioPlayerStatus.Playing, 5_000).catch((error: unknown) => {
        if (generation === this.playbackGeneration) throw error;
      });
      if (generation !== this.playbackGeneration) return;
      const duration = await audio.done;
      if (generation !== this.playbackGeneration) return;
      await entersState(this.player, AudioPlayerStatus.Idle, Math.max(10_000, Math.ceil(duration * 2_000)));
      return;
    }
    const resampler = new LinearResampler(audio.sampleRate, 48_000);
    const samples = resampler.flush(audio.samples);
    const resource = createAudioResource(Readable.from([floatMonoToStereoPcm(samples)]), {
      inputType: StreamType.Raw,
    });
    this.player.play(resource);
    await entersState(this.player, AudioPlayerStatus.Playing, 5_000).catch((error: unknown) => {
      if (generation === this.playbackGeneration) throw error;
    });
    if (generation !== this.playbackGeneration) return;
    await entersState(
      this.player,
      AudioPlayerStatus.Idle,
      Math.max(10_000, Math.ceil((samples.length / 48_000) * 2_000)),
    );
  }

  interruptSpeech(): void {
    this.playbackGeneration++;
    for (const audio of this.pendingAudio) {
      if ("stream" in audio) audio.cancel();
    }
    this.player.stop(true);
  }

  stop(): void {
    this.stopped = true;
    this.connection.receiver.speaking.off("start", this.onStart);
    this.interruptSpeech();
    for (const stream of this.active.values()) stream.destroy();
    this.active.clear();
  }
}
