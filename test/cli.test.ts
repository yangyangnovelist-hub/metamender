import { describe, it, expect } from "vitest";
import { runCli } from "../steward/src/cli.js";
import type { DataHubEntity, Finding, SchemaField } from "../steward/src/types.js";
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
    .on("get_lineage", () => ({ downstreams: { total: 0 } }));
}

function capture() {
  const lines: string[] = [];
  return { out: (s: string) => lines.push(s), text: () => lines.join("\n") };
}

describe("runCli scan", () => {
  it("--json emits a valid, severity-sorted Finding[]", async () => {
    const cap = capture();
    const code = await runCli(["scan", "--json"], { client: buildClient(), out: cap.out });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.text()) as Finding[];
    expect(parsed).toHaveLength(55);
    expect(parsed[0].kind).toBe("pii-untagged");
    expect(parsed.filter((finding) => finding.kind === "orphan")).toHaveLength(30);
  });

  it("default (human) output shows a summary with per-kind counts", async () => {
    const cap = capture();
    const code = await runCli(["scan"], { client: buildClient(), out: cap.out });
    expect(code).toBe(0);
    const text = cap.text();
    expect(text).toContain("55");
    expect(text.toLowerCase()).toContain("owner");
    expect(text.toLowerCase()).toContain("pii");
    expect(text.toLowerCase()).toContain("30 orphan candidates");
  });

  it("--dry-run notes that no writes happen", async () => {
    const cap = capture();
    await runCli(["scan", "--dry-run"], { client: buildClient(), out: cap.out });
    expect(cap.text().toLowerCase()).toContain("dry-run");
  });

  it("unknown command returns non-zero", async () => {
    const cap = capture();
    const code = await runCli(["frobnicate"], { client: buildClient(), out: cap.out });
    expect(code).not.toBe(0);
  });
});
