import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HistoryStore, searchHistory } from "./agent/history.js";
import type { ChatRequest, LlmClient } from "./agent/llm-client.js";
import { needsThinkingPrefill, selectLlmModel } from "./agent/llm-client.js";
import { AgentLoop } from "./agent/loop.js";
import { hasStopCommand, hasWakeWord, isFillerOnlyTranscript } from "./agent/transcript.js";
import { floatMonoToStereoPcm, pcm16MonoWavToFloat, stereoPcmToMono } from "./audio.js";
import { formatMessageTime } from "./common.js";
import { isRetryableLlmError, parseExplanation, resizeImageForLlm } from "./scripts/explain-memes.js";
import { imageFileName, isImageAttachment } from "./scripts/export-memes.js";
import { containsSpeech } from "./stt/vad.js";
import { executeTool, isSafePublicUrl, requiredToolForContext } from "./tools/index.js";

test("meme explanation parser normalizes valid structured output", () => {
  assert.deepEqual(
    parseExplanation(
      JSON.stringify({
        description: " Текст и смысл мема. ",
        use_for: " Когда всё пошло не по плану. ",
        tags: ["#Провал", "реакция", "провал", "планы"],
      }),
    ),
    {
      description: "Текст и смысл мема.",
      use_for: "Когда всё пошло не по плану.",
      tags: ["провал", "реакция", "планы"],
    },
  );
  assert.throws(() => parseExplanation({ description: "x", use_for: "y", tags: [] }), /incomplete/);
  assert.throws(() => parseExplanation("not JSON"), /invalid JSON/);
});

test("meme images are resized for the LLM without distortion", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-meme-"));
  const path = join(directory, "wide.ppm");
  try {
    writeFileSync(path, Buffer.concat([Buffer.from("P6\n2000 1000\n255\n"), Buffer.alloc(2000 * 1000 * 3)]));
    const png = resizeImageForLlm(path);
    assert.equal(png.readUInt32BE(16), 1536);
    assert.equal(png.readUInt32BE(20), 768);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("temporary LM Studio failures are retryable", () => {
  assert.equal(isRetryableLlmError(400, "LM Link connection entered error state peer_keepalive_timeout"), true);
  assert.equal(isRetryableLlmError(400, "The model has crashed without additional information"), true);
  assert.equal(isRetryableLlmError(400, "invalid request schema"), false);
  assert.equal(isRetryableLlmError(503, "unavailable"), true);
});

test("meme exporter recognizes images and creates stable filenames", () => {
  assert.equal(isImageAttachment({ content_type: "image/png", filename: "meme.bin" }), true);
  assert.equal(isImageAttachment({ filename: "meme.WEBP" }), true);
  assert.equal(isImageAttachment({ content_type: "video/mp4", filename: "meme.mp4" }), false);
  assert.equal(
    imageFileName(
      {
        id: "20",
        timestamp: "2026-08-25T12:05:01.123Z",
        author: { id: "10" },
      } as Parameters<typeof imageFileName>[0],
      {
        id: "30",
        filename: "meme.png",
        content_type: "image/webp",
      } as Parameters<typeof imageFileName>[1],
    ),
    "20260825T120501_123Z__u-10__m-20__a-30.webp",
  );
});

test("stereo PCM is mixed to mono without changing duration", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(32767, 0);
  pcm.writeInt16LE(-32768, 2);
  pcm.writeInt16LE(16384, 4);
  pcm.writeInt16LE(16384, 6);

  const mono = stereoPcmToMono(pcm);
  assert.equal(mono.length, 2);
  assert.ok(Math.abs(mono[0]!) < 0.0001);
  assert.equal(mono[1]!, 0.5);
});

test("VAD gates audio and resets between chunks", () => {
  let empty = false;
  let resets = 0;
  const vad = {
    acceptWaveform: (_samples: Float32Array) => undefined,
    isEmpty: () => empty,
    reset: () => {
      resets += 1;
    },
    flush: () => undefined,
  };

  assert.equal(containsSpeech(vad, new Float32Array()), true);
  empty = true;
  assert.equal(containsSpeech(vad, new Float32Array()), false);
  assert.equal(resets, 2);
});

test("wake word matches Олег as a separate word", () => {
  assert.equal(hasWakeWord("Олег, что ты думаешь?"), true);
  assert.equal(hasWakeWord("Что ты думаешь, олег?"), true);
  assert.equal(hasWakeWord("Это олегов ответ"), false);
});

test("stop command requires Oleg and an explicit stop word", () => {
  assert.equal(hasStopCommand("Олег СТОЙ"), true);
  assert.equal(hasStopCommand("олег, остановись!"), true);
  assert.equal(hasStopCommand("Олег — хватит."), true);
  assert.equal(hasStopCommand("Стой, Олег"), false);
  assert.equal(hasStopCommand("Олег, продолжай"), false);
});

test("filler-only transcripts are ignored without hiding real speech", () => {
  assert.equal(isFillerOnlyTranscript("Yeah. Uh. Okay. Mm-hmm."), true);
  assert.equal(isFillerOnlyTranscript("um, yep"), true);
  assert.equal(isFillerOnlyTranscript("Yeah, давай запускать"), false);
  assert.equal(isFillerOnlyTranscript("Okay, но завтра"), false);
  assert.equal(isFillerOnlyTranscript(""), false);
});

test("message time contains only local time", () => {
  assert.equal(formatMessageTime(new Date(2026, 7, 24, 9, 5, 3)), "09:05:03");
});

test("thinking prefill is limited to Qwen 3 models", () => {
  assert.equal(needsThinkingPrefill("qwen3.5-9b"), true);
  assert.equal(needsThinkingPrefill("qwen/qwen3.6-35b-a3b"), true);
  assert.equal(needsThinkingPrefill("qwen/qwen3.8-27b"), true);
  assert.equal(needsThinkingPrefill("qwen/qwen3-8b"), true);
  assert.equal(needsThinkingPrefill("google/gemma-4-e4b"), false);
});

test("current fact questions require the matching tool", () => {
  assert.equal(requiredToolForContext("[10:00:00] Илья: Олег, какая погода в Омске?"), "web_search");
  assert.equal(requiredToolForContext("[10:00:00] Илья: Когда вышло последнее обновление Deadlock?"), "web_search");
  assert.equal(requiredToolForContext("[10:00:00] Илья: Олег, который час?"), "get_current_datetime");
  assert.equal(requiredToolForContext("[10:00:00] Илья: Олег, помнишь, что ты говорил?"), "recall_history");
  assert.equal(requiredToolForContext("[10:00:00] Илья: Олег, расскажи анекдот"), undefined);
});

test("configured LM Studio model resolves its unique API suffix", () => {
  assert.equal(selectLlmModel("gemma-4-e4b", ["gemma-4-e4b-it", "qwen3.5-9b"]), "gemma-4-e4b-it");
  assert.equal(selectLlmModel("gemma-4-e4b", ["gemma-4-e4b-it", "gemma-4-e4b-qat"]), undefined);
});

test("agent loop returns tool results to the model before the final answer", async () => {
  const requests: ChatRequest[] = [];
  const client: LlmClient = {
    async modelName() {
      return "google/gemma-4-e4b";
    },
    async chat(request) {
      requests.push(request);
      return requests.length === 1
        ? {
            role: "assistant",
            content: "Сейчас повторю.",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "echo", arguments: '{"text":"привет"}' },
              },
            ],
          }
        : { role: "assistant", content: "Готово." };
    },
  };
  const loop = new AgentLoop(client, [
    {
      name: "echo",
      description: "Повторяет текст",
      parameters: { type: "object" },
      async execute(args) {
        return args;
      },
    },
  ]);

  assert.equal(await loop.complete("[10:00:00] Илья: Олег, повтори привет"), "Готово.");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.messages.at(-1), {
    role: "tool",
    tool_call_id: "call-1",
    content: '{"text":"привет"}',
  });
});

