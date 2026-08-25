import { createInterface } from "node:readline/promises";

import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export class ConsolePrompter {
  private readonly readline = createInterface({ input: process.stdin, output: process.stdout });

  async choose<T extends string>(message: string, options: ReadonlyArray<{ id: T; label: string }>): Promise<T> {
    if (!process.stdin.isTTY) throw new Error("Interactive model selection requires a TTY");
    process.stdout.write(`\n${message}\n`);
    options.forEach((option, index) => {
      process.stdout.write(`  ${index + 1}. ${option.label}\n`);
    });
    while (true) {
      const answer = await this.readline.question(`Выберите 1-${options.length}: `);
      const selected = options[Number.parseInt(answer, 10) - 1];
      if (selected) return selected.id;
    }
  }

  authInteraction(): AuthInteraction {
    return {
      prompt: (prompt) => this.answerAuthPrompt(prompt),
      notify: (event) => this.notify(event),
    };
  }

  close(): void {
    this.readline.close();
  }

  private async answerAuthPrompt(prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") {
      return this.choose(prompt.message, prompt.options);
    }
    const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
    return this.readline.question(`${prompt.message}${suffix}: `, { signal: prompt.signal });
  }

  private notify(event: AuthEvent): void {
    if (event.type === "auth_url") {
      process.stdout.write(`\nОткройте в браузере:\n${event.url}\n`);
      if (event.instructions) process.stdout.write(`${event.instructions}\n`);
      return;
    }
    if (event.type === "device_code") {
      process.stdout.write(`\nОткройте ${event.verificationUri} и введите код ${event.userCode}\n`);
      return;
    }
    process.stdout.write(`${event.message}\n`);
  }
}
