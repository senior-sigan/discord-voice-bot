import type { AppConfig } from "../config.js";

import { DisabledTranscriber } from "./disabled.js";
import { ParakeetTranscriber } from "./parakeet.js";
import { QwenHttpTranscriber } from "./qwen-http.js";
import type { Transcriber } from "./types.js";

export { DisabledTranscriber } from "./disabled.js";
export { ParakeetTranscriber } from "./parakeet.js";
export { QwenHttpTranscriber } from "./qwen-http.js";
export type { Transcriber, Transcript } from "./types.js";
export { SAMPLE_RATE } from "./types.js";

export async function createTranscriber(config: AppConfig): Promise<Transcriber> {
  const { stt } = config.settings;
  if (stt.backend === "disabled") return new DisabledTranscriber();
  if (stt.backend === "qwen") {
    if (!config.qwenSttApiKey) throw new Error("MLX_ASR_API_KEY is required for the Qwen STT backend");
    return QwenHttpTranscriber.create(
      stt.qwen.base_url,
      stt.qwen.model,
      stt.qwen.language,
      stt.qwen.timeout_ms,
      config.qwenSttApiKey,
      stt.vad_model,
      stt.vad_threshold,
    );
  }
  return ParakeetTranscriber.create(stt.model_dir, stt.vad_model, stt.vad_threshold, stt.threads);
}
