# Agent Harness Best Practices

Этот документ — справочник архитектурных паттернов для создания agent harness:
agent loop, tools, skills, история, память, автономность, восстановление и
voice-first интерфейс. Примеры основаны на Pi, Hermes Agent, Apache Maka,
LiveKit Agents JS, Pipecat и Letta Code. Конкретная архитектура отдельного
проекта описывается отдельно.

Каталоги reference-проектов находятся в `.gitignore`: ссылки ниже работают в
локальной копии проекта.

## Как читать документ

Документ разделён на пять частей:

1. **Карта подходов** показывает, какие задачи подробно раскрывает каждый
   reference-проект.
2. **Voice-first граница** фиксирует интерфейс между audio transport и
   текстовым agent core.
3. **Синтез архитектурных паттернов** собирает общие границы runtime без
   привязки к конкретной реализации.
4. **Исследования reference-проектов** описывают механизмы и инварианты,
   подтверждённые исходным кодом.
5. **Индекс исходников** ведёт к конкретным реализациям, тестам и design docs.

Best practice в этом справочнике — не название класса или библиотеки, а
проверяемое свойство системы: корректная отмена, непротиворечивая история,
bounded context, явная authority, восстановимый outcome или измеримая latency.

## Сравниваемые подходы

| Проект | Центр архитектуры | Особенно подробно реализовано |
|---|---|---|
| Pi | Компактный библиотечный agent loop | Типизированные tools, события, streaming, steering и follow-up |
| Hermes Agent | Автономный прикладной harness | Tool registry, progressive disclosure, skills, guards, gateways и VM-oriented capabilities |
| Apache Maka | Долговечный execution runtime | Канонический event log, projections, permissions, crash recovery, compaction и graph scheduling |
| LiveKit Agents JS | Realtime voice session runtime | Turn detection, endpointing, interruptions, preemptive generation и синхронизация transcript с playout |
| Pipecat | Frame-based voice pipeline | Приоритетные control frames, двунаправленный dataflow, turn strategies и поведенческие audio evals |
| Letta Code | Stateful long-horizon harness | Git-backed memory, reflection subagents, local/remote backends, channels и message search |

Проекты описывают разные оси harness: model/tool loop, рост capabilities,
долговечность исполнения, realtime voice, потоковую композицию и память на
длинном горизонте. Один runtime может сочетать несколько таких механизмов.

## Карта паттернов

| Задача | Основные паттерны | Reference-проекты |
|---|---|---|
| Model/tool loop | Streaming events, parallel/sequential tools, steering, terminal facts | Pi, Hermes, Maka |
| Tool surface | Typed contracts, permissions, progressive disclosure, recovery semantics | Pi, Hermes, Maka |
| Voice turn | VAD/STT separation, endpointing, wake phrase, follow-up window | LiveKit Agents JS, Pipecat |
| Barge-in | Общая cancellation chain, playout state, uninterruptible terminal facts | LiveKit Agents JS, Pipecat, Hermes |
| История и context | Канонический journal, provider projection, compaction, raw tail | Maka, Letta Code, Pi |
| Long-term memory | Evidence, context tiers, versioned writes, background reflection | Hermes, Maka, Letta Code |
| Автономность | Budgets, guards, pending interactions, schedules, subagents | Hermes, Maka, Letta Code |
| Channels и transport | Session boundary, routing, access control, idempotent delivery | LiveKit Agents JS, Letta Code |
| Recovery | T1/T2, retry/reconcile/resume/park, durable terminal outcome | Maka, Letta Code |
| Observability и eval | Turn latency, playout metrics, audio scenarios, event projections | LiveKit Agents JS, Pipecat, Maka |

## Voice-first граница

Внутри агент остаётся текстовым: STT создаёт сообщения, LLM создаёт текстовые
дельты и tool calls, TTS превращает ответ в аудио. Снаружи текстового UI нет —
единственный пользовательский интерфейс агента состоит из голосового канала,
ключевого слова и возможности перебить речь.

```text
Discord audio
    ↓
STT: отдельный поток речи каждого участника
    ↓
VoiceSession: история, wake word, stop/barge-in
    ↓
Agent core: LLM → tools → LLM, пока не получен финальный ответ
    ├── text delta ──────→ SentenceChunker → TTS → Discord audio
    ├── tool start ──────→ короткое голосовое уведомление
    ├── tool update ─────→ редкое существенное обновление
    └── agent end ───────→ завершение голосового хода
```

Discord, STT и TTS не должны знать о формате API конкретной LLM. Tools не
должны напрямую воспроизводить речь. Голосовой слой подписывается на события
агентного ядра и решает, что и когда произнести.

## Синтез архитектурных паттернов

### Рабочий словарь

| Понятие | Граница |
|---|---|
| Session | Долгоживущий разговор и его durable history |
| Turn | Один пользовательский обмен, начатый сообщением или voice activation |
| Run | Конкретная попытка выполнить Turn через model/tool loop |
| Speech | Отдельная единица синтеза и playout с собственным состоянием отмены |
| Invocation | Логическая связь model step, tool calls и последующего ответа |
| Operation | Одна попытка внешнего side effect с отдельным recovery outcome |
| Interaction | Ожидаемый ответ или permission от человека внутри активного Run |
| Projection | Производное представление канонических событий для LLM, UI или recovery |

Не каждый harness обязан хранить эти сущности отдельными классами. Различие
важно там, где у них разные lifecycle, retry или persistence semantics.

### Сквозные инварианты

1. Один execution path владеет model calls, tools, stop и terminal outcome.
2. Derived state строится из зафиксированных событий, а не заменяет их.
3. Tool call и tool result сохраняют точные IDs и допустимую provider sequence.
4. User stop проходит одной cancellation chain через LLM, tools, TTS и playout.
5. История различает generated output, delivered output и durable outcome.
6. Внешний side effect не повторяется без declared retry/reconcile semantics.
7. Permissions и availability повторно проверяются на execute boundary.
8. Raw journal, provider context и curated memory остаются разными слоями.
9. Prompt, tool schemas, skill catalog и tool results имеют явные бюджеты.
10. Долгие операции публикуют progress, поддерживают abort и имеют terminal
    result даже после timeout, interruption или crash.

### Слои voice-first harness

```text
voice transport         join/leave, audio receive, playback
speech boundary         STT streams, VAD, speaker identity, TTS chunking
voice session           wake word, pending interaction, barge-in, active turn

agent runtime           model/tool loop, events, abort, steering, terminal facts
model adapter           provider protocol, capabilities, reasoning metadata
tool runtime            validation, availability, permissions, execution, recovery
skill catalog           discovery, precedence, search and lazy body loading

event journal           canonical conversation/execution facts
context projection      provider-valid messages and compaction checkpoints
curated memory          evidence-backed durable facts and preferences

host boundary           lifecycle, credentials, admission and client protocol
optional graph          child sessions, schedule, claims and supervisor wakes
```

