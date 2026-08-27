import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  validateToolCall,
} from "@earendil-works/pi-ai";

import { type HistoryEntry, HistoryStore, searchHistory } from "./agent/history.js";
import { MemoryStore } from "./agent/memory.js";
import { ProfileStore } from "./agent/profiles.js";
import { AgentRuntime } from "./agent/runtime.js";
import { SkillStore } from "./agent/skills.js";
import { hasStopCommand, hasWakeWord, isFillerOnlyTranscript } from "./agent/transcript.js";
import { floatMonoToStereoPcm, pcm16MonoToFloat, stereoPcmToMono } from "./audio.js";
import { formatMessageTime } from "./common.js";
import { dataPath } from "./config.js";
import { TaskScheduler } from "./scheduler.js";
import { isRetryableLlmError, parseExplanation, resizeImageForLlm } from "./scripts/explain-memes.js";
import { imageFileName, isImageAttachment } from "./scripts/export-memes.js";
import {
  chunkTranscripts,
  hourlyChunks,
  requestedDays,
  structuredMemoryPayload,
  validateProfileProposal,
  validateProposals,
} from "./scripts/sleep.js";
import { containsSpeech } from "./stt/vad.js";
import { currentDateTimeTool } from "./tools/datetime.js";
import { createDiscordTools, safeImagePath } from "./tools/discord.js";
import { createMemeSearchTool } from "./tools/memes.js";
import { createRememberTool, createSearchMemoryTool } from "./tools/memory.js";
import { createGetProfileTool } from "./tools/profiles.js";
import { createRecallHistoryTool } from "./tools/recall.js";
import { createSkillTools } from "./tools/skills.js";
import { createTaskTools } from "./tools/tasks.js";
import { isSafePublicUrl } from "./tools/web.js";
import { QwenTts } from "./tts/qwentts.js";

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
  assert.ok(Math.abs(mono.at(0) ?? Number.POSITIVE_INFINITY) < 0.0001);
  assert.equal(mono.at(1), 0.5);
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

test("wake word tolerates common STT variants as separate words", () => {
  assert.equal(hasWakeWord("Олег, что ты думаешь?"), true);
  assert.equal(hasWakeWord("Что ты думаешь, олег?"), true);
  assert.equal(hasWakeWord("Олега, что ты думаешь?"), true);
  assert.equal(hasWakeWord("Ольга, что ты думаешь?"), true);
  assert.equal(hasWakeWord("Это олегов ответ"), false);
  assert.equal(hasWakeWord("Это Ольгин ответ"), false);
});

