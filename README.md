# Олег — голосовой Discord-агент

Олег — self-hosted голосовой бот для Discord. Он слушает разговор в голосовом канале, различает участников, отвечает на обращение по имени, умеет сам уместно включаться в диалог и сохраняет заметки по явной просьбе «Олег, запомни».

> Проект ориентирован на русский язык и пока рассчитан на самостоятельный запуск одним Discord-сервером.

## Возможности

- локальное STT на Sherpa/Parakeet, Sherpa/GigaAM-v3 или Qwen3-ASR MLX с отдельным потоком для каждого участника;
- настраиваемые слова активации (`agent.wake_words`) и остановка фразами вроде «Олег, стой»;
- переход между голосовыми каналами по просьбе вроде «Олег, перейди в Игровую»; список каналов и выбор по ID при одинаковых названиях;
- автоматическое участие в режимах `off`, `shadow` и `on` с записью решения и причины в историю;
- LLM через подписку OpenAI Codex или любой OpenAI-compatible сервер, например LM Studio;
- TTS через локальный Piper или OpenAI-compatible Qwen TTS с переключаемыми голосами;
- веб-поиск, история разговора, память, профили участников, Discord soundboard и отправка сообщений;
- одноразовые и повторяющиеся напоминания, сохраняемые между перезапусками;
- ручной режим «сна»: обновление профилей участников по истории;
- каталог мемов и расширяемые Markdown-скиллы.

## Как это работает

```text
Discord voice → VAD/STT → history.jsonl → LLM + tools → TTS → Discord voice
                                  ↓
                           npm run sleep
                                  ↓
                            profiles.json

«Олег, запомни…» → remember → memory.jsonl → search_memory
```

Silero выделяет речь отдельно для каждого участника по мере поступления PCM: пауза 0,5 секунды завершает сегмент, длинная речь делится примерно каждые 20 секунд. Отсутствие Discord-пакетов завершает оставшийся захват. Отдельное «Олег» проигрывает короткое подтверждение и открывает 30-секундное окно для вопроса того же участника.

Переход через `discord_move_voice` сохраняет текущий запрос: ответ прозвучит в новом канале. Перед переходом проверяются права подключения и речи; при неудаче бот пытается вернуться обратно. Поддерживаются обычные голосовые каналы, без Stage. Участники и soundboard определяются по текущему каналу.

Новое обращение во время работы модели передаётся ей как уточнение; во время озвучивания — прерывает ответ. Cooldown подавляет только точные повторы обращения. Выход из канала отменяет активный запрос и устаревшую очередь STT. В истории ответы отмечаются по предложениям как `played`, `interrupted` или `failed`; в разговорный контекст попадают только подтверждённые предложения. Для старых записей без статуса сохраняется прежнее поведение.

История остаётся полным журналом. Память в `.data/memory.jsonl` содержит только явно запрошенные заметки: `{"fact":"Андрей по средам на репетиции","speaker":"☆Illya☆","timestamp":"2026-09-02T18:22:10.799Z"}`. Цитаты, evidence, важность и другие метаданные не сохраняются. `remember` проверяет просьбу по истории, отсекает точные повторы, а `search_memory` выполняет локальный неточный поиск с фильтрами по автору и дате. В контекст возвращаются только найденные заметки. Старые автоматические записи `origin: "sleep"` исключаются из поиска.

`npm run sleep` обновляет только профили и никогда не дописывает факты, активности, темы или сводки в память. Состояние обработки хранится отдельно в `.data/profiles.json.sleep-state.json`. Фоновая обработка не запускается автоматически.

В `.data/profiles.json` у участника есть `name` (Discord-имя) и `aliases`, например `"aliases": ["Илья", "Илюха", "Сиган"]`. `get_person_profile` ищет по имени, алиасам и Discord ID; при совпадении алиаса у нескольких людей возвращает все подходящие профили. Алиасы можно вписать вручную: `sleep` сохраняет их и дополняет именами, которыми участник явно назвал себя в истории. Старые профили без `aliases` читаются с пустым списком.

## Требования

- Node.js 24 (версия закреплена в `mise.toml`), нативный запуск TypeScript без сборки;
- Discord-приложение с bot token и доступом `bot` + `applications.commands`;
- права Discord на просмотр канала, подключение и речь; дополнительные права нужны для сообщений и soundboard;
- для распознавания речи: локальная модель Silero VAD и модель Parakeet/GigaAM-v3 либо HTTP-сервер Qwen3-ASR MLX; STT можно отключить;
- один LLM backend и один TTS backend;
- FFmpeg — только для подготовки каталога мемов.

