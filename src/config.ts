export interface AppConfig {
  discordToken: string;
  discordGuildId: string;
  sttModelDir: string;
  vadModel: string;
  vadThreshold: number;
  ttsModelDir: string;
  fillerDir: string;
  aiProvider: string;
  aiModel?: string;
  aiAuthFile: string;
  openAiCompatibleBaseUrl: string;
  openAiCompatibleApiKey?: string;
  aiContextWindow: number;
  aiMaxTokens: number;
  historyFile: string;
  memoryFile: string;
  profilesFile: string;
  tasksFile: string;
  timezone: string;
}

export function loadConfig(): AppConfig {
  const discordToken = process.env["DISCORD_TOKEN"];
  const discordGuildId = process.env["DISCORD_GUILD_ID"];
  const aiModel = process.env["AI_MODEL"] ?? process.env["LLM_MODEL"];
  const openAiCompatibleApiKey = process.env["OPENAI_COMPATIBLE_API_KEY"] ?? process.env["LLM_API_KEY"];
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
    aiProvider: process.env["AI_PROVIDER"] ?? process.env["LLM_PROVIDER"] ?? "openai-compatible",
    ...(aiModel ? { aiModel } : {}),
    aiAuthFile: process.env["PI_AUTH_FILE"] ?? "auth.json",
    openAiCompatibleBaseUrl: (
      process.env["OPENAI_COMPATIBLE_BASE_URL"] ??
      process.env["LLM_BASE_URL"] ??
      "http://127.0.0.1:1234/v1"
    ).replace(/\/$/, ""),
    ...(openAiCompatibleApiKey ? { openAiCompatibleApiKey } : {}),
    aiContextWindow: Math.max(1_024, Number(process.env["AI_CONTEXT_WINDOW"] ?? 32_768) || 32_768),
    aiMaxTokens: Math.max(64, Number(process.env["AI_MAX_TOKENS"] ?? process.env["LLM_MAX_TOKENS"] ?? 1_024) || 1_024),
    historyFile: process.env["HISTORY_FILE"] ?? "history.jsonl",
    memoryFile: process.env["MEMORY_FILE"] ?? "memory.jsonl",
    profilesFile: process.env["PROFILES_FILE"] ?? "profiles.json",
    tasksFile: process.env["TASKS_FILE"] ?? "tasks.json",
    timezone: process.env["TIMEZONE"] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
