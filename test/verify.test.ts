import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRound } from "../agent/src/cli.js";
import { verifyFix } from "../agent/src/verify.js";
import type { HarnessIO } from "../agent/src/harness.js";
import type { Finding } from "../steward/src/types.js";
import { MockDataHubClient } from "./helpers/mockClient.js";

const ORDERS =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.orders,PROD)";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    urn: ORDERS,
    kind: "missing-owner",
    severity: 60,
    entityName: "orders",
    evidence: "Dataset has no owner.",
    proposedFix: "Assign a technical owner.",
    ...overrides,
  };
}

describe("verifyFix", () => {
  it("verifies an owner by re-reading get_entities", async () => {
    const client = new MockDataHubClient().on("get_entities", () => [
      {
        urn: ORDERS,
        ownership: { owners: [{ owner: "urn:li:corpuser:datahub" }] },
      },
    ]);

    const result = await verifyFix(client, finding());

    expect(result.ok).toBe(true);
    expect(result.after).toContain("urn:li:corpuser:datahub");
    expect(client.calls).toEqual([
      { name: "get_entities", args: { urns: [ORDERS] } },
    ]);
  });

  it("reads a written description from editableProperties", async () => {
    const client = new MockDataHubClient().on("get_entities", () => [
      {
        urn: ORDERS,
        editableProperties: { description: "Drafted by MetaMender — Order facts." },
      },
    ]);

    const result = await verifyFix(
      client,
      finding({ kind: "missing-description", severity: 40 }),
    );

    expect(result).toMatchObject({ ok: true, after: "Drafted by MetaMender — Order facts." });
  });

  it("verifies a PII term on the exact column", async () => {
    const client = new MockDataHubClient().on("list_schema_fields", () => ({
      fields: [
        { fieldPath: "email", editedGlossaryTerms: ["PII"] },
        { fieldPath: "phone", editedGlossaryTerms: [] },
      ],
    }));

    const result = await verifyFix(
      client,
      finding({ kind: "pii-untagged", severity: 80, column: "email" }),
    );

    expect(result).toMatchObject({ ok: true, column: "email" });
    expect(client.calls[0]).toEqual({
      name: "list_schema_fields",
      args: { urn: ORDERS, keywords: [] },
    });
  });

  it("reports a mismatch when the write is absent", async () => {
    const client = new MockDataHubClient().on("get_entities", () => [
      { urn: ORDERS, ownership: { owners: [] } },
    ]);

    await expect(verifyFix(client, finding())).resolves.toMatchObject({
      ok: false,
      after: "still no owner",
    });
  });
});

describe("runRound", () => {
  it("gates one targeted fix, verifies it, and writes the audit pair", async () => {
    let ownerAdded = false;
    const client = new MockDataHubClient()
      .on("search", () => ({
        searchResults: [{ entity: { urn: ORDERS, properties: { name: "orders" } } }],
      }))
      .on("get_entities", () => [
        {
          urn: ORDERS,
          name: "orders",
          ownership: { owners: ownerAdded ? [{ owner: "urn:li:corpuser:datahub" }] : [] },
          properties: { description: "Documented order facts." },
        },
      ])
      .on("list_schema_fields", () => ({ fields: [] }))
      .on("add_owners", () => {
        ownerAdded = true;
        return { success: true };
      });
    const lines: string[] = [];
    const io: HarnessIO = {
      write: (line) => lines.push(line),
      ask: async () => "yes",
    };
    const reportDir = mkdtempSync(join(tmpdir(), "metamender-round-"));

    const exitCode = await runRound(
      client,
      {
        targets: [{ kind: "missing-owner", urnSubstr: "orders" }],
        reportDir,
      },
      io,
    );

    expect(exitCode).toBe(0);
    expect(ownerAdded).toBe(true);
    expect(lines.some((line) => line.includes("VERIFIED"))).toBe(true);
    const audit = JSON.parse(
      readFileSync(join(reportDir, readAuditName(reportDir)), "utf8"),
    ) as { counts: { fixed: number }; verifications: Array<{ ok: boolean }> };
    expect(audit.counts.fixed).toBe(1);
    expect(audit.verifications).toEqual([expect.objectContaining({ ok: true })]);
  });
});

function readAuditName(dir: string): string {
  return readdirSync(dir).find((name) => name.endsWith(".json")) as string;
}
