import { describe, it, expect } from "vitest";
import { scan } from "../steward/src/scan.js";
import type { DataHubEntity, SchemaField } from "../steward/src/types.js";
import { MockDataHubClient, loadFixture } from "./helpers/mockClient.js";

const ENTITIES = loadFixture<DataHubEntity[]>("get-entities-all.json");
const ADDR = loadFixture<{ urn: string; result: { fields: SchemaField[] } }>(
  "list-schema-fields-addresses.json",
);

function buildClient(): MockDataHubClient {
  return new MockDataHubClient()
    .on("search", () => ({
      searchResults: ENTITIES.map((e) => ({ entity: { urn: e.urn } })),
    }))
    .on("get_entities", () => ENTITIES)
    .on("list_schema_fields", (args) =>
      args.urn === ADDR.urn ? { fields: ADDR.result.fields } : { fields: [] },
    )
    .on("get_lineage", (args) =>
      args.upstream
        ? { upstreams: { total: 1 } }
        : { downstreams: { total: 1 } },
    );
}

describe("scan", () => {
  it("composes all four detectors: 10 owner + 14 desc + 1 pii + 0 orphan", async () => {
    const findings = await scan(buildClient());
    const byKind = (k: string) => findings.filter((f) => f.kind === k).length;
    expect(byKind("missing-owner")).toBe(10);
    expect(byKind("missing-description")).toBe(14);
    expect(byKind("pii-untagged")).toBe(1);
    expect(byKind("orphan")).toBe(0);
    expect(findings).toHaveLength(25);
  });

  it("sorts by severity, most-urgent first", async () => {
    const findings = await scan(buildClient());
    expect(findings[0].kind).toBe("pii-untagged"); // 80 > 60 > 40
    const sevs = findings.map((f) => f.severity);
    for (let i = 1; i < sevs.length; i++) {
      expect(sevs[i]).toBeLessThanOrEqual(sevs[i - 1]);
    }
  });

  it("only fetches entities once (owner + description share the batch)", async () => {
    const client = buildClient();
    await scan(client);
    expect(client.calls.filter((c) => c.name === "get_entities")).toHaveLength(1);
  });
});
