import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DataHubClient } from "../../steward/src/datahubClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "..", "fixtures");

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIX, name), "utf8")) as T;
}

type Handler = (args: Record<string, unknown>) => unknown;

/**
 * An offline DataHubClient for unit tests. Register a handler per tool name; each
 * call records its args so tests can assert on what was requested. Unregistered
 * tools throw so a test can't silently pass against a call it didn't stub.
 */
export class MockDataHubClient implements DataHubClient {
  private handlers = new Map<string, Handler>();
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  on(name: string, handler: Handler): this {
    this.handlers.set(name, handler);
    return this;
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ name, args });
    const h = this.handlers.get(name);
    if (!h) throw new Error(`MockDataHubClient: no handler for tool '${name}'`);
    return h(args) as T;
  }

  async listToolNames(): Promise<string[]> {
    return [...this.handlers.keys()];
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
