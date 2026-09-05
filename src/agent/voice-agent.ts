import type { GeneratedAudio } from "sherpa-onnx-node";

import { errorMessage, log } from "../common.js";
import type { AppConfig } from "../config.js";
import type { Transcript } from "../stt/index.js";
import type { Tts, VoiceAudio } from "../tts/index.js";
import {
  type AutoParticipationMode,
  type AutoParticipationVerdict,
  autoParticipationCommand,
} from "./auto-participation.js";
import type { HistoryEntry, HistoryStore } from "./history.js";
import type { AgentRuntime } from "./runtime.js";
import { hasStopCommand, hasWakeWord, isWakeOnly } from "./transcript.js";

const GREETING_COOLDOWN_MS = 30 * 60 * 1_000;

export function formatVoiceContextTime(date: Date, timezone: string): string {
  try {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .map(({ type, value }) => [type, value]),
    );
    return `${values["year"]}-${values["month"]}-${values["day"]} ${values["hour"]}:${values["minute"]}:${values["second"]}`;
  } catch {
    return date.toISOString();
  }
}

export class VoiceAgent {
  private readonly responding = new Set<string>();
  private readonly lastWake = new Map<string, { at: number; userId: string; user: string; text: string }>();
  private readonly generations = new Map<string, number>();
  private readonly conversationVersions = new Map<string, number>();
  private readonly autoParticipationTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastAutoParticipationCheckAt = new Map<string, number>();
  private readonly lastAutoParticipationResponseAt = new Map<string, number>();
  private readonly lastGreetingAt = new Map<string, number>();
  private readonly followUpWindows = new Map<string, { userId: string; expiresAt: number; activation: boolean }>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly history: HistoryStore,
    private readonly tts: Tts,
    private readonly fillers: () => readonly [GeneratedAudio, ...GeneratedAudio[]],
    private readonly speak: (guildId: string, audio: VoiceAudio) => Promise<void>,
    private readonly stopSpeaking: (guildId: string) => void,
    private readonly config: AppConfig,
    private readonly isVoiceQuiet: (guildId: string) => boolean,
  ) {
    log("info", "auto participation configured", { mode: config.settings.agent.auto_participation.mode });
    log("info", "voice greetings configured", { enabled: config.settings.agent.greet_on_join });
  }

  onTranscript(transcript: Transcript): void {
    this.history.appendMessage(
      "transcript",
      transcript.user,
      transcript.text,
      new Date(transcript.timestamp),
      transcript.userId,
    );
    const version = (this.conversationVersions.get(transcript.guildId) ?? 0) + 1;
    this.conversationVersions.set(transcript.guildId, version);
    this.cancelAutoParticipationTimer(transcript.guildId);
    const wakeWords = this.config.settings.agent.wake_words;
    if (hasStopCommand(transcript.text, wakeWords)) {
      this.generations.set(transcript.guildId, (this.generations.get(transcript.guildId) ?? 0) + 1);
      this.responding.delete(transcript.guildId);
      this.followUpWindows.delete(transcript.guildId);
      this.lastWake.delete(transcript.guildId);
      this.runtime.abort();
      this.stopSpeaking(transcript.guildId);
      log("info", "speech interrupted", { user: transcript.user });
      return;
    }
    const wakeWord = hasWakeWord(transcript.text, wakeWords);
    const mode = wakeWord ? autoParticipationCommand(transcript.text) : undefined;
    if (mode) {
      this.setAutoParticipationMode(transcript, mode);
      return;
    }
    if (!wakeWord) {
      if (this.handleFollowUp(transcript)) return;
      this.scheduleAutoParticipation(transcript.guildId, version);
      return;
    }
    const wakeOnly = isWakeOnly(transcript.text, wakeWords);
    const now = Date.now();
    const previous = this.lastWake.get(transcript.guildId);
    if (
      previous?.userId === transcript.userId &&
      previous.text === transcript.text &&
      now - previous.at < this.config.settings.agent.wake_cooldown_ms
    )
      return;
    this.followUpWindows.delete(transcript.guildId);
    this.lastWake.set(transcript.guildId, {
      at: now,
      userId: transcript.userId,
      user: transcript.user,
      text: transcript.text,
    });
    if (this.responding.has(transcript.guildId)) {
      this.stopSpeaking(transcript.guildId);
      if (!wakeOnly && this.runtime.steer(transcript.user, transcript.text)) return;
      // The LLM may already be done and playing audio, or still waiting in its queue.
      this.runtime.abort();
    }
    const generation = (this.generations.get(transcript.guildId) ?? 0) + 1;
    this.generations.set(transcript.guildId, generation);
    this.responding.add(transcript.guildId);
    const fillers = this.fillers();
    const filler = fillers.at(Math.floor(Math.random() * fillers.length)) ?? fillers[0];
    void this.speak(transcript.guildId, filler).catch((error: unknown) => {
      log("error", "filler playback failed", { error: errorMessage(error) });
    });
    if (wakeOnly) {
      this.responding.delete(transcript.guildId);
      this.openFollowUp(transcript, true);
      return;
    }
    const context = this.contextFor(this.history.entries);
    log("info", "wake word detected", {
      user: transcript.user,
      context_messages: this.history.entries.length,
    });
    void this.respond(transcript.guildId, context, generation)
      .then((answered) => {
        if (answered && this.generations.get(transcript.guildId) === generation) this.openFollowUp(transcript);
      })
      .catch((error: unknown) => log("error", "voice response failed", { error: errorMessage(error) }))
      .finally(() => {
        if (this.generations.get(transcript.guildId) === generation) this.responding.delete(transcript.guildId);
      });
  }

  async runScheduledTask(guildId: string, instruction: string): Promise<void> {
    log("info", "scheduled task started", { instruction });
    const generation = this.generations.get(guildId) ?? 0;
    const answer = await this.runtime.completeScheduled(instruction);
    await this.deliver(guildId, answer, generation);
    log("info", "scheduled task completed", { answer });
  }

  async speakDirectly(guildId: string, text: string): Promise<void> {
    await this.deliver(guildId, text);
  }

  onVoiceMemberJoined(guildId: string, userId: string, user: string, channel: string): void {
    this.history.appendVoiceMemberJoined(user, userId, channel);
    this.conversationVersions.set(guildId, (this.conversationVersions.get(guildId) ?? 0) + 1);
    this.cancelAutoParticipationTimer(guildId);
    log("info", "voice member joined", { guild_id: guildId, user, user_id: userId, channel });

    const now = Date.now();
    if (
      !this.config.settings.agent.greet_on_join ||
      this.responding.has(guildId) ||
      now - (this.lastGreetingAt.get(userId) ?? 0) < GREETING_COOLDOWN_MS
    ) {
      return;
    }
    this.lastGreetingAt.set(userId, now);
    const generation = (this.generations.get(guildId) ?? 0) + 1;
    this.generations.set(guildId, generation);
    this.responding.add(guildId);
    const context = this.contextFor(this.history.entries);
    void this.respond(
      guildId,
      context,
      generation,
      `Коротко и естественно поприветствовать вошедшего участника ${user}. Не упоминать userId, профиль, сохранённые сведения или сам механизм события.`,
    )
      .catch((error: unknown) => log("error", "voice greeting failed", { user, error: errorMessage(error) }))
      .finally(() => {
        if (this.generations.get(guildId) === generation) this.responding.delete(guildId);
      });
  }

  clear(guildId: string): void {
    this.runtime.abort();
    this.stopSpeaking(guildId);
    this.cancelAutoParticipationTimer(guildId);
    this.generations.set(guildId, (this.generations.get(guildId) ?? 0) + 1);
    this.conversationVersions.set(guildId, (this.conversationVersions.get(guildId) ?? 0) + 1);
    this.responding.delete(guildId);
    this.followUpWindows.delete(guildId);
    this.lastWake.delete(guildId);
    this.lastAutoParticipationCheckAt.delete(guildId);
    this.lastAutoParticipationResponseAt.delete(guildId);
  }

  private contextFor(history: HistoryEntry[], since = Number.NEGATIVE_INFINITY): string {
    const limit = this.config.settings.agent.context_chars;
    const timezone = this.config.settings.agent.timezone;
    const now = `Текущий момент: ${formatVoiceContextTime(new Date(), timezone)} (${timezone}).`;
    const lines: string[] = [];
    let length = now.length;
    for (const entry of history.toReversed()) {
      if (Date.parse(entry.timestamp) < since) break;
      if (entry.kind === "auto_participation") continue;
      if (entry.kind === "assistant" && entry.playback && entry.playback !== "played") continue;
      const timestamp = formatVoiceContextTime(new Date(entry.timestamp), timezone);
      const line =
        entry.kind === "tool"
          ? `[${timestamp}] Олег вызвал ${entry.tool} с аргументами ${JSON.stringify(entry.arguments ?? {})}`
          : `[${timestamp}] ${entry.speaker}: ${entry.text}`;
      if (lines.length && length + line.length > limit) break;
      lines.unshift(line);
      length += line.length;
    }
    return [now, ...lines].join("\n");
  }

  private async respond(
    guildId: string,
    context: string,
    generation: number,
    proactiveIntent?: string,
    followUp?: Transcript,
  ): Promise<boolean> {
    const started = performance.now();
    const announced = new Set<string>();
    let announcements: Promise<void> = Promise.resolve();
    let acceptingAnnouncements = true;
    const onToolCall = (tool: string, args: string, suggestion: string | undefined): void => {
      if (!acceptingAnnouncements || tool.startsWith("discord_soundboard_") || tool === "keep_silence") return;
      if (announced.has(tool)) return;
      announced.add(tool);
      const version = this.conversationVersions.get(guildId);
      announcements = announcements
        .then(async () => {
          const text =
            suggestion && suggestion.length <= 200
              ? suggestion
              : await this.runtime.toolAnnouncement(context, tool, args);
          if (
            !acceptingAnnouncements ||
            this.generations.get(guildId) !== generation ||
            this.conversationVersions.get(guildId) !== version
          )
            return;
          log("info", "tool announcement", { tool, text });
          await this.deliver(guildId, text, generation);
        })
        .catch((error: unknown) =>
          log("error", "tool announcement failed", {
            tool,
            error: errorMessage(error),
          }),
        );
    };
    const answer = await (followUp
      ? this.runtime.completeFollowUp(context, followUp.user, followUp.text, onToolCall)
      : proactiveIntent
        ? this.runtime.completeProactive(context, proactiveIntent, onToolCall)
        : this.runtime.complete(context, onToolCall)
    ).finally(() => {
      acceptingAnnouncements = false;
    });
    await announcements;
    if (this.generations.get(guildId) !== generation) return false;
    if (answer === undefined) {
      log("info", "follow-up kept silent", { user: followUp?.user, user_id: followUp?.userId });
      return false;
    }
    log("info", "LLM response", {
      elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
      text: answer,
    });
    await this.deliver(guildId, answer, generation);
    return true;
  }

  private async deliver(guildId: string, text: string, generation = this.generations.get(guildId) ?? 0): Promise<void> {
    const current = () => (this.generations.get(guildId) ?? 0) === generation;
    const sentences = new Intl.Segmenter("ru", { granularity: "sentence" }).segment(text);
    for (const { segment } of sentences) {
      if (!current()) throw new DOMException("Speech superseded", "AbortError");
      if (!segment.trim()) continue;
      try {
        await this.speak(guildId, this.tts.synthesize(segment.trim()));
        if (!current()) throw new DOMException("Speech superseded", "AbortError");
        this.history.appendSpeech(segment.trim(), "played");
      } catch (error) {
        // ponytail: only completed sentences are confirmed; add word alignment if partial phrases matter.
        const interrupted = !current() || (error instanceof Error && error.name === "AbortError");
        this.history.appendSpeech(segment.trim(), interrupted ? "interrupted" : "failed");
        throw error;
      }
    }
  }

  private openFollowUp(transcript: Transcript, activation = false): void {
    const duration = activation ? 30_000 : this.config.settings.agent.follow_up_window_ms;
    if (!duration) return;
    const speaker = this.lastWake.get(transcript.guildId) ?? transcript;
    this.followUpWindows.set(transcript.guildId, {
      userId: speaker.userId,
      expiresAt: Date.now() + duration,
      activation,
    });
    log("info", "follow-up window opened", {
      user: speaker.user,
      user_id: speaker.userId,
      duration_ms: duration,
    });
  }

  private handleFollowUp(transcript: Transcript): boolean {
    const window = this.followUpWindows.get(transcript.guildId);
    if (!window || window.userId !== transcript.userId) return false;
    this.followUpWindows.delete(transcript.guildId);
    if (window.expiresAt < Date.now()) return false;

    const generation = (this.generations.get(transcript.guildId) ?? 0) + 1;
    this.generations.set(transcript.guildId, generation);
    this.responding.add(transcript.guildId);
    const context = this.contextFor(this.history.entries);
    log("info", "follow-up candidate", { user: transcript.user, user_id: transcript.userId, text: transcript.text });
    void this.respond(transcript.guildId, context, generation, undefined, window.activation ? undefined : transcript)
      .then((answered) => {
        if (answered && this.generations.get(transcript.guildId) === generation) this.openFollowUp(transcript);
      })
      .catch((error: unknown) => log("error", "follow-up response failed", { error: errorMessage(error) }))
      .finally(() => {
        if (this.generations.get(transcript.guildId) === generation) this.responding.delete(transcript.guildId);
      });
    return true;
  }

  private setAutoParticipationMode(transcript: Transcript, mode: AutoParticipationMode): void {
    this.config.setOverride("agent.auto_participation.mode", mode);
    const text =
      mode === "on"
        ? "Автоматическое участие включено."
        : mode === "shadow"
          ? "Теневой режим автоматического участия включён."
          : "Автоматическое участие выключено.";
    log("info", "auto participation mode changed", { mode, user: transcript.user, user_id: transcript.userId });
    void this.deliver(transcript.guildId, text).catch((error: unknown) =>
      log("error", "auto participation acknowledgement failed", { error: errorMessage(error) }),
    );
  }

  private scheduleAutoParticipation(guildId: string, version: number): void {
    const settings = this.config.settings.agent.auto_participation;
    if (settings.mode === "off" || this.responding.has(guildId)) return;
    const now = Date.now();
    const delay = Math.max(
      settings.silence_ms,
      settings.check_interval_ms - (now - (this.lastAutoParticipationCheckAt.get(guildId) ?? 0)),
      settings.cooldown_ms - (now - (this.lastAutoParticipationResponseAt.get(guildId) ?? 0)),
    );
    const timer = setTimeout(() => {
      this.autoParticipationTimers.delete(guildId);
      void this.considerAutoParticipation(guildId, version).catch((error: unknown) =>
        log("error", "auto participation failed", { error: errorMessage(error) }),
      );
    }, delay);
    timer.unref();
    this.autoParticipationTimers.set(guildId, timer);
  }

  private cancelAutoParticipationTimer(guildId: string): void {
    const timer = this.autoParticipationTimers.get(guildId);
    if (timer) clearTimeout(timer);
    this.autoParticipationTimers.delete(guildId);
  }

  private async considerAutoParticipation(guildId: string, version: number): Promise<void> {
    const settings = this.config.settings.agent.auto_participation;
    const mode = settings.mode;
    if (
      mode === "off" ||
      this.conversationVersions.get(guildId) !== version ||
      this.responding.has(guildId) ||
      !this.isVoiceQuiet(guildId)
    ) {
      return;
    }
    this.lastAutoParticipationCheckAt.set(guildId, Date.now());
    const context = this.contextFor(this.history.entries, Date.now() - settings.context_ms);
    let verdict: AutoParticipationVerdict;
    try {
      verdict = await this.runtime.decideAutoParticipation(context);
    } catch (error) {
      const message = errorMessage(error);
      log("error", "auto participation decision", {
        mode,
        model: this.runtime.modelName,
        decision: "silent",
        reason: "judge_error",
        error: message,
      });
      this.history.appendAutoParticipation({
        mode,
        guild_id: guildId,
        context,
        decision: "silent",
        reason: "judge_error",
        model: this.runtime.modelName,
        acted: false,
        error: message,
      });
      return;
    }

    const discarded = this.discardedAutoParticipationReason(guildId, mode, version);
    const acted =
      mode === "on" && verdict.decision === "join" && verdict.replyIntent !== undefined && discarded === undefined;
    log("info", "auto participation decision", {
      mode,
      model: verdict.model,
      decision: verdict.decision,
      reason: verdict.reason,
      reply_intent: verdict.replyIntent,
      acted,
      discarded,
    });
    this.history.appendAutoParticipation({
      mode,
      guild_id: guildId,
      context,
      decision: verdict.decision,
      reason: verdict.reason,
      ...(verdict.replyIntent ? { reply_intent: verdict.replyIntent } : {}),
      model: verdict.model,
      acted,
      ...(discarded ? { discarded } : {}),
    });
    if (!acted || verdict.replyIntent === undefined) return;

    const generation = (this.generations.get(guildId) ?? 0) + 1;
    this.generations.set(guildId, generation);
    this.responding.add(guildId);
    this.lastAutoParticipationResponseAt.set(guildId, Date.now());
    try {
      await this.respond(guildId, context, generation, verdict.replyIntent);
    } catch (error) {
      log("error", "auto participation response failed", { error: errorMessage(error) });
    } finally {
      if (this.generations.get(guildId) === generation) this.responding.delete(guildId);
    }
  }

  private discardedAutoParticipationReason(
    guildId: string,
    mode: AutoParticipationMode,
    version: number,
  ): "mode_changed" | "busy" | "conversation_changed" | "speech_started" | undefined {
    if (this.config.settings.agent.auto_participation.mode !== mode) return "mode_changed";
    if (this.responding.has(guildId)) return "busy";
    if (this.conversationVersions.get(guildId) !== version) return "conversation_changed";
    if (!this.isVoiceQuiet(guildId)) return "speech_started";
    return undefined;
  }
}
