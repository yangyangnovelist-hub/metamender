import { describe, it, expect } from "vitest";
import {
  detectMissingDescription,
  hasDescription,
} from "../steward/src/detectors/missingDescription.js";
import type { DataHubEntity } from "../steward/src/types.js";
import { MockDataHubClient, loadFixture } from "./helpers/mockClient.js";

const ENTITIES = loadFixture<DataHubEntity[]>("get-entities-all.json");

describe("hasDescription (gotcha #4: check BOTH overlays)", () => {
  it("false when both properties and editableProperties are empty", () => {
    expect(hasDescription({ urn: "x" })).toBe(false);
    expect(
      hasDescription({ urn: "x", properties: {}, editableProperties: {} }),
    ).toBe(false);
    expect(
      hasDescription({
        urn: "x",
        properties: { description: "" },
        editableProperties: { description: "   " },
      }),
    ).toBe(false);
  });
  it("true when only properties.description is set", () => {
    expect(hasDescription({ urn: "x", properties: { description: "hi" } })).toBe(true);
  });
  it("true when only editableProperties.description is set (the write-back overlay)", () => {
    expect(
      hasDescription({ urn: "x", editableProperties: { description: "hi" } }),
    ).toBe(true);
  });
});

describe("detectMissingDescription", () => {
  it("flags exactly the undocumented datasets from the fixture (14 of 30)", async () => {
    const client = new MockDataHubClient()
      .on("search", () => ({
        searchResults: ENTITIES.map((e) => ({ entity: { urn: e.urn } })),
      }))
      .on("get_entities", () => ENTITIES);

    const findings = await detectMissingDescription(client);

    expect(findings).toHaveLength(14);
    expect(findings.every((f) => f.kind === "missing-description")).toBe(true);
    expect(findings.every((f) => f.severity === 40)).toBe(true);
    // The dbt order_details is documented -> its urn must not be flagged.
    // (Several datasets share the name "order_details", so assert on urn.)
    const flaggedUrns = findings.map((f) => f.urn);
    expect(flaggedUrns).not.toContain(
      "urn:li:dataset:(urn:li:dataPlatform:dbt,b2fd91.ORDER_ENTRY_DB.analytics.order_details,PROD)",
    );
  });

  it("reuses pre-fetched entities without hitting the client", async () => {
    const findings = await detectMissingDescription(new MockDataHubClient(), ENTITIES);
    expect(findings).toHaveLength(14);
  });
});
