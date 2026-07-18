/**
 * Unit tests for the fix layer (Task 2.1).
 *
 * These pin the mutation calls MetaMender builds to the EXACT tool names and
 * argument shapes captured live in docs/mcp-recon.md §2/§4 — a drift here means
 * the write-back would silently fail against the real DataHub MCP server. Every
 * call is captured through MockDataHubClient and asserted field-by-field.
 */
import { describe, it, expect } from "vitest";
import type { Finding } from "../steward/src/types.js";
import {
  planFix,
  applyFix,
  templateDescription,
  platformOf,
  DEFAULT_OWNER_URN,
  DEFAULT_OWNERSHIP_TYPE,
  DESCRIPTION_PREFIX,
} from "../steward/src/fixes.js";
import { PII_TERM_URN } from "../steward/src/detectors/piiUntagged.js";
import { MockDataHubClient, loadFixture } from "./helpers/mockClient.js";

const ADDR_URN =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.addresses,PROD)";

function ownerFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    urn: ADDR_URN,
    kind: "missing-owner",
    severity: 60,
    entityName: "ADDRESSES",
    evidence: "no owner",
    proposedFix: "add owner",
    ...overrides,
  };
}
function descFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    urn: ADDR_URN,
    kind: "missing-description",
    severity: 40,
    entityName: "ADDRESSES",
    evidence: "no description",
    proposedFix: "draft description",
    ...overrides,
  };
}
function piiFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    urn: ADDR_URN,
    kind: "pii-untagged",
    severity: 80,
    entityName: "ADDRESSES",
    column: "town_city",
    evidence: "looks like PII",
    proposedFix: "tag PII",
    ...overrides,
  };
}

/** Mock that answers list_schema_fields from the addresses fixture and acks writes. */
function makeClient(): MockDataHubClient {
  const schema = loadFixture<{ result: unknown }>(
    "list-schema-fields-addresses.json",
  ).result;
  return new MockDataHubClient()
    .on("list_schema_fields", () => schema)
    .on("add_owners", () => ({ success: true, message: "Added owner" }))
    .on("update_description", () => ({ success: true, message: "Description updated successfully" }))
    .on("add_terms", () => ({ success: true, message: "Successfully added 1 glossary term(s)" }));
}

describe("platformOf", () => {
  it("extracts the data platform from a dataset urn", () => {
    expect(platformOf(ADDR_URN)).toBe("snowflake");
    expect(
      platformOf(
        "urn:li:dataset:(urn:li:dataPlatform:postgres,b2fd91.x.addresses,PROD)",
      ),
    ).toBe("postgres");
  });
  it("returns undefined for a urn with no platform", () => {
    expect(platformOf("urn:li:corpuser:datahub")).toBeUndefined();
  });
});

describe("planFix — missing-owner", () => {
  it("builds add_owners with the exact recon signature", async () => {
    const client = makeClient();
    const mutation = await planFix(client, ownerFinding());
    expect(mutation.tool).toBe("add_owners");
    expect(mutation.args).toEqual({
      owner_urns: [DEFAULT_OWNER_URN],
      entity_urns: [ADDR_URN],
      ownership_type: DEFAULT_OWNERSHIP_TYPE,
    });
    expect(DEFAULT_OWNER_URN).toBe("urn:li:corpuser:datahub");
    expect(DEFAULT_OWNERSHIP_TYPE).toBe("TECHNICAL_OWNER");
  });

  it("honors an owner/ownership-type override", async () => {
    const client = makeClient();
    const mutation = await planFix(client, ownerFinding(), {
      ownerUrn: "urn:li:corpuser:alice",
      ownershipType: "DATA_OWNER",
    });
    expect(mutation.args).toEqual({
      owner_urns: ["urn:li:corpuser:alice"],
      entity_urns: [ADDR_URN],
      ownership_type: "DATA_OWNER",
    });
  });
});

describe("planFix — missing-description", () => {
  it("builds update_description with operation=replace and a MetaMender-marked draft", async () => {
    const client = makeClient();
    const mutation = await planFix(client, descFinding());
    expect(mutation.tool).toBe("update_description");
    expect(mutation.args.entity_urn).toBe(ADDR_URN);
    expect(mutation.args.operation).toBe("replace");
    const desc = mutation.args.description as string;
    expect(desc.startsWith(DESCRIPTION_PREFIX)).toBe(true);
    // Template weaves in platform, dataset name, and schema field names.
    expect(desc).toContain("snowflake");
    expect(desc).toContain("ADDRESSES");
    expect(desc).toContain("town_city");
    expect(desc).toContain("zipcode");
    // It had to read the schema to draft.
    expect(client.calls.some((c) => c.name === "list_schema_fields")).toBe(true);
  });

  it("uses an injected drafter when provided (e.g. an LLM), still via update_description", async () => {
    const client = makeClient();
    const mutation = await planFix(client, descFinding(), {
      draft: () => "Drafted by MetaMender — custom text.",
    });
    expect(mutation.tool).toBe("update_description");
    expect(mutation.args.description).toBe("Drafted by MetaMender — custom text.");
  });
});

describe("planFix — pii-untagged", () => {
  it("builds add_terms with the real PII glossary term urn, on the exact column", async () => {
    const client = makeClient();
    const mutation = await planFix(client, piiFinding());
    expect(mutation.tool).toBe("add_terms");
    expect(mutation.args).toEqual({
      term_urns: [PII_TERM_URN],
      entity_urns: [ADDR_URN],
      column_paths: ["town_city"],
    });
    // The recon-verified term urn, not a guess.
    expect(PII_TERM_URN).toBe(
      "urn:li:glossaryTerm:b2fd91.1598cf93-c199-43a1-8833-fce96faa9a1a",
    );
  });

  it("throws when a pii finding has no column (can't tag a phantom field)", async () => {
    const client = makeClient();
    await expect(planFix(client, piiFinding({ column: undefined }))).rejects.toThrow();
  });
});

describe("applyFix — executes the planned mutation through the client", () => {
  it("calls the mapped tool with the mapped args and returns the ack", async () => {
    const client = makeClient();
    const applied = await applyFix(client, ownerFinding());
    expect(applied.mutation.tool).toBe("add_owners");
    // The tool was actually invoked with those exact args.
    const call = client.calls.find((c) => c.name === "add_owners");
    expect(call?.args).toEqual({
      owner_urns: [DEFAULT_OWNER_URN],
      entity_urns: [ADDR_URN],
      ownership_type: DEFAULT_OWNERSHIP_TYPE,
    });
    expect(applied.result).toMatchObject({ success: true });
  });

  it("is idempotent: repeating the same fix issues the identical call each time", async () => {
    const client = makeClient();
    await applyFix(client, piiFinding());
    await applyFix(client, piiFinding());
    const termCalls = client.calls.filter((c) => c.name === "add_terms");
    expect(termCalls).toHaveLength(2);
    expect(termCalls[0]!.args).toEqual(termCalls[1]!.args);
  });
});

describe("templateDescription", () => {
  it("marks the draft and lists field count + names", () => {
    const fields = [{ fieldPath: "a" }, { fieldPath: "b" }, { fieldPath: "c" }];
    const text = templateDescription(descFinding(), fields);
    expect(text.startsWith(DESCRIPTION_PREFIX)).toBe(true);
    expect(text).toContain("snowflake");
    expect(text).toContain("ADDRESSES");
    expect(text).toContain("a");
  });
});
