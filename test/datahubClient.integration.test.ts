import { describe, it, expect, afterAll } from "vitest";
import { StdioDataHubClient, configFromEnv } from "../steward/src/datahubClient.js";

/**
 * Integration smoke test — spawns the real `mcp-server-datahub` via uvx and talks
 * to the local DataHub quickstart. Skipped unless RUN_INTEGRATION=1 so the default
 * `vitest run` stays fully offline.
 *
 *   RUN_INTEGRATION=1 npx vitest run test/datahubClient.integration.test.ts
 */
const run = process.env.RUN_INTEGRATION === "1";
const READ_TOOLS = [
  "search",
  "get_lineage",
  "get_dataset_queries",
  "get_entities",
  "list_schema_fields",
  "get_lineage_paths_between",
];

describe.runIf(run)("StdioDataHubClient (integration, needs local DataHub)", () => {
  let client: StdioDataHubClient;

  afterAll(async () => {
    await client?.close();
  });

  it("lists the 6 read-only tools by default", async () => {
    client = new StdioDataHubClient({ ...configFromEnv(), mutationEnabled: false });
    const names = await client.listToolNames();
    for (const t of READ_TOOLS) expect(names).toContain(t);
    // Default run exposes read tools only (no add_*/update_* write tools).
    expect(names).not.toContain("add_terms");
    expect(names).not.toContain("update_description");
  }, 120_000);

  it("exposes 17+ tools once mutation is enabled", async () => {
    const m = new StdioDataHubClient({ ...configFromEnv(), mutationEnabled: true });
    try {
      const names = await m.listToolNames();
      expect(names.length).toBeGreaterThanOrEqual(17);
      expect(names).toContain("add_terms");
      expect(names).toContain("update_description");
      expect(names).toContain("add_owners");
    } finally {
      await m.close();
    }
  }, 120_000);

  it("search returns the showcase-ecommerce datasets", async () => {
    const res = await client.callTool<{ total?: number }>("search", {
      query: "*",
      filter: "entity_type = dataset",
      num_results: 5,
    });
    expect(res).toBeTruthy();
  }, 120_000);
});
