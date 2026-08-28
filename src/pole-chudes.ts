import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

import { z } from "zod";

import { errorMessage, log } from "./common.js";
import type { Transcript } from "./stt/index.js";

const WORDS = [
  { category: "Обитатель кухни", answer: "ДУРШЛАГ" },
  { category: "Обитатель кухни", answer: "ПЕЛЬМЕНЬ" },
  { category: "Обитатель кухни", answer: "ХОЛОДИЛЬНИК" },
  { category: "Обитатель кухни", answer: "БУТЕРБРОД" },
  { category: "Домашняя археология", answer: "ТАПОК" },
  { category: "Домашняя археология", answer: "АНТРЕСОЛЬ" },
  { category: "Домашняя археология", answer: "ПЫЛЕСОС" },
  { category: "Домашняя археология", answer: "БУДИЛЬНИК" },
  { category: "Законы Дискорда", answer: "МИКРОФОН" },
  { category: "Законы Дискорда", answer: "ПЕРЕПОДКЛЮЧЕНИЕ" },
  { category: "Законы Дискорда", answer: "МОДЕРАТОР" },
  { category: "Законы Дискорда", answer: "САУНДБОРД" },
  { category: "Интернетоведение", answer: "МЕМ" },
  { category: "Интернетоведение", answer: "СПОЙЛЕР" },
  { category: "Интернетоведение", answer: "СТИКЕР" },
  { category: "Интернетоведение", answer: "ПИНГ" },
  { category: "Из жизни Олега", answer: "ГАЛСТУК" },
  { category: "Из жизни Олега", answer: "САРКАЗМ" },
  { category: "Из жизни Олега", answer: "ПЕЧЕНЬЕ" },
  { category: "Из жизни Олега", answer: "ДИКЦИЯ" },
  { category: "Рабочий процесс", answer: "СОЗВОН" },
  { category: "Рабочий процесс", answer: "ДЕДЛАЙН" },
  { category: "Рабочий процесс", answer: "ТАБЛИЧКА" },
  { category: "Рабочий процесс", answer: "ПЯТНИЦА" },
  { category: "Загадочная природа", answer: "ЁЖИК" },
  { category: "Загадочная природа", answer: "ВЫХУХОЛЬ" },
  { category: "Загадочная природа", answer: "КАПИБАРА" },
  { category: "Загадочная природа", answer: "БАКЛАЖАН" },
] as const;

const SECTORS = [5, 10, 15, "ПЕРЕХОД", 20, "X2", 25, "ПЛЮС", 10, "БАНКРОТ", 15, "ПРИЗ", 20, "X4", 25, 5] as const;
const TOURS = ["ЧЕТВЕРТЬФИНАЛ", "ПОЛУФИНАЛ", "ФИНАЛ"] as const;
const PRIZES = [
  "рулон стратегической туалетной бумаги",
  "подтяжки для одного носка",
  "сертификат на стабильный интернет по четвергам",
  "запасной микрофон без провода и микрофона",
] as const;
const LETTERS = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
const ROOM_TTL_MS = 6 * 60 * 60 * 1_000;
const VERIFY_TTL_MS = 30_000;
const MAX_BODY_BYTES = 4_096;

type WheelSector = (typeof SECTORS)[number];
type Phase = "lobby" | "playing" | "won";

interface Player {
  id: string;
  name: string;
  score: number;
}

export interface PoleChudesState {
  phase: Phase;
  round: number;
  tour: string;
  category: string;
  puzzle: string;
  answer?: string;
  prize?: string;
  guessed: string[];
  players: Player[];
  hostId?: string;
  currentPlayerId?: string;
  pendingScore?: number;
  sectors: readonly WheelSector[];
  wheelIndex: number;
  rotation: number;
  message: string;
}

