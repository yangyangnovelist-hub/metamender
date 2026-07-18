import type { DataHubClient } from "./datahubClient.js";
import type { DataHubEntity, SchemaField } from "./types.js";

/** A dataset URN + its display name, as surfaced by `search`. */
export interface DatasetRef {
  urn: string;
  name: string;
}

/**
 * `search` for datasets. Returns urn+name pairs. Pages via num_results/offset;
 * `total` in the response is exact (recon note #9).
 */
export async function searchDatasets(
  client: DataHubClient,
  max = 100,
): Promise<DatasetRef[]> {
  const res = await client.callTool<SearchResponse>("search", {
    query: "*",
    filter: "entity_type = dataset",
    num_results: max,
  });
  const results = res?.searchResults ?? [];
  return results
    .map((r) => r.entity)
    .filter((e): e is SearchEntity => !!e?.urn)
    .map((e) => ({ urn: e.urn, name: e.properties?.name ?? shortName(e.urn) }));
}

/** Batch-fetch full detail for a list of URNs via `get_entities`. */
export async function getEntities(
  client: DataHubClient,
  urns: string[],
): Promise<DataHubEntity[]> {
  if (urns.length === 0) return [];
  const res = await client.callTool<DataHubEntity[] | { entities?: DataHubEntity[] }>(
    "get_entities",
    { urns },
  );
  if (Array.isArray(res)) return res;
  return res?.entities ?? [];
}

/**
 * List a dataset's schema fields. `keywords` MUST be an array (recon gotcha #5);
 * we pass none here and scan every field ourselves (keywords is a match hint, not
 * a hard filter — it still returns all fields).
 */
export async function getSchemaFields(
  client: DataHubClient,
  urn: string,
): Promise<SchemaField[]> {
  const res = await client.callTool<SchemaFieldsResponse>("list_schema_fields", {
    urn,
    keywords: [],
  });
  return res?.fields ?? [];
}

/**
 * Best-effort downstream count for severity boosting. Any failure (no lineage,
 * tool hiccup) degrades to 0 so a scan never breaks on lineage.
 */
export async function getDownstreamCount(
  client: DataHubClient,
  urn: string,
): Promise<number> {
  try {
    const res = await client.callTool<LineageResponse>("get_lineage", {
      urn,
      upstream: false,
      max_hops: 1,
      max_results: 30,
    });
    return res?.downstreams?.total ?? res?.total ?? res?.downstreams?.results?.length ?? 0;
  } catch {
    return 0;
  }
}

function shortName(urn: string): string {
  const m = urn.match(/,([^,]+),[A-Z]+\)$/);
  if (!m) return urn;
  const path = m[1];
  return path.split(".").pop() ?? path;
}

interface SearchEntity {
  urn: string;
  properties?: { name?: string } | null;
}
interface SearchResponse {
  total?: number;
  searchResults?: Array<{ entity?: SearchEntity }>;
}
interface SchemaFieldsResponse {
  fields?: SchemaField[];
}
interface LineageResponse {
  total?: number;
  downstreams?: { total?: number; results?: unknown[] };
}
