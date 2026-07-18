import { describe, it, expect } from "vitest";
import { detectMissingOwner, hasOwner } from "../steward/src/detectors/missingOwner.js";
import type { DataHubEntity } from "../steward/src/types.js";
import { MockDataHubClient, loadFixture } from "./helpers/mockClient.js";

const ENTITIES = loadFixture<DataHubEntity[]>("get-entities-all.json");

describe("hasOwner", () => {
  it("false when ownership is absent", () => {
    expect(hasOwner({ urn: "x" })).toBe(false);
  });
  it("false when owners array is empty", () => {
    expect(hasOwner({ urn: "x", ownership: { owners: [] } })).toBe(false);
  });
  it("true when at least one owner", () => {
    expect(hasOwner({ urn: "x", ownership: { owners: [{}] } })).toBe(true);
  });
});

describe("detectMissingOwner", () => {
  it("flags exactly the owner-less datasets from the fixture (10 of 30)", async () => {
    const client = new MockDataHubClient()
      .on("search", () => ({
        searchResults: ENTITIES.map((e) => ({ entity: { urn: e.urn } })),
      }))
      .on("get_entities", () => ENTITIES);

    const findings = await detectMissingOwner(client);

    expect(findings).toHaveLength(10);
    expect(findings.every((f) => f.kind === "missing-owner")).toBe(true);
    expect(findings.every((f) => f.severity === 60)).toBe(true);
    const names = findings.map((f) => f.entityName);
    expect(names).toContain("ADDRESSES");
    expect(names).toContain("order_history");
    // A well-owned dataset must not be flagged.
    expect(names).not.toContain("order_details");
  });

  it("reuses pre-fetched entities without calling the client", async () => {
    const client = new MockDataHubClient(); // no handlers -> throws if called
    const findings = await detectMissingOwner(client, ENTITIES);
    expect(findings).toHaveLength(10);
    expect(client.calls).toHaveLength(0);
  });

  it("carries urn and a proposed add_owners fix", async () => {
    const findings = await detectMissingOwner(new MockDataHubClient(), ENTITIES);
    const f = findings[0];
    expect(f.urn).toMatch(/^urn:li:dataset:/);
    expect(f.proposedFix.toLowerCase()).toContain("owner");
  });
});