Границы модулей отражают разные причины изменения. Интерфейс особенно полезен
там, где существуют несколько реализаций, process/network boundary или
отдельный test adapter. Один локальный backend может оставаться конкретным
классом без factory и registry.

### Возможная последовательность реализации

Каждый этап сохраняет runnable vertical slice:

1. Один model/tool loop с точными message и tool-call semantics.
2. Tools как независимые объекты со schema, abort и structured result.
3. Lifecycle events и terminal facts вокруг каждого Turn/Run.
4. Conversation journal отдельно от provider message projection.
5. Voice streaming через sentence chunker и единую цепочку cancellation.
6. Skills manifest и lazy read-only loader.
7. Context budgeting, raw recent tail и durable compaction checkpoint.
8. Curated memory с evidence и explicit provenance.
9. Permissions, durable tool boundary и recovery semantics для side effects.
10. Tool groups/search, plugins, MCP, scheduled work и agent graph по мере
    появления соответствующих execution surfaces.

### Паттерны с отдельной эксплуатационной стоимостью

Следующие возможности меняют trust или durability boundary и рассматриваются
как самостоятельные подсистемы:

- динамическая загрузка исполняемых extensions и plugins;
- MCP servers и внешние tool catalogs;
- self-modifying skills и memory;
- scheduled/background turns;
- subagents и graph scheduling;
- sandbox expansion и human approval;
- автоматический retry внешних side effects;
- cloud embeddings и внешнее долговременное хранилище;
- multi-process Runtime Host и удалённые клиенты.

Для каждой такой подсистемы фиксируются authority, permissions, persistence,
cancel/recovery semantics, observability и поведение после crash.

## Исследования reference-проектов

### Pi: агентный цикл как библиотека

Pi разделён на небольшие пакеты `@earendil-works/pi-agent-core`,
`@earendil-works/pi-ai` и более крупную продуктовую оболочку
`pi-coding-agent`. Такое разделение показывает границу между reusable loop и
конкретным интерфейсом разработчика.

#### Агентный цикл отдельно от продукта

Pi отделяет модель, сообщения, tools, состояние и события от TUI. Один и тот же
цикл благодаря этому может обслуживать TUI, API, bot gateway или голосовую
оболочку.

Характерное поведение цикла:

- цикл сам продолжает LLM после tool results;
- один ответ модели может вызвать несколько tools;
- независимые tools могут выполняться параллельно;
- изменяющие общее состояние tools выполняются последовательно;
- все операции получают `AbortSignal`;
- пользователь может остановить ход или добавить steering-сообщение;
- оболочка получает события `message_update`, `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`, `agent_end`;
- ошибки tools возвращаются модели как корректные tool results, а не ломают
  весь ход.

#### Tool как объект, а не ветка большого switch

Минимальный смысловой контракт tool:

```ts
interface AgentTool<Args, Details> {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  executionMode?: "parallel" | "sequential";
  execute(
    callId: string,
    args: Args,
    signal?: AbortSignal,
    onUpdate?: (result: ToolResult<Details>) => void,
  ): Promise<ToolResult<Details>>;
}
```

Каждый tool должен владеть своей схемой, валидацией и реализацией. Общий
dispatcher отвечает только за поиск по имени, логирование, lifecycle events и
преобразование исключения в tool result.

Небольшой набор tools можно компоновать обычным массивом объектов. Registry,
toolsets и discovery становятся отдельными паттернами, когда появляются
несколько источников tools, plugins, MCP или динамическая доступность.

#### AgentMessage не равен записи пользовательского журнала

LLM-сессия должна сохранять точные роли, tool call IDs и tool results. Журнал
голосового разговора хранит имена участников и удобен для поиска. Это разные
представления, даже если часть текста в них совпадает.

#### События — граница голосового интерфейса

Голосовая реализация не должна ждать итоговую строку `complete()`. Она получает
дельты от agent core, собирает законченные фразы и начинает TTS до завершения
всего ответа.

### Hermes Agent: capabilities и автономность

#### Узкое ядро, возможности по краям

Новые возможности сначала оформляются как skill или отдельный tool. System
prompt и постоянный набор core tools должны оставаться небольшими и стабильными.

Предпочтительный порядок расширения:

1. использовать существующий tool;
2. добавить или расширить skill;
3. добавить обычный tool;
4. добавить условно доступный tool/toolset;
5. только при реальной необходимости вводить plugin или MCP.

#### Progressive disclosure для skills

В system prompt помещаются только `name` и `description`. Полный `SKILL.md`
загружается инструментом `skill_view`, когда задача совпала с описанием.

```text
skills/
  web-research/
    SKILL.md
    references/
  conversation-memory/
    SKILL.md
  weather/
    SKILL.md
```

Skill описывает процедуру и правила применения существующих tools. Он не
является исполняемым кодом и не должен напрямую регистрировать capabilities.

Harness без общего файлового `read` может предоставлять специальный
`skill_view`, возвращающий только разрешённые инструкции и связанные resources.

Read-only skills и изменяемые skills образуют разные trust boundaries.
Write-enabled режим требует валидации, журнала изменений и явной политики
разрешений.

#### История, сессия и память — разные слои

Нужно разделить три вида долговременного состояния:

1. **Conversation journal** — все транскрипции, ответы и вызовы tools; источник
   для `recall_history` и аудита.
2. **Agent session** — точная последовательность LLM messages, tool calls и
   tool results; позволяет корректно продолжить незавершённый ход.
3. **Curated memory** — небольшой набор устойчивых фактов и предпочтений,
   загружаемый в prompt: имена, отношения, договорённости, вкусы.

Полный журнал нельзя без ограничений помещать в prompt. Curated memory нельзя
автоматически считать правдой без ограничений размера и защиты от prompt
injection. Ошибка записи памяти не должна мешать агенту ответить пользователю.

#### Автономность с бюджетом и отменой

В voice-first интерфейсе автономность может быть ограничена одним активированным
ходом: после wake word агент самостоятельно продолжает tool loop до результата,
но новый голосовой ход не начинает без события активации.

Каждый голосовой ход должен иметь:

- `AbortController`;
- общий wall-clock deadline;
- достаточно большой iteration budget;
- отдельные timeouts tools и LLM;
- защиту от повторяющихся одинаковых вызовов;
- восстановление после пустого или reasoning-only ответа;
- отказ от выполнения обрезанных/невалидных аргументов;
- корректное завершение message/tool role sequence при остановке.

Команды «Олег, стой», «Олег, остановись» и «Олег, хватит» должны одновременно
останавливать аудио, LLM stream и выполняемые tools. Следующая реплика должна
сообщать модели, что предыдущую речь перебили, но эта служебная пометка не
должна попадать в постоянный пользовательский журнал.

