export interface AppConfig {
  discordToken: string;
  discordGuildId: string;
  sttModelDir: string;
  vadModel: string;
  vadThreshold: number;
  ttsModelDir: string;
  fillerDir: string;
  llmBaseUrl: string;
  historyFile: string;
}

export function loadConfig(): AppConfig {
  const discordToken = process.env["DISCORD_TOKEN"];
  const discordGuildId = process.env["DISCORD_GUILD_ID"];
  if (!discordToken || !discordGuildId) {
    throw new Error("DISCORD_TOKEN and DISCORD_GUILD_ID are required");
  }
  return {
    discordToken,
    discordGuildId,
    sttModelDir: process.env["STT_MODEL_DIR"] ?? "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    vadModel: process.env["VAD_MODEL"] ?? "models/vad/silero_vad_v5.onnx",
    vadThreshold: Number(process.env["VAD_THRESHOLD"] ?? 0.6),
    ttsModelDir: process.env["TTS_MODEL_DIR"] ?? "models/vits-piper-ru_RU-ruslan-medium",
    fillerDir: process.env["FILLER_DIR"] ?? "assets/fillers",
    llmBaseUrl: (process.env["LLM_BASE_URL"] ?? "http://127.0.0.1:1234/v1").replace(/\/$/, ""),
    historyFile: process.env["HISTORY_FILE"] ?? "history.jsonl",
  };
}
