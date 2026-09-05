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
import type { SpeechInput } from "../stt/types.js";
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
  private playbackAbort = new AbortController();
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly inputs = new Map<string, SpeechInput>();

  constructor(
    readonly connection: VoiceConnection,
    private readonly guild: Guild,
    private readonly transcriber: Transcriber,
    private readonly botUserId: string,
    private readonly onTranscript: (transcript: Transcript) => void,
  ) {
    this.player = createAudioPlayer({ behaviors: { maxMissedFrames: 500 } });
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
    if (this.stopped || userId === this.botUserId || this.active.has(userId)) return;
    const user = this.guild.members.cache.get(userId)?.displayName ?? "unknown";
    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterInactivity, duration: 500 },
    });
    const decoder = new OpusEncoder(48_000, 2);
    const resampler = new LinearResampler(48_000, SAMPLE_RATE);
    let input = this.inputs.get(userId);
    if (!input) {
      input = this.transcriber.createInput(
        { guildId: this.guild.id, userId, user },
        (transcript) => {
          if (!this.stopped) this.onTranscript(transcript);
        },
        this.abort.signal,
      );
      this.inputs.set(userId, input);
    }
    const speech = input;
    let finished = false;
    this.active.set(userId, stream);

    stream.on("data", (packet: Buffer) => {
      try {
        const samples = resampler.resample(stereoPcmToMono(decoder.decode(packet)));
        speech.accept(samples);
      } catch (error) {
        log("error", "audio packet failed", { user, error: errorMessage(error) });
      }
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      this.active.delete(userId);
      try {
        if (!this.stopped) speech.accept(resampler.flush(new Float32Array()));
        speech.finish();
      } catch (error) {
        log("error", "audio input flush failed", { user, error: errorMessage(error) });
      }
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
          throw new DOMException("Speech interrupted", "AbortError");
        }
        return this.playNow(audio, generation);
      })
      .catch((error: unknown) => {
        if ("stream" in audio) audio.cancel();
        throw error;
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
    const waits = new AbortController();
    const signal = AbortSignal.any([this.playbackAbort.signal, waits.signal, AbortSignal.timeout(180_000)]);
    const resource =
      "stream" in audio
        ? createAudioResource(audio.stream, { inputType: StreamType.Raw })
        : createAudioResource(
            Readable.from([floatMonoToStereoPcm(new LinearResampler(audio.sampleRate, 48_000).flush(audio.samples))]),
            { inputType: StreamType.Raw },
          );
    let onError = (_error: Error): void => undefined;
    let onAbort = (): void => undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      onError = reject;
      onAbort = () => reject(signal.reason);
      this.player.once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      signal.throwIfAborted();
      this.player.play(resource);
      const playback = (async () => {
        const firstAudio = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
        await entersState(this.player, AudioPlayerStatus.Playing, firstAudio).catch((error: unknown) => {
          throw firstAudio.aborted ? firstAudio.reason : error;
        });
        await Promise.all([
          "stream" in audio ? audio.done : Promise.resolve(),
          entersState(this.player, AudioPlayerStatus.Idle, signal).then(() => {
            if ("stream" in audio && !audio.stream.readableEnded) {
              throw new Error("Playback ended before the TTS stream was consumed");
            }
          }),
        ]);
      })();
      await Promise.race([playback, failed]);
      signal.throwIfAborted();
    } catch (error) {
      if ("stream" in audio) audio.cancel();
      if (generation === this.playbackGeneration) this.player.stop(true);
      throw signal.aborted ? signal.reason : error;
    } finally {
      this.player.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      waits.abort();
    }
  }

  interruptSpeech(): void {
    this.playbackGeneration++;
    this.playbackAbort.abort();
    this.playbackAbort = new AbortController();
    for (const audio of this.pendingAudio) {
      if ("stream" in audio) audio.cancel();
    }
    this.player.stop(true);
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.connection.receiver.speaking.off("start", this.onStart);
    this.interruptSpeech();
    for (const stream of this.active.values()) stream.destroy();
    this.active.clear();
    this.inputs.clear();
  }
}
