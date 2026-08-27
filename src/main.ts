import { fileURLToPath } from "node:url";

import { HistoryStore } from "./agent/history.js";
import { MemoryStore } from "./agent/memory.js";
import { ProfileStore } from "./agent/profiles.js";
import { AgentRuntime } from "./agent/runtime.js";
import { SkillStore } from "./agent/skills.js";
import { VoiceAgent } from "./agent/voice-agent.js";
import { createAiRuntime } from "./ai/runtime.js";
import { errorMessage, log } from "./common.js";
import { loadConfig } from "./config.js";
import { DiscordBot } from "./discord/bot.js";
import { TaskScheduler } from "./scheduler.js";
import { ParakeetTranscriber } from "./stt/index.js";
import { createTools } from "./tools/index.js";
import { createTts, loadFillers } from "./tts/index.js";

async function run(): Promise<void> {
  const config = loadConfig();
  const history = new HistoryStore(config.historyFile);
  const memory = new MemoryStore(config.memoryFile);
  const profiles = new ProfileStore(config.profilesFile);
  const skills = new SkillStore();
  await skills.load();
  const ai = await createAiRuntime(config, process.argv.includes("--select-model"));
  const tts = await createTts(config.ttsModelDir);
  const transcriber = await ParakeetTranscriber.create(config.sttModelDir, config.vadModel, config.vadThreshold);
  const discord = new DiscordBot(config.discordToken, config.discordGuildId, transcriber);
  let voiceAgent: VoiceAgent;
  const scheduler = new TaskScheduler(config.tasksFile, (task) =>
    voiceAgent.runScheduledTask(config.discordGuildId, task.instruction),
  );
  const agentRuntime = new AgentRuntime(
    ai.models,
    ai.model,
    createTools(history, memory, profiles, skills, discord, scheduler, config.timezone),
    history,
    skills,
  );
  voiceAgent = new VoiceAgent(
    agentRuntime,
    history,
    tts,
    loadFillers(config.fillerDir),
    (guildId, audio) => discord.speak(guildId, audio),
    (guildId) => discord.interrupt(guildId),
    config.autoParticipationMode,
    (guildId) => discord.isVoiceQuiet(guildId),
  );
  discord.setAgent(voiceAgent);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down", { signal });
    scheduler.stop();
    void discord
      .stop()
      .catch((error: unknown) => log("error", "shutdown failed", { error: errorMessage(error) }))
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await discord.start(process.argv.includes("--autojoin") ? "master" : undefined);
  scheduler.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    log("error", "fatal", { error: errorMessage(error) });
    process.exitCode = 1;
  });
}