const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("join"),
    playerId: z.string().trim().min(8).max(100),
    name: z.string().trim().min(1).max(30),
  }),
  z.strictObject({ type: z.literal("start"), playerId: z.string().trim().min(8).max(100) }),
  z.strictObject({ type: z.literal("spin"), playerId: z.string().trim().min(8).max(100) }),
  z.strictObject({
    type: z.literal("guess"),
    playerId: z.string().trim().min(8).max(100),
    letter: z.string().trim().min(1).max(1),
  }),
  z.strictObject({
    type: z.literal("solve"),
    playerId: z.string().trim().min(8).max(100),
    answer: z.string().trim().min(1).max(50),
  }),
  z.strictObject({ type: z.literal("newRound"), playerId: z.string().trim().min(8).max(100) }),
]);

export type PoleChudesAction = z.infer<typeof actionSchema>;

interface ActionResult {
  state: PoleChudesState;
  speech?: string;
}

class GameError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export class PoleChudesGame {
  private readonly players: Player[] = [];
  private phase: Phase = "lobby";
  private answer = "";
  private category = "";
  private round = 0;
  private guessed = new Set<string>();
  private hostId: string | undefined;
  private currentPlayerIndex = 0;
  private pendingScore: number | undefined;
  private wheelIndex = 0;
  private rotation = 0;
  private prize: string | undefined;
  private message = "Собирайте игроков. Олег уже загрузился с дискеты.";

  constructor(
    private readonly words: readonly { category: string; answer: string }[] = WORDS,
    private readonly random: () => number = Math.random,
  ) {
    if (!words.length) throw new Error("At least one word is required");
    if (words.some(({ answer }) => !/^[А-ЯЁ-]+$/iu.test(answer))) throw new Error("Answers must be single words");
  }

  apply(action: PoleChudesAction): ActionResult {
    switch (action.type) {
      case "join":
        return this.join(action.playerId, action.name);
      case "start":
        this.requireHost(action.playerId);
        if (this.phase !== "lobby") throw new GameError("Игра уже началась");
        return this.beginRound();
      case "newRound":
        this.requireHost(action.playerId);
        if (this.phase !== "won") throw new GameError("Сначала закончите текущий тур");
        return this.beginRound();
      case "spin":
        return this.spin(action.playerId);
      case "guess":
        return this.guess(action.playerId, action.letter);
      case "solve":
        return this.solve(action.playerId, action.answer);
    }
  }

  hasPlayer(playerId: string): boolean {
    return this.players.some((player) => player.id === playerId);
  }

  snapshot(): PoleChudesState {
    const currentPlayer = this.players[this.currentPlayerIndex];
    return {
      phase: this.phase,
      round: this.round,
      tour: this.round ? (TOURS[this.round - 1] ?? "ФИНАЛ") : "ОЖИДАНИЕ",
      category: this.category,
      puzzle: [...this.answer]
        .map((character) => (!isLetter(character) || this.guessed.has(letterKey(character)) ? character : "_"))
        .join(""),
      ...(this.phase === "won" ? { answer: this.answer } : {}),
      ...(this.prize ? { prize: this.prize } : {}),
      guessed: [...this.guessed].sort((left, right) => LETTERS.indexOf(left) - LETTERS.indexOf(right)),
      players: this.players.map((player) => ({ ...player })),
      ...(this.hostId ? { hostId: this.hostId } : {}),
      ...(currentPlayer && this.phase !== "lobby" ? { currentPlayerId: currentPlayer.id } : {}),
      ...(this.pendingScore !== undefined ? { pendingScore: this.pendingScore } : {}),
      sectors: SECTORS,
      wheelIndex: this.wheelIndex,
      rotation: this.rotation,
      message: this.message,
    };
  }

  private join(playerId: string, name: string): ActionResult {
    const existing = this.players.find((player) => player.id === playerId);
    if (existing) existing.name = name;
    else {
      if (this.players.length >= 6) throw new GameError("За барабаном уже нет свободных мест");
      this.players.push({ id: playerId, name, score: 0 });
      this.hostId ??= playerId;
      this.message = `${name} занимает место у барабана.`;
    }
    return { state: this.snapshot() };
  }

