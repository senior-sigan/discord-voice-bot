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
import { startLocalControlServer } from "./local-control.js";
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
  const tts = await createTts(config);
  const { stt } = config.settings;
  const transcriber = await ParakeetTranscriber.create(stt.model_dir, stt.vad_model, stt.vad_threshold, stt.threads);
  const guildId = config.settings.discord.guild_id;
  if (!guildId) throw new Error("Set defaults.discord.guild_id in config.json");
  const discord = new DiscordBot(config.discordToken, guildId, transcriber);
  let voiceAgent: VoiceAgent;
  const scheduler = new TaskScheduler(config.tasksFile, (task) =>
    voiceAgent.runScheduledTask(guildId, task.instruction),
  );
  let agentRuntime: AgentRuntime;
  const tools = createTools(history, memory, profiles, skills, discord, scheduler, config, (model) =>
    agentRuntime.switchModel(model),
  );
  agentRuntime = new AgentRuntime(ai.models, ai.model, tools, history, skills, config);
  voiceAgent = new VoiceAgent(
    agentRuntime,
    history,
    tts,
    loadFillers(config),
    (guildId, audio) => discord.speak(guildId, audio),
    (guildId) => discord.interrupt(guildId),
    config,
    (guildId) => discord.isVoiceQuiet(guildId),
  );
  discord.setAgent(voiceAgent);

  let controlServer: Awaited<ReturnType<typeof startLocalControlServer>> | undefined;
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down", { signal });
    scheduler.stop();
    controlServer?.close();
    void discord
      .stop()
      .catch((error: unknown) => log("error", "shutdown failed", { error: errorMessage(error) }))
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await discord.start(process.argv.includes("--autojoin") ? "master" : undefined);
  const localControl = config.settings.agent.local_control;
  if (localControl.enabled) {
    try {
      controlServer = await startLocalControlServer(localControl.host, localControl.port, (text) =>
        voiceAgent.speakDirectly(guildId, text),
      );
    } catch (error) {
      await discord.stop();
      throw error;
    }
  }
  scheduler.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    log("error", "fatal", { error: errorMessage(error) });
    process.exitCode = 1;
  });
}
