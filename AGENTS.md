# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js TypeScript Discord voice agent. Source lives in `src/`; compiled output goes to `dist/`.

- `src/agent/`: conversation runtime, prompts, history, memory, and profiles;
- `src/discord/`: Discord bot and voice sessions;
- `src/stt/`: speech recognition backends;  
- `src/tts/`: speech synthesis backends;
- `src/tools/`: tools exposed to the agent, including reminders and recall;
- `src/scripts/`: sleep processing, meme, and filler utilities;
- `src/main.test.ts`: automated tests;
- `assets/`: audio fillers;
- `skills/`: agent-readable instructions;
- `.data/`: ignored runtime state, including auth, history, memory, tasks, profiles, and memes.

## Build, Test, and Development Commands

- `npm install`: install pinned dependencies.
- `npm run build`: compile TypeScript into `dist/`.
- `npm test`: build and run tests with Node's test runner.
- `npm run check`: type-check, lint, and run all tests. Use before every commit.
- `npm run lint:fix` or `npm run format`: apply Biome fixes.
- `npm start`: build and start the bot using `.env`.
- `npm run start:select`: start with interactive AI-model selection.
- `npm run sleep -- all`: process all conversation history into memories and profiles.

## Speaking in the Discord Voice Channel

When asked to say something through the running agent, send a local HTTP request to its speech endpoint:

```bash
curl --silent --show-error --fail-with-body http://127.0.0.1:7070/speak \
  -H 'content-type: application/json' \
  --data '{"text":"Привет из Codex!"}'
```

- This speaks through TTS in the voice channel the bot is currently connected to; it does not post a text message.
- The request body must contain only `text`, with 1–1000 non-whitespace characters.
- HTTP 200 with `{"ok":true}` means playback completed successfully. HTTP 503 usually means the bot is not connected to a voice channel or TTS/playback failed.
- The endpoint is local-only by default (`defaults.agent.local_control` in `.data/config.json`) and is available only while the service is running.

## References and documentation

- `AGENTS_BEST_PRACTICES.md`: best practices for building voice agents. Always check it have strong architecture. Read real code of other projects in `references`.
- `references/`: gitignored folder with downloaded thirdparty agents like pi, hermes, letta, moka and so on to get inspired.