Cron и фоновые инициативы требуют отдельного delivery contract: в голосовом
канале может не быть слушателя. Результат можно сохранять в inbox и озвучивать
при следующем обращении или подключении пользователя.

#### Потоковый TTS режется по фразам

Нельзя синтезировать каждый токен отдельно и нельзя ждать весь ответ. Текстовые
дельты складываются в буфер; законченная фраза передаётся TTS, пока LLM
продолжает генерировать следующую.

Правила chunker:

- границы после `.`, `!`, `?` и абзаца;
- короткие фрагменты объединяются со следующей фразой;
- `<think>...</think>` никогда не озвучивается;
- хвост буфера озвучивается при завершении ответа;
- отмена идемпотентна, поздние дельты отбрасываются;
- после частично произнесённого ответа нельзя проигрывать весь ответ заново.

### Apache Maka: долговечный execution runtime

Maka проводит одну execution authority через Desktop, CLI, TUI, bots и eval.
Клиенты обращаются к Runtime Host и не реализуют собственные варианты agent
loop, permissions, persistence или recovery. Это отделяет транспорт и продуктовый
интерфейс от семантики исполнения.

```text
Desktop / CLI / Bot
        ↓
Runtime Host
        ↓
SessionManager → RuntimeKernel → AgentRun
                              ├── ModelAdapter
                              ├── ToolRuntime
                              └── Runtime Event Log
                                          ↓
                         context / UI / recovery projections
```

#### Event log как источник семантической истины

В Maka журнал — не диагностический след после выполнения бизнес-логики, а
канонический набор фактов, из которого строятся остальные представления:

```text
State(t) = Project(RuntimeEvents[0..t], policy, runtime configuration)
```

`RuntimeEvent` хранит несколько независимых измерений:

- identity: `sessionId`, `turnId`, `runId`, `invocationId`, branch;
- ordering: event ID, timestamp и позицию в ledger;
- model role и фактического автора события;
- text, thinking, function call, function response или error;
- tool, permission, usage, artifact и terminal actions;
- корреляцию с provider event, tool call, operation и step;
- `partial` и terminal status.

Из одного лога строятся LLM history, UI transcript, tool timeline, terminal
state, recovery plan и compacted context. Проекции могут меняться и
перестраиваться; исходные факты сохраняют прежнюю семантику.

Provider-native replay и semantic replay различаются. Для нативного replay
могут понадобиться signed thinking, provider metadata и исходная форма tool
result. Bit-exact повтор HTTP-запроса дополнительно требует версии system
prompt, tool schemas, provider options и request projection policy.

#### Session, Turn, Run и Operation

Несколько identities не следует объединять в один общий `conversationId`:

| Identity | Вопрос |
|---|---|
| Session | Какому долгоживущему разговору принадлежит работа? |
| Turn | Какой пользовательский обмен представлен? |
| Run | Какая конкретная попытка выполнения идёт или завершилась? |
| Invocation | Какой model/tool flow связывает события? |
| Operation | Какая конкретная попытка side effect выполнялась? |

Voice-first отображение может считать подключение или постоянную историю
Session, обращение по wake word — Turn, а LLM/tool/TTS выполнение — Run.
Команда остановки завершает Run, не уничтожая Session.

#### Terminal fact раньше terminal state

Завершение фиксируется отдельным каноническим событием. Только после его
durable commit обновляются Run header, Turn status и UI projection. Если процесс
падает между этими действиями, derived state можно восстановить из terminal
fact. Первый принятый terminal event закрывает Run; поздние provider events не
переписывают результат после stop или failure.

Для voice pipeline полезно различать как минимум:

- модель закончила генерацию текста;
- все tool calls получили результаты;
- TTS синтезировал очередь;
- аудио было произнесено полностью или прервано пользователем.

#### Tool side effects ограничены T1 и T2

Maka разделяет проверки, внешний side effect и запись результата:

```text
validate args / availability / permissions
        ↓
T1: durable tool-dispatch fact
        ↓
tool implementation and external side effect
        ↓
T2: durable function-response fact
        ↓
result becomes visible to the model
```

T1 означает только то, что выполнение прошло preflight и implementation мог
стартовать. T2 подтверждает канонический outcome. Падение между T1 и T2 создаёт
не `failed`, а неопределённое состояние, которое требует reconcile или park.

Tool contract может объявлять recovery semantics:

- `replay_safe` — вызов безопасно повторить;
- `idempotent` — повтор имеет тот же эффект;
- `reconcile` — внешний результат можно проверить;
- `reattach` — можно продолжить наблюдение за существующей операцией;
- `outcome_unknown` — результат нельзя доказать автоматически;
- `never_auto_retry` — автоматический повтор запрещён.

Tool runtime также централизует validation, execute-boundary availability,
permissions, abort, timeout, repeated-failure guard, progress, telemetry и
преобразование ожидаемых ошибок в provider-visible tool results.

#### Resume, retry и reconcile

После падения нельзя восстановить старый Promise, HTTP stream, JavaScript stack
или OS process. Resume создаёт новый Run из проверенной durable boundary.

- **Repair** согласует terminal event, Run header и Turn state старого Run.
- **Retry** повторяет операцию и допустим только при известных semantics.
- **Reconcile** наблюдает внешний мир и пытается доказать outcome.
- **Resume** создаёт новый execution с проверенной историей и свежими IDs.
- **Park** сохраняет факты и останавливает автоматику при недостатке
  доказательств.

Отсутствующий tool result не доказывает, что implementation не запускался.
Workspace identity также доказывает только логическую идентичность workspace,
а не неизменность всех его файлов.

#### Compaction является проекцией, а не изменением истории

Context compaction не удаляет и не переписывает исходные RuntimeEvents.
Checkpoint связывается с упорядоченным префиксом истории и хранит:

- границу последнего покрытого event;
- число покрытых events и turns;
- digest стабильной сериализации исходного префикса;
- predecessor checkpoint;
- compacted text или provider-native opaque state;
- ограничения и token estimate.

Модель получает `checkpoint + uncovered raw tail + current turn`. Rolling
checkpoint складывает предыдущую summary и только что вытесненные события, не
пересказывает весь журнал заново. Перед replay проверяются source digest,
coverage и соответствие текущему context budget.

Большой tool result можно сначала сохранить в archive, а в provider context
оставить ограниченный reference. Инструмент чтения архива возвращает деталь по
запросу модели. Архив и summary не становятся новым источником истины.

#### Ожидание пользователя — состояние runtime

Question и permission request являются first-class interactions. Активный Run
может перейти в `waiting_for_user`, а ответ возвращается в тот же tool flow.
Pending interaction должен восстанавливаться из durable state, даже если клиент
пропустил live event.

В голосовом интерфейсе это создаёт follow-up окно: после вопроса агента
следующая реплика может отвечать на ожидающий interaction без повторного wake
word. В групповом канале policy дополнительно определяет допустимого ответчика,
таймаут и поведение при одновременных ответах.

