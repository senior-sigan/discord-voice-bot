import type { GeneratedAudio } from "sherpa-onnx-node";

import { errorMessage, log } from "../common.js";
import type { Transcript } from "../stt/index.js";
import type { Tts, VoiceAudio } from "../tts/index.js";
import type { HistoryEntry, HistoryStore } from "./history.js";
import type { AgentRuntime } from "./runtime.js";
import { hasStopCommand, hasWakeWord } from "./transcript.js";

export class VoiceAgent {
  private readonly responding = new Set<string>();
  private readonly lastWakeAt = new Map<string, number>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly history: HistoryStore,
    private readonly tts: Tts,
    private readonly fillers: readonly [GeneratedAudio, ...GeneratedAudio[]],
    private readonly speak: (guildId: string, audio: VoiceAudio) => Promise<void>,
    private readonly stopSpeaking: (guildId: string) => void,
  ) {}

  onTranscript(transcript: Transcript): void {
    this.history.appendMessage(
      "transcript",
      transcript.user,
      transcript.text,
      new Date(transcript.timestamp),
      transcript.userId,
    );
    if (hasStopCommand(transcript.text)) {
      this.generations.set(transcript.guildId, (this.generations.get(transcript.guildId) ?? 0) + 1);
      this.responding.delete(transcript.guildId);
      this.runtime.abort();
      this.stopSpeaking(transcript.guildId);
      log("info", "speech interrupted", { user: transcript.user });
      return;
    }
    if (!hasWakeWord(transcript.text)) return;

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
    this.generations.set(guildId, (this.generations.get(guildId) ?? 0) + 1);
    this.responding.delete(guildId);
    this.lastWakeAt.delete(guildId);
  }

  private contextFor(history: HistoryEntry[]): string {
    const limit = Math.max(1_000, Number(process.env["LLM_CONTEXT_CHARS"] ?? 12_000) || 12_000);
    const lines: string[] = [];
    let length = 0;
    for (const entry of history.toReversed()) {
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

  private async respond(guildId: string, context: string, generation: number): Promise<void> {
    const started = performance.now();
    const announced = new Set<string>();
    const answer = await this.runtime.complete(context, (tool, args, suggestion) => {
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
    });
    if (this.generations.get(guildId) !== generation) return;
    log("info", "LLM response", {
      elapsed: `${((performance.now() - started) / 1_000).toFixed(2)}s`,
      text: answer,
    });
    this.history.appendMessage("assistant", "Олег", answer);
    await this.speak(guildId, this.tts.synthesize(answer));
  }
}