## Полностью локальный запуск на 16 ГБ

Этот профиль оставляет STT и Piper на CPU, а LLM отдаёт доступному GPU. Он рассчитан на MacBook M1 с 16 ГБ общей памяти и ПК с одной видеокартой уровня RTX 5060 Ti 16 ГБ.

### Скачать STT, VAD и Piper TTS

Из корня проекта скачайте официальные модели Sherpa ONNX:

```bash
mkdir -p models/vad

curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 -o models/parakeet.tar.bz2
tar -xjf models/parakeet.tar.bz2 -C models

curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx -o models/vad/silero_vad_v5.onnx

curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-ruslan-medium.tar.bz2 -o models/piper.tar.bz2
tar -xjf models/piper.tar.bz2 -C models

rm models/parakeet.tar.bz2 models/piper.tar.bz2
```

Источники: [Parakeet TDT 0.6B v3 int8](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2), [Silero VAD](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx), [Piper ru_RU-ruslan-medium](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-ruslan-medium.tar.bz2). Пути после распаковки уже совпадают со значениями по умолчанию в конфиге.

В качестве ещё одного локального TTS можно выбрать `supertonic`. Модель поддерживает русский язык и 10 голосов (`F1`–`F5` женские, `M1`–`M5` мужские):

```bash
curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2 -o models/supertonic.tar.bz2
tar -xjf models/supertonic.tar.bz2 -C models
rm models/supertonic.tar.bz2
```

После скачивания установите `defaults.tts.backend` в `supertonic`. Скорость, голос и качество настраиваются полями `defaults.tts.supertonic.speed`, `voice` и `num_steps`.

### Запустить LLM в LM Studio

