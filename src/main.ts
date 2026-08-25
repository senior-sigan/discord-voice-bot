import { fileURLToPath } from "node:url";

import { HistoryStore } from "./agent/history.js";
import { LocalLlmClient } from "./agent/llm-client.js";
import { AgentLoop } from "./agent/loop.js";
import { VoiceAgent } from "./agent/voice-agent.js";
import { errorMessage, log } from "./common.js";
import { loadConfig } from "./config.js";
import { DiscordBot } from "./discord/bot.js";
import { ParakeetTranscriber } from "./stt/index.js";
import { createTools } from "./tools/index.js";
import { createTts, loadFillers } from "./tts/index.js";

async function run(): Promise<void> {
  const config = loadConfig();
  const history = new HistoryStore(config.historyFile);
  const loop = new AgentLoop(new LocalLlmClient(config.llmBaseUrl), createTools(history), history);
  const tts = await createTts(config.ttsModelDir);
  const transcriber = await ParakeetTranscriber.create(config.sttModelDir, config.vadModel, config.vadThreshold);
  const discord = new DiscordBot(config.discordToken, config.discordGuildId, transcriber);
  discord.setAgent(
    new VoiceAgent(
      loop,
      history,
      tts,
      loadFillers(config.fillerDir),
      (guildId, audio) => discord.speak(guildId, audio),
      (guildId) => discord.interrupt(guildId),
    ),
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down", { signal });
    void discord
      .stop()
      .catch((error: unknown) => log("error", "shutdown failed", { error: errorMessage(error) }))
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await discord.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    log("error", "fatal", { error: errorMessage(error) });
    process.exitCode = 1;
  });
}
