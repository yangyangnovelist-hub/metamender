import type { DataHubClient } from "./datahubClient.js";
import type { Finding } from "./types.js";
import { sortFindings } from "./types.js";
import { searchDatasets, getEntities } from "./queries.js";
import { detectMissingOwner } from "./detectors/missingOwner.js";
import { detectMissingDescription } from "./detectors/missingDescription.js";
import { detectPiiUntagged } from "./detectors/piiUntagged.js";

/**
 * The read-only governance sweep. One `search` + one batched `get_entities` feed the
 * owner and description detectors; the PII detector walks each dataset's schema
 * fields. Returns a single severity-sorted Finding[].
 */
export async function scan(client: DataHubClient): Promise<Finding[]> {
  const datasets = await searchDatasets(client);
  const entities = await getEntities(client, datasets.map((d) => d.urn));

  const [owner, description, pii] = await Promise.all([
    detectMissingOwner(client, entities),
    detectMissingDescription(client, entities),
    detectPiiUntagged(client, datasets),
  ]);

  return sortFindings([...owner, ...description, ...pii]);
}