#### Skill catalog и capability gating

Maka совмещает filesystem skills с более формальной catalog policy:

- полный inventory отделён от winner catalog;
- scope-aware ref отличает project, workspace и user copies;
- precedence и shadowing разрешаются детерминированно;
- disabled и host-incompatible skills не рекламируются модели;
- `required-tools` и `required-capabilities` проверяют совместимость, но не
  выдают разрешений;
- pinned skills располагаются первыми;
- каталог получает ограниченную долю context window;
- пропущенные из prompt skills остаются доступны через metadata-only search;
- body загружается отдельным `Skill` tool;
- explicit skill invocation возвращает bounded receipt.

Skill instructions считаются user-provided content с приоритетом ниже system,
developer, safety и permission rules. Они не могут добавлять tools, ослаблять
permissions или раскрывать secrets.

#### Групповая progressive disclosure для tools

Вместо поиска по каждой tool schema Maka поддерживает группы capabilities.
Всегда доступный `load_tools` показывает названия и описания групп, а schemas
их участников подключаются к следующему model step после активации.

```text
core: time, recall, load_tools
web: web_search, web_fetch
browser: open, click, type, screenshot
calendar: find_events, create_event
```

Активации восстанавливаются из Runtime Event Log. Execute boundary повторно
проверяет, что вызванный tool входил в активную поверхность текущего step.
Другой вариант progressive disclosure — Hermes `tool_search`, который подходит
для плоского или динамического каталога без заранее известных групп.

#### Memory требует evidence и provenance

Maka отделяет journal, compaction checkpoint и long-term memory. В текущем
extraction contract доказательством служит только user-authored text; ответы
ассистента, reasoning, tool calls, tool results и runtime control facts не
становятся фактами о пользователе.

Memory item связывается с source references и дословными evidence fragments.
Proposal модели проходит deterministic validation и canonicalization до записи.
Explicit «запомни» и фоновая extraction имеют разные origins и receipts.

Для STT полезно сохранять confidence, speaker и исходную transcript boundary:
ошибочно распознанная фраза остаётся частью журнала, но её автоматическое
повышение до curated memory регулируется отдельной policy подтверждения.

#### Graph — schedule поверх существующего runtime

Maka Agent Graph не создаёт второй agent loop. Каждый operator является
долгоживущей child Session, каждая activation — обычным AgentRun, а данные
ссылаются только на committed RuntimeEvents.

Graph control plane хранит topology, schedule revisions, readiness intents,
admission claims и supervisor wakes. Runtime по-прежнему владеет model calls,
tools, permissions, history и terminal facts. Claim выполняется до execution и
связывает deterministic intent с заранее выделенными Turn/Run IDs.

Root agent находится рядом с data path как supervisor: наблюдает, добавляет или
останавливает работу и синтезирует итог. Child agents не обязаны передавать
каждый event через root. В voice-first оболочке только root session передаёт
текст в TTS; tools и child agents публикуют результаты в agent core.

#### Provider capability является точным контрактом

Maka различает обычный function calling и provider-hosted tools. Например,
наличие OpenAI-compatible Chat Completions не доказывает поддержку Responses
`web_search`. Capability вычисляется по конкретным provider, protocol и model.

Выбор hosted search или client-executed search делается явно и не использует
скрытый fallback. Provider-native calls сохраняют нормализованный result для
проекций и opaque provider output для корректного replay.

### LiveKit Agents JS: realtime voice как отдельный runtime

LiveKit Agents JS размещает voice orchestration между transport и обычным
agent/model layer. `AgentSession` владеет жизненным циклом разговора, а
`AgentActivity` выполняет конкретные речевые ходы: распознавание активности,
STT, endpointing, LLM, tools, TTS и playout.

#### Turn handling состоит из независимых решений

Начало речи, завершение реплики и перебивание ответа не являются одним
сигналом. Конфигурация разделяет:

- turn detection: realtime model, VAD, STT или manual commit;
- endpointing: минимальная и максимальная задержка перед завершением хода;
- interruption: допустимость, минимальная длительность и число слов;
- false interruption: пауза и возможное продолжение оборванной речи;
- preemptive generation: ранний запуск LLM и, отдельно, TTS.

Dynamic endpointing корректирует задержку по наблюдаемым ходам и отдельно
учитывает немедленные и запоздалые interruptions. Благодаря этому VAD остаётся
сигналом активности, а semantic end-of-turn — отдельным policy decision.

#### Preemptive generation является спекулятивной

LLM может начать генерацию по промежуточному transcript до подтверждения конца
реплики. После финализации хода результат используется только если совпали:

- нормализованный transcript;
- chat context;
- набор tools;
- tool choice.

Иначе спекулятивный `SpeechHandle` отменяется и создаётся обычная генерация.
Число попыток и максимальная длительность речи ограничены. Такой механизм
снижает latency, не превращая промежуточное распознавание в канонический input.

#### История учитывает состояние playout

Каждый сегмент playout получает состояние `skipped`, `partial` или `full`.
При interruption runtime очищает audio buffer и получает playback position.
Полностью несыгранные сообщения удаляются из provider context; частично
сыгранные отмечаются как interrupted. Если output предоставляет
playback-aligned transcript, в историю записывается услышанная часть. Для
output без такого подтверждения используется forwarded generated text, чтобы
не потерять сам interrupted turn. Realtime provider с message truncation
получает границу `audioEndMs` и синхронизированный transcript.

Это создаёт различие между generated text и playout state. Точность delivered
speech projection зависит от того, предоставляет ли конкретный audio output
playback position и synchronized transcript.

#### SpeechHandle объединяет generation и playout lifecycle

`SpeechHandle` представляет один речевой ответ вместе с tool follow-ups. Он
имеет стабильный ID, parent/step relation, interrupt state, список chat items,
priority и отдельные milestones scheduling, generation done и complete
playout. Очередь поддерживает low, normal и high priority speech.

Ожидание собственного handle из выполняемого им tool распознаётся как circular
wait. Interrupt имеет ограниченный teardown budget: зависший tool, который не
соблюдает abort, превращается в warning, а уже полученные tool outputs всё равно
коммитятся в историю.

#### Voice observability измеряется по границам пользователя

Метрики привязываются не только к provider request. Runtime сохраняет начало и
конец речи пользователя, transcription delay, end-of-turn delay, callback
delay, LLM TTFT, TTS TTFB, начало playout и end-to-end latency. TTS-aligned word
timestamps могут управлять transcript output так, чтобы текстовая проекция
следовала реально воспроизводимому аудио.

### Pipecat: frame pipeline как модель управления голосом

Pipecat представляет данные и управление единым потоком `Frame` через цепочку
`FrameProcessor`. Frames могут идти downstream к output или upstream как
уведомления и управляющие сигналы.

#### Тип frame определяет ordering и cancellation

