/**
 * Unit tests for the audit report (Task 2.4).
 *
 * Every MetaMender run emits a human-readable md + machine-readable json audit:
 * what was found, what the human approved, what was written back, and the
 * before/after verification.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../steward/src/types.js";
import { renderMarkdown, buildAuditJson, writeAudit, type AuditInput } from "../report/src/audit.js";

const ADDR =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.addresses,PROD)";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    urn: ADDR,
    kind: "missing-owner",
    severity: 60,
    entityName: "ADDRESSES",
    evidence: "no owner",
    proposedFix: "add owner",
    ...overrides,
  };
}

function sampleInput(): AuditInput {
  return {
    runAt: "2026-07-18T00:00:00.000Z",
    target: "showcase-ecommerce (local quickstart)",
    summary: {
      findings: [finding(), finding({ kind: "pii-untagged", column: "town_city", entityName: "ADDRESSES" })],
      fixed: [
        {
          finding: finding(),
          result: {
            mutation: {
              tool: "add_owners",
              args: { owner_urns: ["urn:li:corpuser:datahub"], entity_urns: [ADDR], ownership_type: "TECHNICAL_OWNER" },
            },
            result: { success: true, message: "Added owner" },
          },
        },
      ],
      skipped: [finding({ kind: "pii-untagged", column: "town_city" })],
      failed: [],
      quit: false,
    },
    verifications: [
      { urn: ADDR, kind: "missing-owner", before: "no owner", after: "owner: urn:li:corpuser:datahub", ok: true },
    ],
  };
}

describe("renderMarkdown", () => {
  it("captures found / approved / written-back / before-after", () => {
    const md = renderMarkdown(sampleInput());
    expect(md).toContain("showcase-ecommerce");
    expect(md).toContain("2026-07-18");
    // found
    expect(md).toContain("2 governance gap");
    // written back (mutation tool + urn)
    expect(md).toContain("add_owners");
    expect(md).toContain(ADDR);
    // approved vs skipped counts
    expect(md).toContain("Fixed: 1");
    expect(md).toContain("Skipped: 1");
    // before/after verification
    expect(md).toContain("no owner");
    expect(md).toContain("owner: urn:li:corpuser:datahub");
    expect(md).toContain("VERIFIED");
  });
});

describe("buildAuditJson", () => {
  it("is a serializable object with the run facts", () => {
    const obj = buildAuditJson(sampleInput());
    expect(obj.target).toBe("showcase-ecommerce (local quickstart)");
    expect(obj.counts).toEqual({ found: 2, fixed: 1, skipped: 1, failed: 0 });
    expect(obj.fixed[0]!.mutation.tool).toBe("add_owners");
    expect(obj.verifications[0]!.ok).toBe(true);
    // round-trips through JSON
    expect(() => JSON.parse(JSON.stringify(obj))).not.toThrow();
  });
});

describe("writeAudit", () => {
  it("writes both an .md and a .json file and returns their paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-audit-"));
    const { mdPath, jsonPath } = writeAudit(dir, sampleInput(), "audit-test");
    expect(mdPath).toMatch(/audit-test\.md$/);
    expect(jsonPath).toMatch(/audit-test\.json$/);
    expect(readFileSync(mdPath, "utf8")).toContain("add_owners");
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(parsed.counts.fixed).toBe(1);
  });
});