Установите [LM Studio](https://lmstudio.ai/download) и его CLI:

```bash
npx lmstudio install-cli
lms get google/gemma-3n-e4b
lms load google/gemma-3n-e4b --identifier oleg-local --context-length 8192 --gpu max
lms server start --port 1234
```

Рекомендуемая модель — [Gemma 3n E4B](https://lmstudio.ai/models/google/gemma-3n-e4b), оптимизированная Google для ноутбуков и других слабых устройств. В LM Studio выберите MLX 4-bit на Apple Silicon или GGUF Q4 на NVIDIA. Модель имеет 4B эффективных параметров, требует от 4 ГБ памяти и поддерживает контекст до 32K; для голосового агента начните с 8K ради меньшей задержки и расхода памяти.

После первого `npm start` выставьте в `.data/config.json`:

```json
{
  "defaults": {
    "ai": {
      "provider": "openai-compatible",
      "model": "oleg-local",
      "openai_compatible": {
        "base_url": "http://127.0.0.1:1234/v1",
        "context_window": 8192,
        "max_tokens": 512
      }
    },
    "tts": {
      "backend": "piper"
    }
  }
}
```

Это фрагмент: не удаляйте остальные поля созданного конфига. Перед запуском бота проверьте сервер командой `curl http://127.0.0.1:1234/v1/models`. На 16 ГБ не увеличивайте контекст без необходимости: KV-cache конкурирует за память с моделью, Parakeet и самим ботом. Режим сна и сложные цепочки tools на E4B могут быть менее надёжны, чем обычные короткие голосовые ответы.

## Быстрый запуск

1. Установите зависимости:

   ```bash
   npm install
   ```

2. Создайте `.env`. Здесь хранятся только секреты и путь к данным:

   ```dotenv
   DISCORD_TOKEN=your-discord-token
   DATA_DIR=.data

   # Необязательно: удалённые OpenAI-compatible сервисы
   OPENAI_COMPATIBLE_API_KEY=
   MEME_LLM_API_KEY=

   # Необязательно: Qwen TTS
   QWEN_TTS_API_KEY=
   # или QWEN_TTS_USERNAME=... и QWEN_TTS_PASSWORD=...
   ```

3. Выполните первый запуск:

   ```bash
   npm start
   ```

   Он создаст `.data/config.json` и может завершиться с ошибкой, пока не настроены модели и Discord server ID. Укажите `defaults.discord.guild_id`, затем выберите AI/STT/TTS backends и пути к моделям.

4. Для OpenAI Codex выполните OAuth-вход:

   ```bash
   npm run ai:login
   ```

5. Подготовьте голосовые филлеры для выбранного TTS и запустите бота снова:

   ```bash
   npm run generate-fillers
   npm start
   ```

   Для Piper генератор сохраняет филлеры голоса `0` в `assets/fillers/piper/0`. Если в этой папке нет WAV-файлов, бот загружает их из `assets/fillers/piper`. Путь к модели Piper на расположение филлеров не влияет; базовая папка задаётся через `agent.filler_dir`.

6. В Discord вызовите `/voice join` и укажите имя голосового канала. Для выхода используйте `/voice leave`.

### Локальный GigaAM-v3 INT8 через sherpa-onnx

Скачайте модель (около 230 МБ, версия закреплена в задаче):

```bash
mise run stt:gigaam:download
```

В `.data/config.json` у каждой модели своя секция внутри `defaults.stt` (фрагмент ниже; сохраните также VAD и Qwen):

```json
{
  "backend": "gigaam",
  "parakeet": {
    "model_dir": "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    "threads": 2
  },
  "gigaam": {
    "model_dir": "models/sherpa-onnx-nemo-transducer-giga-am-v3-russian-2025-12-16",
    "threads": 2
  }
}
```

В старом конфиге перенесите общие `stt.model_dir` и `stt.threads` в секцию соответствующей модели и удалите их из корня `stt`. Добавьте секцию второй модели, как в примере.

Перезапустите бота. Это русскоязычная RNN-T модель с INT8 encoder; decoder и joiner поставляются в FP32. Она работает на CPU прямо в Node.js, без Python и отдельного сервера. Silero VAD и `vad_threshold` общие для STT; `model_dir` и `threads` задаются отдельно в `stt.parakeet` и `stt.gigaam`. Это обычный GigaAM-v3 RNN-T, не E2E-вариант с пунктуацией. Для переключения меняйте только `stt.backend`: `parakeet`, `gigaam`, `qwen` или `disabled`.

Источник: [GigaAM-v3 для sherpa-onnx](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-giga-am-v3-russian-2025-12-16).

### Локальный Qwen3-ASR через MLX

На Apple Silicon mise может установить HTTP-сервер Qwen3-ASR в отдельное Python-окружение и запускать его как задачу. Python, uv и Qwen объявлены только у задачи `stt:qwen`: обычные `mise install` и `mise run start` их не устанавливают. Один раз создайте постоянный API-ключ в локальном, исключённом из Git конфиге:

```bash
openssl rand -hex 32 | mise set --file mise.local.toml --stdin MLX_ASR_API_KEY
```

Запустите сервер; mise установит его отдельные инструменты при первом запуске задачи:

```bash
mise run stt:qwen
```

При первом запуске сервер скачает модель `Qwen/Qwen3-ASR-0.6B`. В другом терминале можно проверить его готовность:

```bash
mise run stt:qwen:health
```

Сервер слушает только `127.0.0.1:8765`; постоянный ключ доступен также процессу бота, запущенному через `mise run start`. Чтобы выбрать его для распознавания, настройте `.data/config.json`:

```json
{
  "defaults": {
    "stt": {
      "backend": "qwen",
      "qwen": {
        "base_url": "http://127.0.0.1:8765/v1",
        "model": "Qwen/Qwen3-ASR-0.6B",
        "language": null,
        "timeout_ms": 30000
      }
    }
  }
}
```

Это фрагмент: сохраните остальные поля `stt`, включая настройки Silero VAD. `language: null` включает автоопределение языка. Запускайте сервер и бота в разных терминалах:

```bash
mise run stt:qwen
mise run start
```

Бот проверяет `/v1/models` при запуске, отправляет завершённые VAD-сегменты как mono PCM16 WAV в `/v1/audio/transcriptions` и не публикует отменённые результаты.

Если на сервере распознавание речи не нужно, установите `defaults.stt.backend` в `"disabled"`. Бот не загрузит Parakeet, не подключится к Qwen и не будет принимать аудио участников голосового канала. Python и Qwen для такого запуска не нужны.

## Конфигурация

Единственная схема и значения по умолчанию находятся в `src/config.ts` и проверяются Zod. Новый конфиг создаётся со всеми значениями по умолчанию. Существующий файл должен быть полным: пропущенные поля не подставляются, старые форматы автоматически не преобразуются. Рабочий `.data/config.json` имеет две секции:

- `defaults` — полная явная конфигурация сервера, моделей, TTS, STT и поведения;
- `overrides` — значения, которые Олег изменил во время разговора.

Базовые характеры хранятся в словаре `defaults.agent.souls`, а `defaults.agent.soul` содержит имя выбранного варианта:

```json
{
  "defaults": {
    "agent": {
      "soul": "oleg",
      "souls": {
        "oleg": "Текущий характер Олега...",
        "calm": "Спокойный и сдержанный собеседник..."
      }
    }
  }
}
```

Чтобы сменить характер, достаточно поменять `soul` на ключ из `souls` и перезапустить бота. Конфигурация отклоняется при неизвестном ключе. Служебные правила голосового интерфейса и инструментов добавляются отдельно и не требуют копирования в JSON.

На лету можно менять AI-модель внутри текущего provider, голос Qwen/Silero и режим автоматического участия. Например: «Олег, переключись на gpt-sol модель» или «Олег, смени голос на arthas». AI provider, STT backend и TTS backend меняются в `defaults` после перезапуска.

### Silero через OpenAI Speech API

Для локального сервера `realtime-voice-api` добавьте в `defaults.tts` секцию (она обязательна и при другом выбранном backend):

```json
"silero": {
  "base_url": "http://127.0.0.1:8000",
  "sample_rate": 24000,
  "model": "silero-v5.5",
  "voice": "xenia",
  "voices": ["aidar", "baya", "kseniya", "eugene", "xenia"]
}
```

Установите `defaults.tts.backend` в `"silero"`. При запущенном сервере выполните `mise exec -- npm run generate-fillers`, затем перезапустите бота. Филлеры создаются отдельно для каждого голоса; `overrides.tts.silero.voice` позволяет менять голос во время разговора, как у Qwen.

Общий с Qwen клиент отправляет `POST /v1/audio/speech` с `response_format: "pcm"`. Каждый поступивший фрагмент PCM (24 кГц, mono, signed 16-bit LE) сразу преобразуется в 48 кГц stereo для Discord, без ожидания конца HTTP-ответа. Скорость появления первого звука зависит от сервера; клиент не меняет способ генерации самой модели. Авторизация Qwen к Silero не отправляется.

### VoxCPM2 через OpenAI Audio API

Добавьте обязательную секцию `defaults.tts.voxcpm` в `.data/config.json`:

```json
"voxcpm": {
  "url": "http://192.168.88.21:8000/v1/audio/speech",
  "model": "voxcpm2",
  "voice": "Koshkodevochka",
  "response_format": "wav",
  "timeout_ms": 180000
}
```

`voice` выбирает подготовленный голос на сервере. Локальный путь к reference-файлу не нужен. Домашний сервер на порту 8000 обслуживает HTTP. Выберите `defaults.tts.backend: "voxcpm"`, запустите `mise exec -- npm run generate-fillers` при работающем сервере и перезапустите бота.

Клиент отправляет WAV-запрос с `stream: false`, ждёт готовое аудио и преобразует mono PCM16 из частоты WAV-заголовка в 48 кГц stereo для Discord. `timeout_ms` ограничивает весь запрос, включая загрузку модели и синтез; отмена речи прерывает HTTP-запрос. Филлеры разделены по модели и имени голоса. После изменения голоса на сервере перегенерируйте филлеры.

### Локальное управление

По умолчанию Олег принимает на `127.0.0.1:7070` команду озвучивания в текущем голосовом канале:

```bash
curl -sS http://127.0.0.1:7070/speak \
  -H 'content-type: application/json' \
  -d '{"text":"Привет из Codex!"}'
```

Поля `defaults.agent.local_control.enabled`, `host` и `port` применяются после перезапуска. Дефолтный `127.0.0.1` не доступен из локальной сети; не ставьте `0.0.0.0`, если не хотите открыть endpoint другим устройствам. Если Олег не подключён к голосовому каналу, запрос вернёт HTTP 503.

## Основные команды

| Команда | Назначение |
|---|---|
| `npm start` | Собрать и запустить бота |
| `npm run start:select` | Интерактивно выбрать AI provider и модель |
| `npm run generate-fillers` | Создать филлеры для текущего TTS и всех настроенных голосов Qwen/Silero/Supertonic |
| `npm run sleep -- 2026-08-27` | Обновить профили участников, говоривших в этот день, по всей их истории |
| `npm run sleep -- all` | Обновить все профили по доступной истории |
| `npm run export-memes` | Скачать изображения из Discord в локальный каталог |
| `npm run explain-memes` | Описать изображения моделью для последующего поиска; поддерживает `--channel`, `--channel-id` и `--limit` |
| `npm run index-memes` | Построить или обновить локальный семантический индекс описаний мемов (E5 ONNX + Zvec) |
| `npm run check` | Проверить типы, форматирование и тесты |
| `mise run stt:qwen` | Запустить локальный Qwen3-ASR MLX HTTP-сервер |
| `mise run stt:qwen:health` | Проверить готовность Qwen3-ASR сервера |

Например, `npm run explain-memes -- --channel общак --limit 100` опишет до 100 ещё не обработанных изображений из канала `общак`. Если названия каналов повторяются, используйте точный Discord ID: `npm run explain-memes -- --channel-id 123456789 --limit 100`. Старый позиционный лимит `npm run explain-memes -- 100` также поддерживается.

Повреждённые и отсутствующие изображения выводятся как `Skipped broken image` и не останавливают обработку остальных файлов. Такой запуск завершается с ненулевым кодом, а пропущенные изображения остаются в очереди для повторной попытки после восстановления.

После `explain-memes` запустите `mise exec -- npm run index-memes`. Команда читает весь `images_explained.jsonl` и публикует индекс в `.data/search/memes/` (с учётом `DATA_DIR`). Первый запуск скачивает закреплённую ONNX-модель `multilingual-e5-small` в `.data/search/models/`; дальнейшее вычисление embeddings и поиск выполняются локально на CPU. Изменённые описания получают новые векторы, неизменённые переиспользуют старые. `search_memes` использует только готовый индекс: без него возвращается ошибка с командой индексации. Дописанные описания станут доступны после следующего `index-memes`, без перезапуска уже подключённого поискового модуля.

Общий API коллекций, формат документов и устройство индекса описаны в [src/search/README.md](src/search/README.md).

Напоминания исполняются только пока процесс бота запущен. Их состояние и история запусков сохраняются в `.data/tasks.json`.

## Данные и приватность

`.data/` содержит конфигурацию, OAuth auth, полную историю транскриптов с Discord user ID, память, профили, задачи и каталог мемов. Папка исключена из Git.

Получите согласие участников перед подключением бота. Аудио распознаётся локально, но текст разговора и результаты памяти отправляются выбранной LLM; при удалённом Qwen TTS текст ответов также уходит TTS-сервису. Не публикуйте `.env` и `.data/`.

## Разработка

Исходники находятся в `src/`, тесты — в `src/main.test.ts`, а скиллы — в `skills/`. Перед коммитом запускайте:

```bash
npm run check
```

План развития ведётся в [BACKLOG.md](BACKLOG.md), правила для контрибьюторов — в [AGENTS.md](AGENTS.md).

## Локальный веб-поиск (DDGS)

`web_search` обращается к отдельному DDGS HTTP-сервису. Установка закреплённого
`ddgs[api]` через mise и запуск в отдельном терминале:

```bash
UV_OFFLINE=0 mise install pypi:ddgs
mise run search:start
```

Проверка готовности: `mise run search:health`. Сервис слушает только
`127.0.0.1:4479`; Swagger доступен по `http://127.0.0.1:4479/docs`.
`mise run start` автоматически запускает DDGS и ждёт его готовности перед запуском
бота. При остановке бота созданный им DDGS тоже останавливается. Уже работающий
DDGS используется повторно и не останавливается вместе с ботом. Логи обоих
процессов видны в том же терминале. Если DDGS не готов за 15 секунд, бот не запускается.
Для независимого запуска DDGS по-прежнему доступен `mise run search:start`.
Обычный `npm start` запускает только бота.

В `.data/config.json` требуется `defaults.agent.web_search`:

```json
{ "base_url": "http://127.0.0.1:4479" }
```

При обновлении существующей установки добавьте этот объект в `defaults.agent`
перед перезапуском бота. Конфиг строгий, отсутствующие поля автоматически не дополняются.
Бот отправляет `POST /search/text` с `backend: "auto"`, ожидает не более 30 секунд
и возвращает до пяти заголовков, ссылок и фрагментов. API-ключи не нужны, но
поисковые движки могут ограничивать запросы. `web_fetch` продолжает использовать Jina.