test("mono float audio becomes stereo PCM", () => {
  const pcm = floatMonoToStereoPcm(new Float32Array([0.5]));
  assert.equal(pcm.length, 4);
  assert.equal(pcm.readInt16LE(0), pcm.readInt16LE(2));
});

test("Qwen PCM WAV chunks decode to mono float audio", () => {
  const wav = Buffer.alloc(48);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(40, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(4, 40);
  wav.writeInt16LE(-32_768, 44);
  wav.writeInt16LE(16_384, 46);

  const decoded = pcm16MonoWavToFloat(wav);
  assert.equal(decoded.sampleRate, 24_000);
  assert.deepEqual([...decoded.samples], [-1, 0.5]);
});

test("web tools reject local URLs and validate arguments", async () => {
  assert.equal(isSafePublicUrl("https://example.com/page"), true);
  assert.equal(isSafePublicUrl("http://127.0.0.1/private"), false);
  assert.equal(isSafePublicUrl("http://192.168.1.1/private"), false);
  assert.equal(isSafePublicUrl("http://[::ffff:127.0.0.1]/private"), false);
  assert.equal(isSafePublicUrl("file:///etc/passwd"), false);

  const result = await executeTool("get_current_datetime", JSON.stringify({ timezone: "Asia/Omsk" }));
  assert.equal(typeof result === "object" && result !== null && "local" in result, true);
  await assert.rejects(executeTool("get_current_datetime", "{bad"), /valid JSON/);
});

test("history survives restart and supports filtered fuzzy recall", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-history-"));
  const path = join(directory, "history.jsonl");
  try {
    const store = new HistoryStore(path);
    store.appendMessage("transcript", "Илья", "Я рассказывал про новую подушку", new Date(2026, 7, 25, 10, 0, 0));
    store.appendMessage("assistant", "Олег", "Подушка отличная, бери", new Date(2026, 7, 25, 10, 0, 5));
    store.appendTool("web_search", { query: "подушки Омск" }, new Date(2026, 7, 25, 10, 0, 2));

    const reloaded = new HistoryStore(path);
    assert.equal(reloaded.entries.length, 3);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3);
    assert.equal(searchHistory(reloaded.entries, { query: "падушка", speaker: "Илья" })[0]?.entry.kind, "transcript");

    const recalled = await executeTool(
      "recall_history",
      JSON.stringify({
        query: "ты сегодня говорил про подушку",
        date: "2026-08-25",
        kind: "assistant",
      }),
      reloaded,
    );
    assert.equal(
      typeof recalled === "object" && recalled !== null && "count" in recalled && recalled.count === 1,
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
