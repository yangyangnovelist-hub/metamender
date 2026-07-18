import { describe, it, expect } from "vitest";
import {
  isPiiFieldName,
  hasPiiTerm,
  detectPiiUntaggedForDataset,
  detectPiiUntagged,
  PII_TERM_URN,
} from "../steward/src/detectors/piiUntagged.js";
import type { SchemaField } from "../steward/src/types.js";
import { MockDataHubClient, loadFixture } from "./helpers/mockClient.js";

const ADDR_FIXTURE = loadFixture<{ urn: string; result: { fields: SchemaField[] } }>(
  "list-schema-fields-addresses.json",
);
const ADDR_URN = ADDR_FIXTURE.urn;
const ADDR_FIELDS = ADDR_FIXTURE.result.fields;

describe("isPiiFieldName heuristic", () => {
  const positives = [
    "email",
    "customer_email",
    "ssn",
    "phone_number",
    "zipcode",
    "shipping_zipcode",
    "town_city",
    "shipping_town_city",
    "home_address",
    "credit_limit",
    "dob",
    "ip_address",
    "client_ip",
  ];
  const negatives = [
    "region_id",
    "country_id",
    "date_created",
    "order_id",
    "quantity",
    "description", // contains "ip" as a substring but not as a token
    "recipient_name_id",
  ];
  it.each(positives)("flags %s as PII-looking", (name) => {
    expect(isPiiFieldName(name)).toBe(true);
  });
  it.each(negatives)("does not flag %s", (name) => {
    expect(isPiiFieldName(name)).toBe(false);
  });
});

describe("hasPiiTerm", () => {
  it("true for editedGlossaryTerms string array with PII", () => {
    expect(hasPiiTerm({ fieldPath: "x", editedGlossaryTerms: ["PII"] })).toBe(true);
  });
  it("true for object-shaped terms with a PII name", () => {
    expect(hasPiiTerm({ fieldPath: "x", terms: [{ name: "PII" }] })).toBe(true);
  });
  it("false when no terms", () => {
    expect(hasPiiTerm({ fieldPath: "x" })).toBe(false);
  });
  it("false when the term is not PII", () => {
    expect(hasPiiTerm({ fieldPath: "x", editedGlossaryTerms: ["Sensitive"] })).toBe(false);
  });
});

describe("detectPiiUntaggedForDataset (pure, addresses fixture)", () => {
  it("flags town_city only (zipcode/address_* already carry the PII term)", () => {
    const findings = detectPiiUntaggedForDataset(
      { urn: ADDR_URN, name: "ADDRESSES" },
      ADDR_FIELDS,
      false,
    );
    expect(findings.map((f) => f.column)).toEqual(["town_city"]);
    const f = findings[0];
    expect(f.kind).toBe("pii-untagged");
    expect(f.severity).toBe(80); // no downstream
    expect(f.urn).toBe(ADDR_URN);
    expect(f.proposedFix).toContain(PII_TERM_URN);
  });

  it("boosts severity to 100 when the table has downstreams", () => {
    const findings = detectPiiUntaggedForDataset(
      { urn: ADDR_URN, name: "ADDRESSES" },
      ADDR_FIELDS,
      true,
    );
    expect(findings[0].severity).toBe(100);
  });
});

describe("detectPiiUntagged (client-driven)", () => {
  it("fetches fields + lineage per dataset and flags town_city", async () => {
    const client = new MockDataHubClient()
      .on("list_schema_fields", () => ({ fields: ADDR_FIELDS }))
      .on("get_lineage", () => ({ downstreams: { total: 0 } }));

    const findings = await detectPiiUntagged(client, [
      { urn: ADDR_URN, name: "ADDRESSES" },
    ]);

    expect(findings.map((f) => f.column)).toEqual(["town_city"]);
    // keywords must be passed as an array (recon gotcha #5).
    const call = client.calls.find((c) => c.name === "list_schema_fields");
    expect(Array.isArray(call?.args.keywords)).toBe(true);
  });
});
