# Олег — голосовой Discord-агент

Олег — self-hosted голосовой бот для Discord. Он слушает разговор в голосовом канале, различает участников, отвечает на обращение по имени, умеет сам уместно включаться в диалог и со временем формирует память о людях и общих сюжетах.

> Проект ориентирован на русский язык и пока рассчитан на самостоятельный запуск одним Discord-сервером.

## Возможности

- локальное STT на Sherpa/Parakeet с отдельным потоком для каждого участника;
- настраиваемые слова активации (`agent.wake_words`) и остановка фразами вроде «Олег, стой»;
- автоматическое участие в режимах `off`, `shadow` и `on` с записью решения и причины в историю;
- LLM через подписку OpenAI Codex или любой OpenAI-compatible сервер, например LM Studio;
- TTS через локальный Piper или OpenAI-compatible Qwen TTS с переключаемыми голосами;
- веб-поиск, история разговора, память, профили участников, Discord soundboard и отправка сообщений;
- одноразовые и повторяющиеся напоминания, сохраняемые между перезапусками;
- ручной режим «сна»: дневные активности, темы, значимые моменты и evidence-based профили;
- каталог мемов и расширяемые Markdown-скиллы.

## Как это работает

```text
Discord voice → VAD/STT → history.jsonl → LLM + tools → TTS → Discord voice
                                  ↓
                           npm run sleep
                                  ↓
                    memory.jsonl + profiles.json
```

История остаётся полным журналом, а память — небольшой производной с дословными доказательствами из пользовательских реплик. Фоновая обработка не запускается автоматически: владелец сам вызывает `npm run sleep`.

## Требования

- Node.js 22.19 или новее;
- Discord-приложение с bot token и доступом `bot` + `applications.commands`;
- права Discord на просмотр канала, подключение и речь; дополнительные права нужны для сообщений и soundboard;
- локальные модели STT/VAD из путей, указанных в `.data/config.json`;
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

6. В Discord вызовите `/voice join` и укажите имя голосового канала. Для выхода используйте `/voice leave`.

## Конфигурация

Единственная схема и значения по умолчанию находятся в `src/config.ts` и проверяются Zod. Рабочий `.data/config.json` имеет две секции:

- `defaults` — полная явная конфигурация сервера, моделей, TTS, STT и поведения;
- `overrides` — значения, которые Олег изменил во время разговора.

На лету можно менять AI-модель внутри текущего provider, голос Qwen и режим автоматического участия. Например: «Олег, переключись на gpt-sol модель» или «Олег, смени голос на arthas». Provider и TTS backend меняются в `defaults` после перезапуска.

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
| `npm run generate-fillers` | Создать филлеры для текущего TTS и всех настроенных голосов Qwen/Supertonic |
| `npm run sleep -- 2026-08-27` | Обработать конкретный день |
| `npm run sleep -- all` | Обработать всю доступную историю и профили |
| `npm run export-memes` | Скачать изображения из Discord в локальный каталог |
| `npm run explain-memes` | Описать изображения моделью для последующего поиска |
| `npm run check` | Проверить типы, форматирование и тесты |

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
