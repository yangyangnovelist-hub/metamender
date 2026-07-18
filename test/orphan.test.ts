import { describe, expect, it } from "vitest";
import { detectOrphans } from "../steward/src/detectors/orphan.js";
import { MockDataHubClient } from "./helpers/mockClient.js";

const ISOLATED = { urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,isolated,PROD)", name: "isolated" };
const CONNECTED = { urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,connected,PROD)", name: "connected" };
const UNKNOWN = { urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,unknown,PROD)", name: "unknown" };

describe("detectOrphans", () => {
  it("flags only datasets with zero upstreams and zero downstreams", async () => {
    const client = new MockDataHubClient().on("get_lineage", (args) => {
      if (args.urn === ISOLATED.urn) {
        return args.upstream
          ? { upstreams: { total: 0, results: [] } }
          : { downstreams: { total: 0, results: [] } };
      }
      return args.upstream
        ? { upstreams: { total: 1, results: [{}] } }
        : { downstreams: { total: 0, results: [] } };
    });

    const findings = await detectOrphans(client, [ISOLATED, CONNECTED]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      urn: ISOLATED.urn,
      kind: "orphan",
      severity: 20,
      entityName: "isolated",
    });
  });

  it("does not turn a lineage query failure into a finding", async () => {
    const client = new MockDataHubClient().on("get_lineage", () => {
      throw new Error("lineage unavailable");
    });

    expect(await detectOrphans(client, [UNKNOWN])).toEqual([]);
  });
});
