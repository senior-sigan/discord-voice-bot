import type { GeneratedAudio } from "sherpa-onnx-node";

import { errorMessage, log } from "../common.js";
import type { Transcript } from "../stt/index.js";
import type { Tts, VoiceAudio } from "../tts/index.js";
import {
  type AutoParticipationMode,
  type AutoParticipationVerdict,
  autoParticipationCommand,
} from "./auto-participation.js";
import type { HistoryEntry, HistoryStore } from "./history.js";
import type { AgentRuntime } from "./runtime.js";
import { hasStopCommand, hasWakeWord } from "./transcript.js";

export class VoiceAgent {
  private readonly responding = new Set<string>();
  private readonly proactive = new Set<string>();
  private readonly lastWakeAt = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly conversationVersions = new Map<string, number>();
  private readonly autoParticipationTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastAutoParticipationCheckAt = new Map<string, number>();
  private readonly lastAutoParticipationResponseAt = new Map<string, number>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly history: HistoryStore,
    private readonly tts: Tts,
    private readonly fillers: readonly [GeneratedAudio, ...GeneratedAudio[]],
    private readonly speak: (guildId: string, audio: VoiceAudio) => Promise<void>,
    private readonly stopSpeaking: (guildId: string) => void,
    private autoParticipationMode: AutoParticipationMode,
    private readonly isVoiceQuiet: (guildId: string) => boolean,
  ) {
    log("info", "auto participation configured", { mode: autoParticipationMode });
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
    if (this.proactive.delete(transcript.guildId)) {
      this.generations.set(transcript.guildId, (this.generations.get(transcript.guildId) ?? 0) + 1);
      this.responding.delete(transcript.guildId);
      this.stopSpeaking(transcript.guildId);
      log("info", "auto participation response interrupted", { user: transcript.user });
    }
    if (hasStopCommand(transcript.text)) {
      this.generations.set(transcript.guildId, (this.generations.get(transcript.guildId) ?? 0) + 1);
      this.responding.delete(transcript.guildId);
      this.runtime.abort();
      this.stopSpeaking(transcript.guildId);
      log("info", "speech interrupted", { user: transcript.user });
      return;
    }
    const wakeWord = hasWakeWord(transcript.text);
    const mode = wakeWord ? autoParticipationCommand(transcript.text) : undefined;
    if (mode) {
      this.setAutoParticipationMode(transcript, mode);
      return;
    }
    if (!wakeWord) {
      this.scheduleAutoParticipation(transcript.guildId, version);
      return;
    }

    const now = Date.now();
    const cooldown = Math.max(0, Number(process.env["WAKE_COOLDOWN_MS"] ?? 5_000) || 5_000);
    if (this.responding.has(transcript.guildId) || now - (this.lastWakeAt.get(transcript.guildId) ?? 0) < cooldown) {
      return;
    }
    const generation = (this.generations.get(transcript.guildId) ?? 0) + 1;
    this.generations.set(transcript.guildId, generation);
    this.responding.add(transcript.guildId);
    this.lastWakeAt.set(transcript.guildId, now);
    const filler = this.fillers.at(Math.floor(Math.random() * this.fillers.length)) ?? this.fillers[0];
    void this.speak(transcript.guildId, filler).catch((error: unknown) => {
      log("error", "filler playback failed", { error: errorMessage(error) });
    });
    const context = this.contextFor(this.history.entries);
    log("info", "wake word detected", {
      user: transcript.user,
      context_messages: this.history.entries.length,
    });
    void this.respond(transcript.guildId, context, generation)
      .catch((error: unknown) => log("error", "voice response failed", { error: errorMessage(error) }))
      .finally(() => {
        if (this.generations.get(transcript.guildId) === generation) this.responding.delete(transcript.guildId);
      });
  }

  async runScheduledTask(guildId: string, instruction: string): Promise<void> {
    log("info", "scheduled task started", { instruction });
    const answer = await this.runtime.completeScheduled(instruction);
    this.history.appendMessage("assistant", "Олег", answer);
    await this.speak(guildId, this.tts.synthesize(answer));
    log("info", "scheduled task completed", { answer });
  }

  clear(guildId: string): void {
    this.cancelAutoParticipationTimer(guildId);
    this.generations.set(guildId, (this.generations.get(guildId) ?? 0) + 1);
    this.conversationVersions.set(guildId, (this.conversationVersions.get(guildId) ?? 0) + 1);
    this.responding.delete(guildId);
    this.proactive.delete(guildId);
    this.lastWakeAt.delete(guildId);
    this.lastAutoParticipationCheckAt.delete(guildId);
    this.lastAutoParticipationResponseAt.delete(guildId);
  }

  private contextFor(history: HistoryEntry[], since = Number.NEGATIVE_INFINITY): string {
    const limit = Math.max(1_000, Number(process.env["LLM_CONTEXT_CHARS"] ?? 12_000) || 12_000);
    const lines: string[] = [];
    let length = 0;
    for (const entry of history.toReversed()) {
      if (Date.parse(entry.timestamp) < since) break;
      if (entry.kind === "auto_participation") continue;
      const line =
        entry.kind === "tool"
          ? `[${entry.time}] Олег вызвал ${entry.tool} с аргументами ${JSON.stringify(entry.arguments ?? {})}`
          : `[${entry.time}] ${entry.speaker}: ${entry.text}`;
      if (lines.length && length + line.length > limit) break;
      lines.unshift(line);
      length += line.length;
    }
    return lines.join("\n");
  }

  private async respond(guildId: string, context: string, generation: number, proactiveIntent?: string): Promise<void> {
    const started = performance.now();
    const announced = new Set<string>();
    const onToolCall = (tool: string, args: string, suggestion: string | undefined): void => {
      if (tool.startsWith("discord_soundboard_")) return;
      if (announced.has(tool)) return;
      announced.add(tool);
      void (async () => {
        const text =
          suggestion && suggestion.length <= 200
            ? suggestion
            : await this.runtime.toolAnnouncement(context, tool, args);
        if (this.generations.get(guildId) !== generation) return;
        log("info", "tool announcement", { tool, text });
        await this.speak(guildId, this.tts.synthesize(text));
      })().catch((error: unknown) =>
        log("error", "tool announcement failed", {
          tool,
          error: errorMessage(error),
        }),
      );
    };
    const answer = proactiveIntent
      ? await this.runtime.completeProactive(context, proactiveIntent, onToolCall)
      : await this.runtime.complete(context, onToolCall);
    if (this.generations.get(guildId) !== generation) return;
    log("info", "LLM response", {
      elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
      text: answer,
    });
    this.history.appendMessage("assistant", "Олег", answer);
    await this.speak(guildId, this.tts.synthesize(answer));
  }

  private setAutoParticipationMode(transcript: Transcript, mode: AutoParticipationMode): void {
    this.autoParticipationMode = mode;
    const text =
      mode === "on"
        ? "Автоматическое участие включено."
        : mode === "shadow"
          ? "Теневой режим автоматического участия включён."
          : "Автоматическое участие выключено.";
    this.history.appendMessage("assistant", "Олег", text);
    log("info", "auto participation mode changed", { mode, user: transcript.user, user_id: transcript.userId });
    void (async () => this.speak(transcript.guildId, this.tts.synthesize(text)))().catch((error: unknown) =>
      log("error", "auto participation acknowledgement failed", { error: errorMessage(error) }),
    );
  }

  private scheduleAutoParticipation(guildId: string, version: number): void {
    if (this.autoParticipationMode === "off" || this.responding.has(guildId)) return;
    const now = Date.now();
    const delay = Math.max(
      environmentDelay("AUTO_PARTICIPATION_SILENCE_MS", 4_000),
      environmentDelay("AUTO_PARTICIPATION_CHECK_INTERVAL_MS", 15_000) -
        (now - (this.lastAutoParticipationCheckAt.get(guildId) ?? 0)),
      environmentDelay("AUTO_PARTICIPATION_COOLDOWN_MS", 120_000) -
        (now - (this.lastAutoParticipationResponseAt.get(guildId) ?? 0)),
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
    const mode = this.autoParticipationMode;
    if (
      mode === "off" ||
      this.conversationVersions.get(guildId) !== version ||
      this.responding.has(guildId) ||
      !this.isVoiceQuiet(guildId)
    ) {
      return;
    }
    this.lastAutoParticipationCheckAt.set(guildId, Date.now());
    const context = this.contextFor(
      this.history.entries,
      Date.now() - environmentDelay("AUTO_PARTICIPATION_CONTEXT_MS", 300_000),
    );
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

    const discarded = this.discardedAutoParticipationReason(guildId, version, mode);
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
    this.proactive.add(guildId);
    this.lastAutoParticipationResponseAt.set(guildId, Date.now());
    try {
      await this.respond(guildId, context, generation, verdict.replyIntent);
    } catch (error) {
      log("error", "auto participation response failed", { error: errorMessage(error) });
    } finally {
      if (this.generations.get(guildId) === generation) {
        this.responding.delete(guildId);
        this.proactive.delete(guildId);
      }
    }
  }

  private discardedAutoParticipationReason(
    guildId: string,
    version: number,
    mode: AutoParticipationMode,
  ): "conversation_changed" | "mode_changed" | "speech_started" | "busy" | undefined {
    if (this.conversationVersions.get(guildId) !== version) return "conversation_changed";
    if (this.autoParticipationMode !== mode) return "mode_changed";
    if (this.responding.has(guildId)) return "busy";
    if (!this.isVoiceQuiet(guildId)) return "speech_started";
    return undefined;
  }
}

function environmentDelay(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