  private beginRound(): ActionResult {
    if (!this.players.length) throw new GameError("Сначала нужен хотя бы один игрок");
    if (this.round >= TOURS.length) {
      this.round = 0;
      for (const player of this.players) player.score = 0;
    }
    const word = this.words[this.pick(this.words.length)];
    if (!word) throw new Error("Word selection failed");
    this.answer = word.answer.toLocaleUpperCase("ru-RU");
    this.category = word.category;
    this.guessed = new Set();
    this.phase = "playing";
    this.pendingScore = undefined;
    this.prize = undefined;
    this.currentPlayerIndex = this.round % this.players.length;
    this.round += 1;
    const current = this.currentPlayer();
    const tour = TOURS[this.round - 1] ?? "ФИНАЛ";
    this.message = `${tour}. Первый ход — ${current.name}. Загадано одно слово.`;
    return {
      state: this.snapshot(),
      speech: `${tour}! Тема: ${this.category}. Загадано одно слово. ${current.name}, крутите барабан!`,
    };
  }

  private spin(playerId: string): ActionResult {
    const player = this.requireTurn(playerId);
    if (this.pendingScore !== undefined) throw new GameError("Сначала назовите букву");
    this.wheelIndex = this.pick(SECTORS.length);
    const sector = SECTORS[this.wheelIndex];
    if (sector === undefined) throw new Error("Wheel selection failed");
    const angle = 360 / SECTORS.length;
    const target = (360 - this.wheelIndex * angle) % 360;
    const current = ((this.rotation % 360) + 360) % 360;
    this.rotation += 4 * 360 + ((target - current + 360) % 360);

    if (sector === "БАНКРОТ") {
      player.score = 0;
      this.message = `${player.name}: банкрот. Все очки сгорели.`;
      this.nextPlayer();
      return { state: this.snapshot(), speech: `Сектор банкрот! ${player.name}, денег не было, а теперь точно нет.` };
    }
    if (sector === "ПЕРЕХОД") {
      this.message = `${player.name}: переход хода.`;
      this.nextPlayer();
      return { state: this.snapshot(), speech: `Сектор ноль! ${player.name} временно становится телезрителем.` };
    }
    if (sector === "X2" || sector === "X4") {
      const multiplier = sector === "X2" ? 2 : 4;
      player.score *= multiplier;
      this.message = `${player.name}: очки умножаются на ${multiplier}.`;
      return {
        state: this.snapshot(),
        speech: `Сектор икс ${multiplier}! У ${player.name} теперь ${player.score} очков. Крутите ещё раз!`,
      };
    }
    if (sector === "ПЛЮС") {
      const hidden = [...new Set([...this.answer].filter(isLetter).map(letterKey))].filter(
        (letter) => !this.guessed.has(letter),
      );
      const letter = hidden[this.pick(hidden.length)];
      if (!letter) return this.win(player, "барабан открыл последнюю букву");
      this.guessed.add(letter);
      if (this.isSolved()) return this.win(player, `сектор «Плюс» открыл букву «${letter}»`);
      this.message = `Сектор «Плюс» открывает букву «${letter}».`;
      return { state: this.snapshot(), speech: `Сектор плюс! Открываем букву «${letter}». Крутите ещё раз!` };
    }
    if (sector === "ПРИЗ") {
      const souvenir = PRIZES[this.pick(PRIZES.length)] ?? PRIZES[0];
      this.message = `${player.name} получает сувенир: ${souvenir}.`;
      return { state: this.snapshot(), speech: `Приз! ${player.name} получает ${souvenir}. И может крутить ещё раз!` };
    }

    this.pendingScore = sector;
    this.message = `${player.name}: ${sector} очков. Называйте букву голосом или кнопкой.`;
    return {
      state: this.snapshot(),
      speech: `${spinLine(this.pick(4))} Сектор ${sector} очков. ${player.name}, называйте букву!`,
    };
  }

