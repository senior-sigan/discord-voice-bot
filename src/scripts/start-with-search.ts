import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const healthUrl = "http://127.0.0.1:4479/health";

async function searchReady(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
    const body: unknown = await response.json();
    return (
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      "service" in body &&
      body.service === "DDGS API" &&
      "status" in body &&
      body.status === "healthy"
    );
  } catch {
    return false;
  }
}

function launch(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: "inherit" });
  const done = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      console.error(`Failed to start ${command}: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  return { child, done };
}

type Service = ReturnType<typeof launch>;
let search: Service | undefined;
let bot: Service | undefined;
let stopping = false;

async function stop(service: Service | undefined): Promise<void> {
  if (!service || service.child.exitCode !== null || service.child.signalCode !== null) return;
  service.child.kill("SIGTERM");
  const timer = setTimeout(() => service.child.kill("SIGKILL"), 3_000);
  try {
    await service.done;
  } finally {
    clearTimeout(timer);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    void stop(bot);
    void stop(search);
  });
}

try {
  if (!(await searchReady()) && !stopping) {
    search = launch("ddgs", ["api", "--host", "127.0.0.1", "--port", "4479"]);
    let exited = false;
    void search.done.then(() => {
      exited = true;
    });
    const deadline = Date.now() + 15_000;
    while (!stopping && !exited && Date.now() < deadline && !(await searchReady())) await delay(250);
    if (!stopping && (exited || !(await searchReady())))
      throw new Error("DDGS failed to become ready within 15 seconds");
  }
  if (!stopping) {
    console.log(`DDGS ready at ${healthUrl}`);
    const [command, ...args] = process.argv.slice(2);
    if (!command) throw new Error("Expected a bot command");
    bot = launch(command, args);
    process.exitCode = search
      ? await Promise.race([
          bot.done,
          search.done.then(() => {
            throw new Error("DDGS stopped while the bot was running");
          }),
        ])
      : await bot.done;
  }
} catch (error) {
  if (!stopping) console.error(error);
  process.exitCode = 1;
} finally {
  await stop(bot);
  await stop(search);
}
