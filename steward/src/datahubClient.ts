import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Narrow interface the detectors depend on. Everything in the steward that talks
 * to DataHub goes through this, so tests can supply a plain mock instead of
 * spawning the real MCP server.
 */
export interface DataHubClient {
  /** Call a tool on the DataHub MCP server and return its (already-parsed) result. */
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  /** Names of the tools the connected server currently advertises. */
  listToolNames(): Promise<string[]>;
  /** Tear down the underlying stdio session. */
  close(): Promise<void>;
}

export interface DataHubClientConfig {
  gmsUrl: string;
  gmsToken: string;
  /** When true, launches the server with mutation (write) tools exposed. */
  mutationEnabled: boolean;
  /** Override the launcher command/args (defaults to uvx + mcp-server-datahub). */
  command?: string;
  args?: string[];
}

const DEFAULT_COMMAND = "uvx";
const DEFAULT_ARGS = [
  "--from",
  "mcp-server-datahub",
  "mcp-server-datahub",
  "--transport",
  "stdio",
];

/**
 * Read connection config from process.env (populated from `.env`). Falls back to
 * the local-quickstart defaults documented in docs/mcp-recon.md.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DataHubClientConfig {
  return {
    gmsUrl: env.DATAHUB_GMS_URL ?? "http://localhost:8080",
    gmsToken: env.DATAHUB_GMS_TOKEN ?? "PLACEHOLDER_NO_AUTH",
    mutationEnabled: parseBool(env.TOOLS_IS_MUTATION_ENABLED),
  };
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());
}

/**
 * A single long-lived MCP stdio session against the official DataHub MCP server.
 *
 * Recon gotcha #3: spawning a fresh `uvx ... mcp-server-datahub` per call pays the
 * server cold-start every time and times out. So we `initialize` once and reuse the
 * connection for every `callTool` — callers should create one of these and keep it.
 */
export class StdioDataHubClient implements DataHubClient {
  private client: Client;
  private transport: StdioClientTransport;
  private connected = false;

  constructor(config: DataHubClientConfig) {
    const env: Record<string, string> = {
      // Keep PATH etc. so `uvx` resolves; recon note: ~/.local/bin must be on PATH.
      ...(process.env as Record<string, string>),
      DATAHUB_GMS_URL: config.gmsUrl,
      DATAHUB_GMS_TOKEN: config.gmsToken,
      TOOLS_IS_MUTATION_ENABLED: String(config.mutationEnabled),
    };

    this.transport = new StdioClientTransport({
      command: config.command ?? DEFAULT_COMMAND,
      args: config.args ?? DEFAULT_ARGS,
      env,
      // The DataHub server is chatty on stderr (echoes GraphQL). Silence it so the
      // scan CLI's own output stays clean; flip to "inherit" when debugging.
      stderr: "ignore",
    });

    this.client = new Client(
      { name: "metamender-steward", version: "0.1.0" },
      { capabilities: {} },
    );
  }

  /** Establish the session (initialize handshake). Idempotent. */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listToolNames(): Promise<string[]> {
    await this.connect();
    const res = await this.client.listTools();
    return res.tools.map((t) => t.name);
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect();
    const res = await this.client.callTool({ name, arguments: args });
    if (res.isError) {
      const text = extractText(res);
      throw new Error(`DataHub MCP tool '${name}' returned an error: ${text}`);
    }
    return parseToolResult<T>(res);
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }
}

/**
 * MCP tool results come back as content blocks. The DataHub server returns JSON as
 * a text block; parse it if it looks like JSON, otherwise hand back the raw text.
 */
export function parseToolResult<T>(res: unknown): T {
  const text = extractText(res);
  if (text === undefined) return res as T;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return text as unknown as T;
    }
  }
  return text as unknown as T;
}

function extractText(res: unknown): string | undefined {
  const content = (res as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return parts.length ? parts.join("") : undefined;
}