  private guess(playerId: string, rawLetter: string): ActionResult {
    const player = this.requireTurn(playerId);
    if (this.pendingScore === undefined) throw new GameError("Сначала крутите барабан");
    const letter = letterKey(rawLetter);
    if (!LETTERS.includes(letter)) throw new GameError("Нужна одна русская буква", 400);
    if (this.guessed.has(letter)) throw new GameError(`Букву «${letter}» уже называли`);
    this.guessed.add(letter);
    const count = [...this.answer].filter((character) => isLetter(character) && letterKey(character) === letter).length;
    const score = this.pendingScore;
    this.pendingScore = undefined;

    if (!count) {
      this.message = `Буквы «${letter}» нет. Переход хода.`;
      this.nextPlayer();
      return { state: this.snapshot(), speech: `Нет буквы «${letter}». А уверенности было на целый алфавит.` };
    }

    player.score += score * count;
    if (this.isSolved()) return this.win(player, `буква «${letter}» открыла всё слово`);
    this.message = `Есть буква «${letter}»: ${count}. ${player.name} получает ${score * count} очков.`;
    return {
      state: this.snapshot(),
      speech: `Есть такая буква! ${count === 1 ? "Одна" : `Целых ${count}`}. ${player.name}, крутите барабан ещё раз.`,
    };
  }

  private solve(playerId: string, answer: string): ActionResult {
    const player = this.requireTurn(playerId);
    this.pendingScore = undefined;
    if (normalizeAnswer(answer) === normalizeAnswer(this.answer)) return this.win(player, "назвал слово целиком");
    this.message = `${player.name} ошибается со словом. Переход хода.`;
    this.nextPlayer();
    return { state: this.snapshot(), speech: "Неверно! Но сказано было так уверенно, что я почти поверил." };
  }

  private win(player: Player, reason: string): ActionResult {
    this.phase = "won";
    this.pendingScore = undefined;
    if (this.round === TOURS.length) this.prize = PRIZES[this.pick(PRIZES.length)] ?? PRIZES[0];
    this.message = `${player.name} выиграл ${TOURS[this.round - 1]?.toLocaleLowerCase("ru-RU")}: ${reason}.`;
    return {
      state: this.snapshot(),
      speech: this.prize
        ? `Финал взят! Слово «${this.answer}». ${player.name}, ваш главный приз — ${this.prize}! Пишите в редакцию, адрес мы потеряли.`
        : `Есть победитель! ${player.name} отгадал слово «${this.answer}». Готовьтесь к следующему туру!`,
    };
  }

  private isSolved(): boolean {
    return [...this.answer].every((character) => !isLetter(character) || this.guessed.has(letterKey(character)));
  }

  private nextPlayer(): void {
    this.pendingScore = undefined;
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
  }

  private currentPlayer(): Player {
    const player = this.players[this.currentPlayerIndex];
    if (!player) throw new GameError("Нет активного игрока");
    return player;
  }

  private requireTurn(playerId: string): Player {
    if (this.phase !== "playing") throw new GameError("Сейчас игра не идёт");
    const player = this.currentPlayer();
    if (player.id !== playerId) throw new GameError(`Сейчас ходит ${player.name}`);
    return player;
  }

  private requireHost(playerId: string): void {
    if (this.hostId !== playerId) throw new GameError("Игру и новые туры запускает первый игрок");
  }

  private pick(length: number): number {
    if (!length) return 0;
    return Math.min(length - 1, Math.floor(Math.max(0, this.random()) * length));
  }
}

