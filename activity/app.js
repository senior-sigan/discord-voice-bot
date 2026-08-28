import { DiscordSDK } from "/sdk/index.mjs";

const alphabet = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
const elements = {
  answer: document.querySelector("#answer"),
  category: document.querySelector("#category"),
  connection: document.querySelector("#connection"),
  controls: document.querySelector("#game-controls"),
  identity: document.querySelector("#identity"),
  joinForm: document.querySelector("#join-form"),
  letters: document.querySelector("#letters"),
  message: document.querySelector("#message"),
  newRound: document.querySelector("#new-round"),
  players: document.querySelector("#players"),
  prize: document.querySelector("#prize"),
  puzzle: document.querySelector("#puzzle"),
  solveForm: document.querySelector("#solve-form"),
  spin: document.querySelector("#spin"),
  start: document.querySelector("#start"),
  tour: document.querySelector("#tour"),
  wheel: document.querySelector("#wheel"),
};

let roomId;
let playerId = sessionStorage.getItem("pole-chudes-player") ?? undefined;
let state;
let joined = false;
let wheelReady = false;

try {
  const setup = await resolveActivity();
  roomId = setup.roomId;
  renderIdentities(setup.participants);
  const events = new EventSource(`/api/events?room=${encodeURIComponent(roomId)}`);
  events.onopen = () => setConnection(roomId === "local" ? "ЛОКАЛЬНАЯ РЕПЕТИЦИЯ" : "СТУДИЯ В ЭФИРЕ", true);
  events.onerror = () => setConnection("СВЯЗЬ СО СТУДИЕЙ ПОТЕРЯНА", false);
  events.onmessage = (event) => {
    state = JSON.parse(event.data);
    render();
  };
} catch (error) {
  const message = error instanceof Error ? error.message : "Не удалось войти в студию";
  console.error(error);
  setConnection(`ОШИБКА: ${message}`, false);
}

elements.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const option = elements.identity.selectedOptions[0];
  if (!option?.value) return;
  playerId = option.value;
  if (!(await act({ type: "join", playerId, name: option.dataset.name ?? option.textContent }))) return;
  sessionStorage.setItem("pole-chudes-player", playerId);
  joined = true;
  render();
});

elements.start.addEventListener("click", () => act({ type: "start", playerId }));
elements.newRound.addEventListener("click", () => act({ type: "newRound", playerId }));
elements.spin.addEventListener("click", () => act({ type: "spin", playerId }));
elements.solveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!elements.answer.value.trim()) return;
  await act({ type: "solve", playerId, answer: elements.answer.value });
  elements.answer.value = "";
});

async function resolveActivity() {
  if (["localhost", "127.0.0.1"].includes(location.hostname) && window.parent === window) {
    const id = playerId ?? crypto.randomUUID();
    return { roomId: "local", participants: [{ id, name: "Локальный игрок" }] };
  }
  const clientId = document.querySelector('meta[name="discord-client-id"]').content;
  const discord = new DiscordSDK(clientId);
  await discord.ready();
  if (!discord.instanceId) throw new Error("Discord не передал instance_id. Запустите игру как Activity.");
  const { participants } = await discord.commands.getInstanceConnectedParticipants();
  const humans = participants
    .filter((participant) => !participant.bot)
    .map((participant) => ({
      id: participant.id,
      name: participant.nickname ?? participant.global_name ?? participant.username,
    }));
  if (!humans.length) throw new Error("Discord не передал участников Activity. Перезапустите игру.");
  return { roomId: discord.instanceId, participants: humans };
}

function renderIdentities(participants) {
  elements.identity.replaceChildren();
  for (const participant of participants) {
    const option = document.createElement("option");
    option.value = participant.id;
    option.dataset.name = participant.name;
    option.textContent = participant.name;
    option.selected = participant.id === playerId;
    elements.identity.append(option);
  }
  if (!elements.identity.value && participants[0]) elements.identity.value = participants[0].id;
}