Базовая taxonomy содержит четыре разных семантики:

- `SystemFrame` обрабатывается немедленно с повышенным приоритетом;
- `DataFrame` содержит audio, text, images и model data;
- `ControlFrame` упорядочен вместе с данными и завершает или изменяет поток;
- `UninterruptibleFrame` сохраняется при interruption независимо от основной
  категории.

У каждого processor есть priority input queue для `StartFrame`, system frames
и остальных frames, а data/control выполняются отдельной task. Поэтому
interruption может обойти накопившееся audio или text без нарушения порядка
обычных данных.

#### Interruption распространяется как control flow

`InterruptionFrame` передаётся в обе стороны pipeline. Каждый processor отменяет
текущую interruptible task и очищает interruptible очередь. Текущий или
ожидающий `UninterruptibleFrame` сохраняется. `EndFrame`, tool-in-progress и
tool-result frames помечены uninterruptible, чтобы завершение pipeline и
соответствие tool call/result не терялись из-за новой речи пользователя.

Long-running function call отдельно объявляет `cancel_on_interruption`. При
значении `false` разговор может продолжиться, а результат позже добавляется в
контекст. Intermediate tool results разрешены для обычного LLM pipeline, но
отделены от final result.

#### User turn собирается цепочкой strategies

Pipecat разделяет стратегии начала и окончания хода. Начало может определяться
VAD, transcript, внешним сигналом или wake phrase. Окончание — timeout,
turn analyzer, внешним событием или LLM verdict. Strategy возвращает решение
продолжить chain или остановить дальнейшие проверки.

Wake phrase strategy имеет состояния `IDLE` и `AWAKE`, bounded accumulator и
timeout. Пока ключевая фраза не найдена, она блокирует последующие strategies и
сбрасывает pre-wake transcript aggregation, поэтому фоновая речь не попадает в
LLM context. Single-activation mode требует ключевую фразу для каждого хода;
timeout mode открывает ограниченное follow-up окно.

#### Acoustic stop и semantic completion разделены

Turn analyzer может только запустить inference, не завершая пользовательский
ход. `DeferredUserTurnStopStrategy` подавляет terminal stop, а отдельный
`UserTurnInferenceCompletedFrame` подтверждает semantic completion. Встроенный
вариант просит LLM маркировать реплику как complete, incomplete-short или
incomplete-long и оставляет ход открытым для продолжения фразы.

#### Voice behavior проверяется end-to-end сценариями

В Pipecat рядом с unit tests существует eval harness. YAML-сценарий задаёт
пользовательские ходы и ожидания: latency, текст, function call или LLM judge.
Eval transport может синтезировать входное audio, получать output audio и снова
транскрибировать его. Одни и те же сценарии покрывают interruption, async tool
cancellation, incomplete turns, language switching и multi-turn behavior.

### Letta Code: память и жизнь агента между сессиями

Репозиторий `letta-ai/letta` является landing page и указывает на
`letta-ai/letta-code` как на текущую реализацию. Архивная ветка старого server
не описывает современный runtime. Поэтому ниже reference `letta` фиксирует этот
переход, а ссылки на код ведут в `references/letta-code`.

#### Memory filesystem задаёт уровни доступности

Контекст агента представлен git-backed filesystem:

- `system/` всегда компилируется в prompt;
- `skills/` рекламируется по metadata и загружается по необходимости;
- остальные файлы служат внешней памятью с name/description discovery.

Перемещение файла меняет его context tier без изменения semantic content.
Runtime показывает модели bounded tree, а не содержимое всего memory repo.
Memory directory разрешается из явного agent scope раньше process-wide env,
что сохраняет изоляцию одновременных агентов.

#### Изменение памяти является версионируемой операцией

Memory write проверяет чистоту working tree, stage-ит только заданные paths и
создаёт commit с agent identity. Commit SHA служит revision receipt. После хода
runtime проверяет dirty state, конфликты и divergence; clean pending commits
могут быть отправлены на remote, а non-fast-forward обрабатывается отдельным
rebase/push flow.

Фоновая reflection работает в отдельном git worktree и branch от известного
base HEAD. Ей выдаётся ограниченный filesystem scope. Завершение различает
`merged`, `no_changes`, `parent_dirty`, `merge_conflict`,
`dirty_uncommitted` и `failed`; только успешная интеграция меняет память
основного агента.

#### Reflection является отдельной ролью с узкими capabilities

Reflection subagent получает transcript после разговора и может использовать
только инструменты чтения, редактирования и git внутри memory repo. Его policy
разделяет:

- устойчивые факты и предпочтения;
- исправления прошлых ошибок;
- reusable procedures для skills;
- одноразовые детали, которые остаются только в transcript;
- отсутствие изменений как нормальный результат.

Изменения должны быть интегрированы в существующий файл, если тема уже
представлена, и завершаться commit с provenance. Skills создаются только для
повторяемой многошаговой процедуры, а не для каждого нового факта.

#### Durable transcript остаётся доступен после compaction

Local backend хранит сообщения в JSONL и проецирует provider-neutral local
messages в user, assistant, reasoning, tool request, tool result и summary
records. Search читает исходные transcript rows, включая сообщения до
compaction, и поддерживает text terms, quoted phrases, agent/conversation и
date filters. Compacted provider context поэтому не становится границей recall.

#### Channel ingress и agent reply являются разными действиями

Channel plugin создаёт transport adapter и при необходимости добавляет actions
в единый `MessageChannel` tool. Inbound message сначала проходит sender access
control, pairing и routing. Успешная доставка сообщения агенту не означает
автоматическую отправку ответа: outbound side effect выполняется отдельным tool
call с route identity.

Очередь различает coalescable messages и barrier items вроде approval result.
Она объединяет совместимые сообщения одного scope, имеет soft limit с
вытеснением старого coalescable item и hard ceiling для всех событий. Adjacent
duplicate outbound action подавляется как in-flight или already-completed и
возвращает модели явную ошибку вместо ложного success.

#### Local и remote execution сохраняют общий protocol

Provider adapter преобразует model stream, reasoning, tool calls, usage и stop
reason в общий Letta streaming protocol. Local backend использует тот же
conversation и channel surface, что remote App Server. Context pressure
оценивается до provider call с отдельным prompt floor для system prompt и tool
schemas; compaction не может исправить запрос, если уже этот несжимаемый floor
превышает context window.

## Индекс reference-проектов

### Pi: агентное ядро

