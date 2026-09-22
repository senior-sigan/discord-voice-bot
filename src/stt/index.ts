import type { AppConfig } from "../config.ts";

import { DisabledTranscriber } from "./disabled.ts";
import { ParakeetTranscriber } from "./parakeet.ts";
import { QwenHttpTranscriber } from "./qwen-http.ts";
import type { Transcriber } from "./types.ts";

export { DisabledTranscriber } from "./disabled.ts";
export { ParakeetTranscriber } from "./parakeet.ts";
export { QwenHttpTranscriber } from "./qwen-http.ts";
export type { Transcriber, Transcript } from "./types.ts";
export { SAMPLE_RATE } from "./types.ts";

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