async function act(action) {
  if (!roomId || !action.playerId) return false;
  setConnection("ОЛЕГ СВЕРЯЕТСЯ С КАРТОЧКОЙ…", false);
  try {
    const response = await fetch(`/api/action?room=${encodeURIComponent(roomId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    const result = await response.json();
    if (!response.ok) {
      setConnection(`ОШИБКА: ${result.error ?? "Что-то пошло не так"}`, false);
      return false;
    }
    state = result;
    setConnection(roomId === "local" ? "ЛОКАЛЬНАЯ РЕПЕТИЦИЯ" : "СТУДИЯ В ЭФИРЕ", true);
    render();
    return true;
  } catch (error) {
    console.error(error);
    setConnection("ОШИБКА: СВЯЗЬ СО СТУДИЕЙ ПОТЕРЯНА", false);
    return false;
  }
}

function setConnection(message, online) {
  elements.connection.textContent = message;
  elements.connection.classList.toggle("online", online);
}

function render() {
  if (!state) return;
  joined = Boolean(playerId && state.players.some((player) => player.id === playerId));
  elements.joinForm.hidden = joined;
  elements.controls.hidden = !joined;
  elements.category.textContent = state.category || "ОЖИДАЕМ ИГРОКОВ";
  elements.tour.textContent = state.tour;
  elements.message.textContent = state.message;
  elements.prize.textContent = state.prize ? `ГЛАВНЫЙ ПРИЗ: ${state.prize}` : "";
  elements.prize.hidden = !state.prize;
  renderPuzzle();
  renderWheel();
  renderPlayers();
  renderLetters();

  const myTurn = state.phase === "playing" && state.currentPlayerId === playerId;
  elements.spin.disabled = !myTurn || state.pendingScore !== undefined;
  elements.answer.disabled = !myTurn;
  elements.solveForm.querySelector("button").disabled = !myTurn;
  elements.start.hidden = state.phase !== "lobby" || state.hostId !== playerId;
  elements.newRound.hidden = state.phase !== "won" || state.hostId !== playerId;
  elements.newRound.textContent = state.round >= 3 ? "НОВАЯ ИГРА" : "СЛЕДУЮЩИЙ ТУР";
}

function renderPuzzle() {
  elements.puzzle.replaceChildren();
  for (const character of state.puzzle || "ПОЛЕЧУДЕС") {
    const cell = document.createElement("span");
    cell.className = character === "_" ? "letter-cell hidden-letter" : "letter-cell";
    cell.textContent = character === "_" ? "" : character;
    elements.puzzle.append(cell);
  }
}

function renderWheel() {
  if (!wheelReady) {
    elements.wheel.style.setProperty("--sector-count", state.sectors.length);
    for (const [index, sector] of state.sectors.entries()) {
      const label = document.createElement("span");
      label.style.setProperty("--index", index);
      label.textContent = sector === "ПЕРЕХОД" ? "0" : sector === "БАНКРОТ" ? "☠" : sector;
      elements.wheel.append(label);
    }
    elements.wheel.style.transition = "none";
    elements.wheel.style.transform = `rotate(${state.rotation}deg)`;
    requestAnimationFrame(() => {
      elements.wheel.style.transition = "";
    });
    wheelReady = true;
    return;
  }
  elements.wheel.style.transform = `rotate(${state.rotation}deg)`;
}

function renderPlayers() {
  elements.players.replaceChildren();
  for (const player of state.players) {
    const item = document.createElement("li");
    if (player.id === state.currentPlayerId) item.className = "active";
    const portrait = document.createElement("span");
    portrait.className = "portrait";
    portrait.textContent = player.name.slice(0, 1).toLocaleUpperCase("ru-RU");
    const name = document.createElement("span");
    name.textContent = `${player.id === state.hostId ? "★ " : ""}${player.name}${player.id === playerId ? " (ВЫ)" : ""}`;
    const score = document.createElement("strong");
    score.textContent = `${player.score}`;
    item.append(portrait, name, score);
    elements.players.append(item);
  }
}

function renderLetters() {
  elements.letters.replaceChildren();
  const canGuess = state.phase === "playing" && state.currentPlayerId === playerId && state.pendingScore !== undefined;
  for (const letter of alphabet) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = letter;
    button.disabled = !canGuess || state.guessed.includes(letter);
    if (state.guessed.includes(letter)) button.className = "used";
    button.addEventListener("click", () => act({ type: "guess", playerId, letter }));
    elements.letters.append(button);
  }
}
