/**
 * One-off recorder: capture real MCP responses from the local DataHub quickstart
 * into test/fixtures/ so the detector unit tests run offline against real shapes.
 *
 *   npx tsx scripts/record-fixtures.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StdioDataHubClient, configFromEnv } from "../steward/src/datahubClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "..", "test", "fixtures");
mkdirSync(FIX, { recursive: true });

function dump(name: string, data: unknown) {
  writeFileSync(join(FIX, name), JSON.stringify(data, null, 2) + "\n");
  console.error(`wrote ${name}`);
}

const main = async () => {
  const client = new StdioDataHubClient({ ...configFromEnv(), mutationEnabled: false });
  try {
    const search = await client.callTool("search", {
      query: "*",
      filter: "entity_type = dataset",
      num_results: 30,
    });
    dump("search-datasets.json", search);

    // Pull URNs out of the search result (shape unknown until we see it).
    const urns = extractUrns(search);
    console.error(`found ${urns.length} dataset urns`);

    const entities = await client.callTool("get_entities", { urns });
    dump("get-entities-all.json", entities);

    // The ADDRESSES dataset from recon: has PII-looking untagged fields.
    const addr =
      urns.find((u) => u.includes("order_entry.addresses") && u.includes("snowflake")) ??
      urns[0];
    const fields = await client.callTool("list_schema_fields", { urn: addr });
    dump("list-schema-fields-addresses.json", { urn: addr, result: fields });

    const fieldsFiltered = await client.callTool("list_schema_fields", {
      urn: addr,
      keywords: ["zipcode"],
    });
    dump("list-schema-fields-addresses-zipcode.json", {
      urn: addr,
      result: fieldsFiltered,
    });
  } finally {
    await client.close();
  }
};

function extractUrns(search: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("urn:li:dataset:")) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(search);
  return [...new Set(out)];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