| Место | Зачем смотреть |
|---|---|
| [`packages/agent/README.md`](references/pi/packages/agent/README.md) | Краткое описание lifecycle, событий, parallel/sequential tools, steering и follow-up. |
| [`packages/agent/src/agent-loop.ts`](references/pi/packages/agent/src/agent-loop.ts#L155) | Главный цикл: LLM → tool batch → tool results → следующий turn. |
| [`packages/agent/src/types.ts`](references/pi/packages/agent/src/types.ts#L386) | Контракты `AgentTool`, `AgentToolResult`, `AgentEvent`, context transforms и hooks. |
| [`packages/agent/src/agent.ts`](references/pi/packages/agent/src/agent.ts) | Stateful-обёртка над циклом, подписчики событий, abort и очереди сообщений. |
| [`packages/agent/src/harness/session/`](references/pi/packages/agent/src/harness/session/) | Отделённый session harness и JSONL persistence. |
| [`packages/agent/src/harness/skills.ts`](references/pi/packages/agent/src/harness/skills.ts) | Загрузка `SKILL.md`, валидация metadata и source provenance. |
| [`packages/agent/src/harness/system-prompt.ts`](references/pi/packages/agent/src/harness/system-prompt.ts) | Компактный индекс skills в system prompt. |
| [`packages/agent/src/harness/compaction/`](references/pi/packages/agent/src/harness/compaction/) | Подготовка и сохранение контекста при приближении к context window. |

### Pi: модели и tools

| Место | Зачем смотреть |
|---|---|
| [`packages/ai/README.md`](references/pi/packages/ai/README.md#custom-providers) | Custom OpenAI-compatible providers для LM Studio, llama.cpp и Ollama. |
| [`packages/ai/src/types.ts`](references/pi/packages/ai/src/types.ts#L815) | Модель, provider, compatibility flags, context window и reasoning metadata. |
| [`packages/ai/src/api/openai-completions.ts`](references/pi/packages/ai/src/api/openai-completions.ts) | Нормализация OpenAI Chat Completions и tool-call streaming. |
| [`packages/coding-agent/src/core/tools/index.ts`](references/pi/packages/coding-agent/src/core/tools/index.ts) | Простой composition массивов tools без обязательного registry-класса. |
| [`packages/coding-agent/src/core/extensions/types.ts`](references/pi/packages/coding-agent/src/core/extensions/types.ts#L451) | Более богатый `ToolDefinition`: schema, updates, rendering и execution mode. |

### Pi: resources и extensibility

| Место | Зачем смотреть |
|---|---|
| [`packages/coding-agent/src/core/resource-loader.ts`](references/pi/packages/coding-agent/src/core/resource-loader.ts) | Общая сборка extensions, skills, prompts и context files; precedence и reload. |
| [`packages/coding-agent/src/core/skills.ts`](references/pi/packages/coding-agent/src/core/skills.ts#L168) | Обнаружение skills, ignore-файлы, collision diagnostics. |
| [`packages/coding-agent/src/core/extensions/loader.ts`](references/pi/packages/coding-agent/src/core/extensions/loader.ts) | Динамические TypeScript extensions и lifecycle runtime. |
| [`packages/coding-agent/README.md`](references/pi/packages/coding-agent/README.md#extensions) | Философия минимального core и возможностей на краях. |

### Hermes: core, tools и автономность

| Место | Зачем смотреть |
|---|---|
| [`agent/conversation_loop.py`](references/hermes-agent/agent/conversation_loop.py#L1822) | Production tool loop: retries, interruption, empty responses, invalid calls, compression и finalization. |
| [`agent/iteration_budget.py`](references/hermes-agent/agent/iteration_budget.py) | Отдельный потокобезопасный бюджет итераций. |
| [`agent/deadline.py`](references/hermes-agent/agent/deadline.py) | Единые deadlines для sync/async операций и корректная классификация timeout. |
| [`agent/empty_response_guard.py`](references/hermes-agent/agent/empty_response_guard.py) | Защита от пустых и reasoning-only ответов без бесконечных платных retries. |
| [`agent/repetition_guard.py`](references/hermes-agent/agent/repetition_guard.py) | Обнаружение зацикливания поведения агента. |
| [`agent/turn_finalizer.py`](references/hermes-agent/agent/turn_finalizer.py) | Корректное завершение turn при лимите, interrupt и частичном результате. |
| [`tools/registry.py`](references/hermes-agent/tools/registry.py#L452) | Registry schema + handler + toolset + availability checks + dispatch boundary. |
| [`tools/tool_search.py`](references/hermes-agent/tools/tool_search.py#L785) | Progressive disclosure больших наборов tools через search/describe/call bridge. |

### Hermes: skills, память и голос

| Место | Зачем смотреть |
|---|---|
| [`agent/prompt_builder.py`](references/hermes-agent/agent/prompt_builder.py#L1828) | Компактный skills manifest, precedence, caching и фильтрация по окружению. |
| [`tools/skills_tool.py`](references/hermes-agent/tools/skills_tool.py#L804) | `skills_list` и `skill_view`, безопасное чтение linked resources. |
| [`tools/skill_manager_tool.py`](references/hermes-agent/tools/skill_manager_tool.py) | Изменение skills, write-enabled lifecycle и approval policy. |
| [`tools/memory_tool.py`](references/hermes-agent/tools/memory_tool.py#L159) | Ограниченная curated memory, атомарная запись, защита от потери данных и injection. |
| [`gateway/streaming_tts_consumer.py`](references/hermes-agent/gateway/streaming_tts_consumer.py#L55) | Мост от синхронных LLM deltas к асинхронному PCM sink, очередь и cancellation semantics. |
| [`tools/tts_streaming.py`](references/hermes-agent/tools/tts_streaming.py#L89) | `SentenceChunker`, удаление think-блоков и registry потоковых TTS providers. |
| [`tools/interrupt.py`](references/hermes-agent/tools/interrupt.py) | Общая модель прерывания долгих действий. |
| [`gateway/session.py`](references/hermes-agent/gateway/session.py) | Долгоживущая сессия между сообщениями платформы и агентным core. |

### Maka: runtime facts и projections

| Место | Зачем смотреть |
|---|---|
| [`ARCHITECTURE.md`](references/maka/ARCHITECTURE.md) | Общая карта Runtime Host → SessionManager → AgentRun → Runtime Event Log → projections. |
| [`docs/architecture/runtime-core-architecture-draft.md`](references/maka/docs/architecture/runtime-core-architecture-draft.md#the-conclusion-first-state-is-a-function-of-the-log) | Log-first runtime, identities, execution path и terminal invariants. |
| [`packages/core/src/runtime-event.ts`](references/maka/packages/core/src/runtime-event.ts#L404) | Канонический `RuntimeEvent`: content, actions, refs, partial и terminal status. |
| [`packages/runtime/src/session-event-runtime-mapper.ts`](references/maka/packages/runtime/src/session-event-runtime-mapper.ts) | Чистое преобразование live session events в durable runtime vocabulary. |
| [`packages/runtime/src/runtime-kernel.ts`](references/maka/packages/runtime/src/runtime-kernel.ts) | Active Run ownership, event commit, stop routing и terminal coalescing. |
| [`packages/runtime/src/agent-run.ts`](references/maka/packages/runtime/src/agent-run.ts) | Durable execution envelope, history loading, projections и finalization. |
| [`packages/runtime/src/runtime-event-read-model.ts`](references/maka/packages/runtime/src/runtime-event-read-model.ts) | Построение bounded read model из канонических событий. |

### Maka: tools, interactions и recovery

| Место | Зачем смотреть |
|---|---|
| [`packages/runtime/src/tool-runtime.ts`](references/maka/packages/runtime/src/tool-runtime.ts#L131) | `MakaTool`, execution context, validation, permissions, loop guard, T1/T2 и result materialization. |
| [`docs/architecture/runtime-resume-architecture.md`](references/maka/docs/architecture/runtime-resume-architecture.md#normal-tool-execution-t1-and-t2-surround-the-side-effect) | Repair/resume/reconcile, crash positions, safe continuation и workspace boundary. |
| [`packages/runtime/src/recovery-resolver.ts`](references/maka/packages/runtime/src/recovery-resolver.ts) | Интерпретация call/dispatch/outcome facts в completed, indeterminate, parked или corruption. |
| [`packages/core/src/tool-ledger-scanner.ts`](references/maka/packages/core/src/tool-ledger-scanner.ts) | Единый scanner tool-operation ledger для online path и recovery. |
| [`packages/runtime/src/ask-user-question-tool.ts`](references/maka/packages/runtime/src/ask-user-question-tool.ts#L35) | Bounded вопросы пользователю как tool. |
| [`packages/runtime/src/interaction-authority.ts`](references/maka/packages/runtime/src/interaction-authority.ts) | Pending question/permission ownership, publication barrier, settlement и closure. |
| [`packages/runtime/src/tool-availability.ts`](references/maka/packages/runtime/src/tool-availability.ts#L141) | `load_tools`, capability groups, same-turn activation и execute-boundary gating. |

### Maka: context, skills и memory

| Место | Зачем смотреть |
|---|---|
| [`docs/architecture/llm-compaction-events-log-projection-draft.md`](references/maka/docs/architecture/llm-compaction-events-log-projection-draft.md#the-conclusion-first-compaction-is-projection-not-mutation) | Compaction как проверяемая проекция: coverage, digest, lineage и raw tail. |
| [`packages/runtime/src/history-compact-checkpoint.ts`](references/maka/packages/runtime/src/history-compact-checkpoint.ts) | Checkpoint schemas, prefix matching и replay materialization. |
| [`packages/runtime/src/tool-result-archive.ts`](references/maka/packages/runtime/src/tool-result-archive.ts) | Архивация больших tool results без потери канонического результата. |
| [`docs/skill-catalog-policy.md`](references/maka/docs/skill-catalog-policy.md) | Scope-aware refs, precedence, prompt budget, lazy loading и invocation receipts. |
| [`packages/runtime/src/skills-agent-tools.ts`](references/maka/packages/runtime/src/skills-agent-tools.ts) | `Skill`, `SkillSearch`, bounded metadata search и privacy-preserving trace. |
| [`packages/runtime/src/skills-context.ts`](references/maka/packages/runtime/src/skills-context.ts) | Capability gating, deterministic selection и prompt rendering. |
| [`packages/runtime/src/memory-extraction-evidence.ts`](references/maka/packages/runtime/src/memory-extraction-evidence.ts) | Bounded evidence projection и same-session localization search. |
| [`packages/runtime/src/memory-extraction-proposal.ts`](references/maka/packages/runtime/src/memory-extraction-proposal.ts#L245) | User-authored evidence, citations, deterministic admission и policy rejection. |
| [`packages/core/src/long-term-memory.ts`](references/maka/packages/core/src/long-term-memory.ts) | Типы memory item, source, temporal scope, lifecycle, cursor и atomic mutation. |

### Maka: providers и graph orchestration

| Место | Зачем смотреть |
|---|---|
| [`packages/runtime/src/model-adapter.ts`](references/maka/packages/runtime/src/model-adapter.ts) | Изоляция Vercel AI SDK/provider wire от Maka-owned stream protocol. |
| [`packages/runtime/src/model-factory.ts`](references/maka/packages/runtime/src/model-factory.ts) | Сборка OpenAI, Anthropic, Google и OpenAI-compatible providers. |
| [`docs/web-search-provider-capability.md`](references/maka/docs/web-search-provider-capability.md) | Точный capability routing provider-hosted search без неявного fallback. |
| [`packages/runtime/src/native-web-search-tool.ts`](references/maka/packages/runtime/src/native-web-search-tool.ts) | Одна semantic tool identity для provider-native и client-executed вариантов. |
| [`docs/architecture/agent-graph-stream-scheduling-draft.md`](references/maka/docs/architecture/agent-graph-stream-scheduling-draft.md#chapter-7-graph-is-a-schedule-not-a-second-runtimestreaming-agent-work-under-a-main-agent-supervisor) | Graph как schedule поверх child Sessions и committed RuntimeEvents. |
| [`packages/runtime/src/stream-graph-coordinator.ts`](references/maka/packages/runtime/src/stream-graph-coordinator.ts) | Reconciliation, claims, activation dispatch и quiescence. |
| [`packages/runtime/src/agent-graph-supervisor-wake.ts`](references/maka/packages/runtime/src/agent-graph-supervisor-wake.ts) | Durable supervisor wakes и повторная доставка через обычный root Turn. |

### LiveKit Agents JS: session и voice lifecycle

| Место | Зачем смотреть |
|---|---|
| [`agents/src/voice/agent_session.ts`](references/livekit-agents-js/agents/src/voice/agent_session.ts#L501) | Public session boundary, lifecycle, history, states, join/close и маршрутизация interruption. |
| [`agents/src/voice/agent_activity.ts`](references/livekit-agents-js/agents/src/voice/agent_activity.ts#L316) | State machine одного voice turn: STT, endpointing, LLM, tools, TTS и playout. |
| [`agents/src/voice/agent_activity.ts`](references/livekit-agents-js/agents/src/voice/agent_activity.ts#L2064) | Speculative preemptive generation и её ограничения. |
| [`agents/src/voice/agent_activity.ts`](references/livekit-agents-js/agents/src/voice/agent_activity.ts#L4162) | Классификация skipped/partial/full, provider truncation и playout-aware transcript commit. |
| [`agents/src/voice/agent_activity.ts`](references/livekit-agents-js/agents/src/voice/agent_activity.ts#L4565) | Commit завершившихся tool outputs после interruption. |
| [`agents/src/voice/speech_handle.ts`](references/livekit-agents-js/agents/src/voice/speech_handle.ts#L121) | Speech lifecycle, priorities, parent steps, abort и защита от circular wait. |
| [`agents/src/voice/turn_config/turn_handling.ts`](references/livekit-agents-js/agents/src/voice/turn_config/turn_handling.ts#L30) | Единая конфигурация turn detection, endpointing, interruption и preemptive generation. |
| [`agents/src/voice/turn_config/endpointing.ts`](references/livekit-agents-js/agents/src/voice/turn_config/endpointing.ts#L103) | Dynamic endpointing и адаптация задержки между ходами. |
| [`agents/src/voice/transcription/synchronizer.ts`](references/livekit-agents-js/agents/src/voice/transcription/synchronizer.ts#L604) | Синхронизация word-level transcript с реальным audio playout. |
| [`agents/src/voice/agent_activity_interrupted_commit.test.ts`](references/livekit-agents-js/agents/src/voice/agent_activity_interrupted_commit.test.ts) | Regression cases для частично сыгранного и полностью пропущенного ответа. |
| [`agents/src/voice/agent_activity_tool_output_commit.test.ts`](references/livekit-agents-js/agents/src/voice/agent_activity_tool_output_commit.test.ts) | Ordering tool outputs и invalidation stale preemptive generation. |
| [`agents/src/metrics/model_usage.ts`](references/livekit-agents-js/agents/src/metrics/model_usage.ts#L118) | Агрегация model usage вместе с voice latency metrics. |

### Pipecat: frames, turns и evals

| Место | Зачем смотреть |
|---|---|
| [`src/pipecat/frames/frames.py`](references/pipecat/src/pipecat/frames/frames.py#L105) | System/Data/Control/Uninterruptible taxonomy и semantic contract frames. |
| [`src/pipecat/frames/frames.py`](references/pipecat/src/pipecat/frames/frames.py#L770) | Uninterruptible function result, который обязан попасть в context. |
| [`src/pipecat/frames/frames.py`](references/pipecat/src/pipecat/frames/frames.py#L1208) | Semantic user-turn completion отдельно от acoustic stop. |
| [`src/pipecat/frames/frames.py`](references/pipecat/src/pipecat/frames/frames.py#L1899) | Terminal `EndFrame`, сохраняемый при interruption. |
| [`src/pipecat/processors/frame_processor.py`](references/pipecat/src/pipecat/processors/frame_processor.py#L132) | Priority input queue и раздельное выполнение system и ordinary frames. |
| [`src/pipecat/processors/frame_processor.py`](references/pipecat/src/pipecat/processors/frame_processor.py#L1130) | Отмена текущей task и очистка очереди с сохранением uninterruptible work. |
| [`src/pipecat/turns/user_turn_strategies.py`](references/pipecat/src/pipecat/turns/user_turn_strategies.py#L55) | Композиция независимых start/stop strategies. |
| [`src/pipecat/turns/user_start/wake_phrase_user_turn_start_strategy.py`](references/pipecat/src/pipecat/turns/user_start/wake_phrase_user_turn_start_strategy.py#L34) | IDLE/AWAKE, bounded transcript, single activation и follow-up timeout. |
| [`src/pipecat/turns/user_stop/deferred_user_turn_stop_strategy.py`](references/pipecat/src/pipecat/turns/user_stop/deferred_user_turn_stop_strategy.py#L15) | Разделение inference trigger и окончательной финализации хода. |
| [`src/pipecat/turns/user_stop/llm_turn_completion_user_turn_stop_strategy.py`](references/pipecat/src/pipecat/turns/user_stop/llm_turn_completion_user_turn_stop_strategy.py#L18) | LLM verdict для incomplete user utterance. |
| [`src/pipecat/evals/scenario.py`](references/pipecat/src/pipecat/evals/scenario.py#L258) | Декларативные ожидания и YAML-модель voice-сценария. |
| [`src/pipecat/evals/harness.py`](references/pipecat/src/pipecat/evals/harness.py#L257) | End-to-end исполнение сценариев и проверка поведения. |
| [`src/pipecat/evals/transport.py`](references/pipecat/src/pipecat/evals/transport.py#L123) | Ввод и вывод PCM для audio-mode eval. |
| [`scripts/release-evals/scenarios/interruption_audio.yaml`](references/pipecat/scripts/release-evals/scenarios/interruption_audio.yaml) | Конкретный regression scenario для barge-in по audio path. |

### Letta Code: memory, reflection и channels

| Место | Зачем смотреть |
|---|---|
| [`AGENTS.md`](references/letta/AGENTS.md) | Указатель со старого `letta` repository на актуальную реализацию и граница исторического V1. |
| [`README.md`](references/letta-code/README.md) | Карта current harness: MemFS, subagents, channels, schedules и remote environments. |
| [`src/agent/memory-filesystem.ts`](references/letta-code/src/agent/memory-filesystem.ts#L97) | Agent-scoped memory root, bounded tree и разделение system/skills/external tiers. |
| [`src/agent/memory-git.ts`](references/letta-code/src/agent/memory-git.ts#L1265) | Clean-tree precondition перед memory mutation. |
| [`src/agent/memory-git.ts`](references/letta-code/src/agent/memory-git.ts#L1342) | Path-scoped memory commit и SHA receipt. |
| [`src/agent/memory-git.ts`](references/letta-code/src/agent/memory-git.ts#L1951) | Post-turn status, divergence, push, rebase и conflict outcomes. |
| [`src/agent/memory-worktree.ts`](references/letta-code/src/agent/memory-worktree.ts#L119) | Изолированный worktree и filesystem scope для background reflection. |
| [`src/agent/memory-worktree.ts`](references/letta-code/src/agent/memory-worktree.ts#L643) | Интеграция reflection branch и явные terminal statuses. |
| [`src/agent/subagents/builtin/reflection.md`](references/letta-code/src/agent/subagents/builtin/reflection.md) | Policy извлечения памяти, skill threshold, provenance и no-change outcome. |
| [`src/backend/local/local-message-projection.ts`](references/letta-code/src/backend/local/local-message-projection.ts#L183) | Provider-neutral projection user/assistant/reasoning/tool/summary records. |
| [`src/backend/local/transcript-search.ts`](references/letta-code/src/backend/local/transcript-search.ts#L409) | Поиск исходных JSONL transcripts после compaction с filters и ranking. |
| [`src/backend/dev/provider-turn-executor.ts`](references/letta-code/src/backend/dev/provider-turn-executor.ts#L190) | Context estimate, несжимаемый prompt floor и provider stream adapter. |
| [`src/queue/queue-runtime.ts`](references/letta-code/src/queue/queue-runtime.ts#L172) | Coalescable messages, barriers, blocked reasons и buffer ceilings. |
| [`src/channels/plugin-types.ts`](references/letta-code/src/channels/plugin-types.ts#L305) | Channel adapter и расширение единого outbound tool actions. |
| [`src/channels/access-control.ts`](references/letta-code/src/channels/access-control.ts#L176) | Sender policy до command handling и routing. |
| [`src/channels/message-channel-idempotency.ts`](references/letta-code/src/channels/message-channel-idempotency.ts#L31) | Подавление adjacent duplicate side effects с явным error result. |
