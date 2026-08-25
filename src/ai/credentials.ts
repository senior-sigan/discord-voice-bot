import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export class JsonCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.load()[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const credentials = this.load();
      const next = await fn(credentials[providerId]);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        credentials[providerId] = next;
        this.save(credentials);
      }
      return next ?? credentials[providerId];
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const credentials = this.load();
      if (credentials[providerId] === undefined) return;
      delete credentials[providerId];
      this.save(credentials);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.catch(() => undefined).then(task);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private load(): Record<string, Credential> {
    if (!existsSync(this.path)) return {};
    const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid credential file: ${this.path}`);
    }
    return value as Record<string, Credential>;
  }

  private save(credentials: Record<string, Credential>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