export function parsePoleChudesVoiceAction(
  state: PoleChudesState,
  playerId: string,
  rawText: string,
): PoleChudesAction | undefined {
  const text = rawText.toLocaleLowerCase("ru-RU");
  if (!state.players.some((player) => player.id === playerId)) return undefined;
  if (state.phase === "lobby" && /(?:начинай|начать|запускай|старт).*?(?:игр|поле)/iu.test(text)) {
    return { type: "start", playerId };
  }
  if (state.phase === "won" && /(?:дальше|продолжаем|следующ|нов)/iu.test(text)) {
    return { type: "newRound", playerId };
  }
  if (state.phase !== "playing") return undefined;

  const answer = text.match(/(?:слово|ответ)\s*[—:,-]?\s*([а-яё-]{2,50})/iu)?.[1];
  if (answer) return { type: "solve", playerId, answer };

  if (state.pendingScore !== undefined) {
    const namedLetter = text.match(/букв[а-яё]*\s*[«»“”"']?([а-яё])(?:$|[^а-яё])/iu)?.[1];
    const bareLetter = text.trim().match(/^([а-яё])(?:[.!?])?$/iu)?.[1];
    const letter = namedLetter ?? bareLetter;
    if (letter) return { type: "guess", playerId, letter };
  }

  if (/(?:крути|крутите|кручу|вращай|вращайте)(?:\s+барабан)?/iu.test(text)) {
    return { type: "spin", playerId };
  }
  return undefined;
}

interface Room {
  game: PoleChudesGame;
  clients: Set<ServerResponse>;
  lastTouched: number;
}

interface ServerOptions {
  host: string;
  port: number;
  clientId: string;
  botToken: string;
  guildId: string;
  speak: (text: string) => Promise<void>;
}

export interface PoleChudesServer {
  close(): void;
  handleTranscript(transcript: Transcript): boolean;
}

export async function startPoleChudesServer(options: ServerOptions): Promise<PoleChudesServer> {
  const rooms = new Map<string, Room>();
  const verified = new Map<string, number>();
  const activityRoot = resolve("activity");
  const sdkRoot = resolve("node_modules/@discord/embedded-app-sdk/output");
  let speechQueue = Promise.resolve();

  const say = (text: string): void => {
    speechQueue = speechQueue
      .catch(() => undefined)
      .then(() => options.speak(text))
      .catch((error: unknown) => log("error", "pole chudes speech failed", { error: errorMessage(error) }));
  };

  const verifyRoom = async (request: IncomingMessage, roomId: string): Promise<boolean> => {
    if (roomId === "local" && isLocalRequest(request)) return true;
    const now = Date.now();
    if ((verified.get(roomId) ?? 0) > now) return true;
    const response = await fetch(
      `https://discord.com/api/v10/applications/${options.clientId}/activity-instances/${encodeURIComponent(roomId)}`,
      {
        headers: { authorization: `Bot ${options.botToken}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return false;
    const instance = z
      .object({ location: z.object({ guild_id: z.string().optional() }) })
      .safeParse(await response.json());
    if (!instance.success || instance.data.location.guild_id !== options.guildId) return false;
    verified.set(roomId, now + VERIFY_TTL_MS);
    return true;
  };

  const getRoom = (roomId: string): Room => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (!room.clients.size && now - room.lastTouched > ROOM_TTL_MS) rooms.delete(id);
    }
    let room = rooms.get(roomId);
    if (!room) {
      room = { game: new PoleChudesGame(), clients: new Set(), lastTouched: now };
      rooms.set(roomId, room);
    }
    room.lastTouched = now;
    return room;
  };

  const handleTranscript = (transcript: Transcript): boolean => {
    const room = [...rooms.values()]
      .filter((candidate) => candidate.game.hasPlayer(transcript.userId))
      .sort((left, right) => right.lastTouched - left.lastTouched)[0];
    if (!room) return false;
    const action = parsePoleChudesVoiceAction(room.game.snapshot(), transcript.userId, transcript.text);
    if (!action) {
      if (!/(?:букв|слово|ответ|барабан|тур|игр)/iu.test(transcript.text)) return false;
      say("Не расслышал игровую команду. Скажите, например: «буква А», «крути барабан» или «ответ — капибара».");
      return true;
    }
    try {
      const result = room.game.apply(action);
      room.lastTouched = Date.now();
      broadcast(room, result.state);
      if (result.speech) say(result.speech);
      log("info", "pole chudes voice action", { user: transcript.user, action: action.type });
    } catch (error: unknown) {
      if (!(error instanceof GameError))
        log("error", "pole chudes voice action failed", { error: errorMessage(error) });
      say(error instanceof GameError ? error.message : "Олег уронил карточки со словом. Попробуйте ещё раз.");
    }
    return true;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        serveAsset(response, url.pathname, activityRoot, sdkRoot, options.clientId);
        return;
      }

      const roomId = roomIdSchema.parse(url.searchParams.get("room"));
      if (!(await verifyRoom(request, roomId))) throw new GameError("Discord Activity не подтверждена", 403);
      const room = getRoom(roomId);

      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        room.clients.add(response);
        response.write(`data: ${JSON.stringify(room.game.snapshot())}\n\n`);
        request.once("close", () => room.clients.delete(response));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/action") {
        const parsed = actionSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new GameError("Некорректное действие", 400);
        const result = room.game.apply(parsed.data);
        broadcast(room, result.state);
        sendJson(response, 200, result.state);
        if (result.speech) say(result.speech);
        return;
      }

      sendJson(response, 404, { error: "not found" });
    })().catch((error: unknown) => {
      const status = error instanceof GameError ? error.status : error instanceof z.ZodError ? 400 : 500;
      log(status === 500 ? "error" : "info", "pole chudes request rejected", {
        status,
        path: request.url,
        error: errorMessage(error),
      });
      if (!response.headersSent) sendJson(response, status, { error: errorMessage(error) });
      else response.destroy();
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  log("info", "pole chudes activity started", { url: `http://${options.host}:${options.port}` });
  return { close: () => server.close(), handleTranscript };
}

const roomIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w-]+$/u);

function broadcast(room: Room, state: PoleChudesState): void {
  const message = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of room.clients) client.write(message);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new GameError("Слишком большой запрос", 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GameError("Некорректный JSON", 400);
  }
}

function serveAsset(
  response: ServerResponse,
  pathname: string,
  activityRoot: string,
  sdkRoot: string,
  clientId: string,
): void {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const root = relative.startsWith("sdk/") ? sdkRoot : activityRoot;
  const asset = resolve(root, relative.startsWith("sdk/") ? relative.slice(4) : relative);
  if (!asset.startsWith(`${root}${sep}`)) throw new GameError("not found", 404);
  let body: Buffer | string;
  try {
    body = readFileSync(asset);
  } catch {
    throw new GameError("not found", 404);
  }
  if (relative === "index.html") body = body.toString("utf8").replace("__DISCORD_CLIENT_ID__", clientId);
  response.writeHead(200, {
    "content-type": contentType(asset),
    "cache-control": relative === "index.html" ? "no-cache" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isLocalRequest(request: IncomingMessage): boolean {
  if (request.headers["x-forwarded-for"]) return false;
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLetter(character: string): boolean {
  return LETTERS.includes(letterKey(character));
}

function letterKey(character: string): string {
  return character.toLocaleUpperCase("ru-RU");
}

function normalizeAnswer(value: string): string {
  return value
    .toLocaleUpperCase("ru-RU")
    .replace(/Ё/gu, "Е")
    .replace(/[^А-Я-]+/gu, "");
}

function spinLine(index: number): string {
  return (
    [
      "Крутите барабан! Только не оторвите, он казённый.",
      "Барабан, покажи человеку его финансовое будущее.",
      "Вращайте барабан! Пока электричество не подорожало.",
      "Барабан пошёл. Интеллектуальная передача временно приостановлена.",
    ][index] ?? "Крутите барабан!"
  );
}