test("stop command requires Oleg and an explicit stop word", () => {
  assert.equal(hasStopCommand("Олег СТОЙ"), true);
  assert.equal(hasStopCommand("олег, остановись!"), true);
  assert.equal(hasStopCommand("Олег — хватит."), true);
  assert.equal(hasStopCommand("Ольга, стой!"), true);
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

test("data path uses the configured data directory", () => {
  const previous = process.env["DATA_DIR"];
  try {
    process.env["DATA_DIR"] = "/tmp/voice-agent-data";
    assert.equal(dataPath("memes", "images.jsonl"), "/tmp/voice-agent-data/memes/images.jsonl");
  } finally {
    if (previous === undefined) delete process.env["DATA_DIR"];
    else process.env["DATA_DIR"] = previous;
  }
});

test("scheduled tasks persist after execution and recurring tasks can be deleted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-tasks-"));
  const path = join(directory, "tasks.json");
  let taskRan = (): void => undefined;
  const ran = new Promise<void>((resolve) => {
    taskRan = resolve;
  });
  const scheduler = new TaskScheduler(path, async () => taskRan());
  try {
    scheduler.start();
    const once = scheduler.create({
      instruction: "Напомни проверить тест",
      timezone: "Asia/Omsk",
      run_at: new Date(Date.now() + 100).toISOString(),
    });
    const recurring = scheduler.create({
      instruction: "Каждые пятнадцать минут сообщай статус",
      timezone: "Asia/Omsk",
      cron: "*/15 * * * *",
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ran,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("scheduled task timeout")), 2_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(scheduler.tasks.find((task) => task.id === once.id)?.status, "completed");
    assert.equal(scheduler.tasks.find((task) => task.id === once.id)?.runs, 1);
    assert.equal(
      scheduler.list().some((task) => task.id === once.id),
      false,
    );
    assert.equal(createTaskTools(scheduler, "Asia/Omsk").length, 3);
    scheduler.stop();

    const reloaded = new TaskScheduler(path, async () => undefined);
    assert.equal(reloaded.tasks.find((task) => task.id === once.id)?.status, "completed");
    assert.equal(reloaded.delete(recurring.id)?.kind, "cron");
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as unknown[]).length, 1);
  } finally {
    scheduler.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi agent executes a tool and continues to the final answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-pi-"));
  try {
    const history = new HistoryStore(join(directory, "history.jsonl"));
    const skills = new SkillStore(join(directory, "skills"));
    await skills.load();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxText("Сейчас проверю."), fauxToolCall("get_current_datetime", { timezone: "Asia/Omsk" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Готово."),
    ]);
    const runtime = new AgentRuntime(models, faux.getModel(), [currentDateTimeTool], history, skills);
    const calls: string[] = [];

    assert.equal(await runtime.complete("[10:00:00] Илья: Олег, который час?", (name) => calls.push(name)), "Готово.");
    assert.deepEqual(calls, ["get_current_datetime"]);
    assert.equal(history.entries.at(-1)?.tool, "get_current_datetime");
    faux.appendResponses([fauxAssistantMessage("Напоминаю проверить тест.")]);
    assert.equal(await runtime.completeScheduled("Напомни проверить тест"), "Напоминаю проверить тест.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skills persist, appear in the catalog and load on demand", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-skills-"));
  try {
    const store = new SkillStore(join(directory, "skills"));
    await store.load();
    const [view, create] = createSkillTools(store);
    assert.ok(view && create);

    await create.execute("create-skill", {
      name: "tea-brewing",
      description: "Готовь чай по повторяемой процедуре.",
      instructions: "# Чай\n\n1. Нагрей воду.\n2. Завари листья.",
    });

    assert.match(store.catalogPrompt(), /tea-brewing/u);
    const loaded = await view.execute("view-skill", { name: "tea-brewing" });
    assert.match(loaded.content[0]?.type === "text" ? loaded.content[0].text : "", /Нагрей воду/u);
    assert.match(readFileSync(join(directory, "skills", "tea-brewing", "SKILL.md"), "utf8"), /name: "tea-brewing"/u);
    await assert.rejects(store.create("../bad", "Traversal", "Не должен сохраниться"), /Skill name/u);
    await assert.rejects(
      create.execute("duplicate-skill", {
        name: "tea-brewing",
        description: "Дубликат",
        instructions: "Не должен сохраниться",
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mono float audio becomes stereo PCM", () => {
  const pcm = floatMonoToStereoPcm(new Float32Array([0.5]));
  assert.equal(pcm.length, 4);
  assert.equal(pcm.readInt16LE(0), pcm.readInt16LE(2));
});

test("Qwen raw PCM decodes to mono float audio", () => {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(-32_768, 0);
  pcm.writeInt16LE(16_384, 2);
  assert.deepEqual([...pcm16MonoToFloat(pcm)], [-1, 0.5]);
  assert.throws(() => pcm16MonoToFloat(Buffer.alloc(1)), /invalid mono PCM size/u);
});

test("Qwen TTS streams OpenAI-compatible PCM with Basic Auth", async () => {
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env["QWEN_TTS_BASE_URL"];
  process.env["QWEN_TTS_BASE_URL"] = "https://qwen:p%40ss@tts.example/v1";
  try {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(16_384, 0);
    pcm.writeInt16LE(-16_384, 2);
    globalThis.fetch = (async (input, init) => {
      assert.equal(input, "https://tts.example/v1/audio/speech");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Basic ${Buffer.from("qwen:p@ss").toString("base64")}`,
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        input: "Привет!",
        model: "tts-1",
        voice: "keltuzad",
        response_format: "pcm",
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(pcm.subarray(0, 1));
            controller.enqueue(pcm.subarray(1));
            controller.close();
          },
        }),
      );
    }) as typeof fetch;

    const audio = (await QwenTts.create()).synthesize("Привет!");
    const chunks: Buffer[] = [];
    audio.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    assert.equal(await audio.done, 2 / 24_000);
    assert.ok(Buffer.concat(chunks).length > 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env["QWEN_TTS_BASE_URL"];
    else process.env["QWEN_TTS_BASE_URL"] = previousBaseUrl;
  }
});

test("web tools reject local URLs and validate arguments", async () => {
  assert.equal(isSafePublicUrl("https://example.com/page"), true);
  assert.equal(isSafePublicUrl("http://127.0.0.1/private"), false);
  assert.equal(isSafePublicUrl("http://192.168.1.1/private"), false);
  assert.equal(isSafePublicUrl("http://[::ffff:127.0.0.1]/private"), false);
  assert.equal(isSafePublicUrl("file:///etc/passwd"), false);

  const call = {
    type: "toolCall" as const,
    id: "test-time",
    name: "get_current_datetime",
    arguments: { timezone: "Asia/Omsk" },
  };
  const args = validateToolCall([currentDateTimeTool], call);
  const result = await currentDateTimeTool.execute(call.id, args);
  assert.equal(typeof result.details === "object" && result.details !== null && "local" in result.details, true);
  assert.throws(
    () => validateToolCall([currentDateTimeTool], { ...call, arguments: { timezone: {} } }),
    /validation failed/iu,
  );
});

test("Discord tools list master members and send workspace images to общак", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".discord-tools-"));
  try {
    const image = join(directory, "result.png");
    writeFileSync(image, "test");
    const calls: unknown[][] = [];
    const [members, send, sounds, playSound] = createDiscordTools({
      async voiceMembers(channel) {
        calls.push(["members", channel]);
        return [{ id: "1", name: "Илья", bot: false }];
      },
      async sendMessage(channel, content, imagePath) {
        calls.push(["send", channel, content, imagePath]);
        return { id: "2", url: "https://discord.test/message" };
      },
      async soundboardSounds() {
        calls.push(["sounds"]);
        return [{ id: "3", name: "Ба-дум-тс", emoji: "🥁" }];
      },
      async playSoundboard(channel, soundId) {
        calls.push(["play", channel, soundId]);
        return { id: soundId, name: "Ба-дум-тс" };
      },
    });
    assert.ok(members && send && sounds && playSound);
    assert.equal((await members.execute("members", {})).details?.count, 1);
    assert.equal(
      (await send.execute("send", { content: " https://example.com/image ", image_path: image })).details?.channel,
      "общак",
    );
    assert.equal((await sounds.execute("sounds", {})).details?.count, 1);
    assert.equal((await playSound.execute("play", { sound_id: "3" })).details?.name, "Ба-дум-тс");
    assert.deepEqual(calls, [
      ["members", "master"],
      ["send", "общак", "https://example.com/image", safeImagePath(image)],
      ["sounds"],
      ["play", "master", "3"],
    ]);
    await assert.rejects(send.execute("empty", {}), /content or image_path/u);
    assert.throws(() => safeImagePath("/etc/hosts"), /inside the workspace/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

    const recalled = await createRecallHistoryTool(reloaded).execute("test-recall", {
      query: "ты сегодня говорил про подушку",
      date: "2026-08-25",
      kind: "assistant",
    });
    assert.equal(
      typeof recalled.details === "object" &&
        recalled.details !== null &&
        "count" in recalled.details &&
        recalled.details.count === 1,
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sleep memories require exact user-authored evidence", () => {
  const sources = [
    {
      timestamp: "2026-08-26T10:00:00.000Z",
      date: "2026-08-26",
      time: "16:00:00",
      kind: "transcript" as const,
      speaker: "Илья",
      speaker_id: "1",
      text: "Я решил в сентябре поехать на Байкал",
    },
    {
      timestamp: "2026-08-26T10:01:00.000Z",
      date: "2026-08-26",
      time: "17:01:00",
      kind: "transcript" as const,
      speaker: "Саша",
      speaker_id: "2",
      text: "Давайте выберем билеты в субботу",
    },
  ] satisfies [HistoryEntry, HistoryEntry];
  const result = validateProposals(
    {
      memories: [
        {
          kind: "person",
          summary: "Илья планирует в сентябре поехать на Байкал.",
          subject_ids: ["1"],
          importance: 5,
          evidence: [{ source_timestamp: sources[0].timestamp, quote: "в сентябре поехать на Байкал" }],
        },
        {
          kind: "person",
          summary: "Илья собирается выбирать билеты в субботу.",
          subject_ids: ["1"],
          importance: 4,
          evidence: [{ source_timestamp: sources[1].timestamp, quote: "выберем билеты в субботу" }],
        },
        {
          kind: "story",
          summary: "Участники договорились вернуться к билетам в субботу.",
          subject_ids: ["1", "2"],
          importance: 4,
          evidence: [{ source_timestamp: sources[1].timestamp, quote: "выберем билеты в субботу" }],
        },
        {
          kind: "activity",
          title: "Планировали поездку",
          summary: "Илья и Саша обсуждали поездку и выбор билетов.",
          subject_ids: ["1", "2"],
          importance: 3,
          started_at: sources[0].timestamp,
          ended_at: sources[1].timestamp,
          evidence: [
            { source_timestamp: sources[0].timestamp, quote: "поехать на Байкал" },
            { source_timestamp: sources[1].timestamp, quote: "выберем билеты" },
          ],
        },
      ],
    },
    sources,
    "2026-08-26",
  );

  assert.equal(result.accepted.length, 3);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.accepted[0]?.subjects, [{ id: "1", name: "Илья" }]);
  assert.match(result.rejected[0] ?? "", /not self-authored/u);
  assert.deepEqual(requestedDays(sources, "all"), ["2026-08-26"]);
  assert.equal(chunkTranscripts(sources, 100).length, 2);
  assert.equal(hourlyChunks(sources, 10_000).length, 2);
});

test("person profiles are structured, updated in place and hide raw evidence from the agent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-profiles-"));
  const sources = [
    {
      timestamp: "2026-08-25T10:00:00.000Z",
      date: "2026-08-25",
      time: "16:00:00",
      kind: "transcript" as const,
      speaker: "Илья",
      speaker_id: "1",
      text: "Я вечером снова играл в Deadlock",
    },
    {
      timestamp: "2026-08-26T10:00:00.000Z",
      date: "2026-08-26",
      time: "16:00:00",
      kind: "transcript" as const,
      speaker: "Илья",
      speaker_id: "1",
      text: "Вчера опять запустил Deadlock с друзьями",
    },
    {
      timestamp: "2026-08-27T10:00:00.000Z",
      date: "2026-08-27",
      time: "16:00:00",
      kind: "transcript" as const,
      speaker: "Илья",
      speaker_id: "1",
      text: "Сейчас работаю над голосовым агентом для Discord",
    },
  ] satisfies [HistoryEntry, HistoryEntry, HistoryEntry];
  try {
    const result = validateProfileProposal(
      {
        sections: {
          games: [
            {
              summary: "Регулярно играет в Deadlock с друзьями.",
              status: "recurring",
              evidence: [
                { source_timestamp: sources[0].timestamp, quote: "снова играл в Deadlock" },
                { source_timestamp: sources[1].timestamp, quote: "опять запустил Deadlock" },
              ],
            },
          ],
          work_projects: [
            {
              summary: "Работает над голосовым Discord-агентом.",
              status: "current",
              evidence: [{ source_timestamp: sources[2].timestamp, quote: "голосовым агентом для Discord" }],
            },
          ],
          life_stories: [],
          current_challenges: [],
          interests: [],
          media: [
            {
              summary: "Интересуется научной фантастикой.",
              status: "uncertain",
              evidence: [{ source_timestamp: sources[0].timestamp, quote: "играл в Deadlock" }],
            },
          ],
          plans: [],
        },
      },
      sources,
      "1",
      "Илья",
      new Date("2026-08-27T12:00:00.000Z"),
    );

    assert.equal(result.profile.sections.games.length, 1);
    assert.equal(result.profile.sections.work_projects.length, 1);
    assert.equal(result.profile.sections.media.length, 0);
    assert.match(result.rejected[0] ?? "", /two different messages/u);

    const path = join(directory, "profiles.json");
    const store = new ProfileStore(path);
    store.upsert(result.profile);
    store.upsert({ ...result.profile, name: "Илья Новый", updated_at: "2026-08-27T13:00:00.000Z" });
    const reloaded = new ProfileStore(path);
    assert.equal(reloaded.profiles.length, 1);
    assert.equal(reloaded.profiles[0]?.name, "Илья Новый");
    assert.match(readFileSync(path, "utf8"), /снова играл в Deadlock/u);

    const response = await createGetProfileTool(reloaded).execute("get-profile", { person: "1" });
    const agentView = response.content[0]?.type === "text" ? response.content[0].text : "";
    assert.doesNotMatch(agentView, /evidence|снова играл в Deadlock/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sleep surfaces provider errors before retrying structured output", () => {
  assert.throws(
    () =>
      structuredMemoryPayload({
        content: [],
        errorMessage: "Codex error: Unsupported parameter: temperature",
        stopReason: "error",
      }),
    /Unsupported parameter: temperature/u,
  );
  assert.deepEqual(
    structuredMemoryPayload({
      content: [fauxToolCall("submit_memories", { memories: [] })],
      stopReason: "toolUse",
    }),
    { memories: [] },
  );
});

test("reflected memory persists metadata and deduplicates exact facts", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-reflection-"));
  try {
    const path = join(directory, "memory.jsonl");
    const store = new MemoryStore(path);
    const evidence = {
      source_timestamp: "2026-08-26T10:00:00.000Z",
      speaker_id: "1",
      speaker: "Илья",
      quote: "Я решил в сентябре поехать на Байкал",
    };
    const input = {
      kind: "person" as const,
      fact: "Илья планирует в сентябре поехать на Байкал.",
      subjects: [{ id: "1", name: "Илья" }],
      importance: 5,
      evidence: [evidence],
      day: "2026-08-26",
    };
    store.rememberReflection(input);
    store.rememberReflection(input);
    store.rememberReflection({
      ...input,
      subjects: [{ id: "2", name: "Саша" }],
      evidence: [{ ...evidence, speaker_id: "2", speaker: "Саша" }],
    });
    store.rememberReflection({
      ...input,
      kind: "activity",
      title: "Планировали поездку",
      fact: "Обсуждали поездку на Байкал.",
      importance: 3,
      started_at: evidence.source_timestamp,
      ended_at: evidence.source_timestamp,
    });

    const reloaded = new MemoryStore(path);
    assert.equal(reloaded.entries.length, 3);
    assert.equal(reloaded.entries[0]?.kind, "person");
    assert.deepEqual(reloaded.entries[0]?.subject_ids, ["1"]);
    assert.equal(reloaded.entries[0]?.origin, "sleep");
    assert.equal(reloaded.entries[2]?.title, "Планировали поездку");
    assert.equal(reloaded.entries[2]?.started_at, evidence.source_timestamp);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("meme search uses descriptions, natural dates, and returns raw JSONL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-meme-search-"));
  const path = join(directory, "memes.jsonl");
  const previousYear = new Date().getFullYear() - 1;
  const ignored = JSON.stringify({
    timestamp: `${previousYear}-05-01T10:00:00Z`,
    description: "Человек задумчиво смотрит бессмысленный контент.",
    use_for: "Когда нужен котёнок за рулём.",
    tags: ["котёнок", "автомобиль"],
  });
  const expected = JSON.stringify({
    timestamp: `${previousYear}-06-01T10:00:00Z`,
    description: "Котёнок сидит за рулём автомобиля и серьёзно смотрит вперёд.",
    use_for: "Когда уверенно ведёшь проект.",
    tags: ["водитель"],
  });
  const current = JSON.stringify({
    timestamp: `${previousYear + 1}-06-01T10:00:00Z`,
    description: "Котёнок сидит за рулём автомобиля.",
  });
  try {
    writeFileSync(path, `${ignored}\n${expected}\n${current}\n`);
    const result = await createMemeSearchTool(path).execute("test-memes", {
      query: "найди мем про котенка в прошлом году",
      limit: 5,
    });
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", expected);
    assert.deepEqual((result.details as { results: string[] }).results, [expected]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("curated memory requires user evidence, persists, and supports fuzzy search", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-memory-"));
  const historyPath = join(directory, "history.jsonl");
  const memoryPath = join(directory, "memory.jsonl");
  try {
    const history = new HistoryStore(historyPath);
    history.appendMessage(
      "transcript",
      "Илья",
      "Олег, запомни: я люблю кофе без сахара",
      new Date(2026, 7, 25, 12, 0, 0),
    );
    const memory = new MemoryStore(memoryPath);
    const remember = createRememberTool(memory, history);
    const saved = await remember.execute("remember-1", {
      fact: "Илья любит кофе без сахара",
      source_quote: "я люблю кофе без сахара",
      speaker: "Илья",
    });
    assert.equal((saved.details as { saved: boolean }).saved, true);
    const duplicate = await remember.execute("remember-2", {
      fact: "Илья любит кофе без сахара",
      source_quote: "я люблю кофе без сахара",
      speaker: "Илья",
    });
    assert.equal((duplicate.details as { saved: boolean }).saved, false);
    await assert.rejects(
      remember.execute("remember-invalid", {
        fact: "Илья любит чай",
        source_quote: "я люблю чай",
        speaker: "Илья",
      }),
      /not found/iu,
    );
    history.appendMessage("transcript", "Илья", "Я люблю чай", new Date(2026, 7, 25, 12, 1, 0));
    await assert.rejects(
      remember.execute("remember-not-requested", {
        fact: "Илья любит чай",
        source_quote: "Я люблю чай",
        speaker: "Илья",
      }),
      /did not explicitly ask/iu,
    );

    const reloaded = new MemoryStore(memoryPath);
    assert.equal(reloaded.entries.length, 1);
    const recalled = await createSearchMemoryTool(reloaded).execute("search-memory", {
      query: "кофе без сахар",
    });
    assert.equal((recalled.details as { count: number }).count, 1);
    assert.equal(
      (recalled.details as { results: Array<{ evidence: string }> }).results[0]?.evidence,
      "я люблю кофе без сахара",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
