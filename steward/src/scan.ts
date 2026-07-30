import type { DataHubClient } from "./datahubClient.js";
import type { Finding } from "./types.js";
import { sortFindings } from "./types.js";
import { searchDatasets, getEntities } from "./queries.js";
import { detectMissingOwner } from "./detectors/missingOwner.js";
import { detectMissingDescription } from "./detectors/missingDescription.js";
import { detectPiiUntagged } from "./detectors/piiUntagged.js";
import { detectOrphans } from "./detectors/orphan.js";

/**
 * The read-only governance sweep. One `search` + one batched `get_entities` feed the
 * owner and description detectors; the PII detector walks each dataset's schema
 * fields. Returns a single severity-sorted Finding[].
 */
export interface ScanOptions {
  /** Restrict expensive schema/lineage reads to URNs containing any value. */
  urnSubstrings?: string[];
}

export async function scan(client: DataHubClient, options: ScanOptions = {}): Promise<Finding[]> {
  const discovered = await searchDatasets(client);
  const datasets = options.urnSubstrings?.length
    ? discovered.filter((dataset) =>
        options.urnSubstrings!.some((value) => dataset.urn.includes(value)),
      )
    : discovered;
  const entities = await getEntities(client, datasets.map((d) => d.urn));

  const [owner, description, pii, orphan] = await Promise.all([
    detectMissingOwner(client, entities),
    detectMissingDescription(client, entities),
    detectPiiUntagged(client, datasets),
    detectOrphans(client, datasets),
  ]);

  return sortFindings([...owner, ...description, ...pii, ...orphan]);
}
