import type { DataHubClient } from "../datahubClient.js";
import type { DataHubEntity, Finding } from "../types.js";
import { severityFor } from "../types.js";
import { searchDatasets, getEntities } from "../queries.js";

/** True iff the entity has at least one owner. */
export function hasOwner(entity: DataHubEntity): boolean {
  const owners = entity.ownership?.owners;
  return Array.isArray(owners) && owners.length > 0;
}

/**
 * Detect datasets with no owner: `search` datasets -> `get_entities` -> flag any
 * with an empty ownership aspect. Pass `entities` to reuse an already-fetched batch
 * (scan does this so owner + description detectors share one get_entities call).
 */
export async function detectMissingOwner(
  client: DataHubClient,
  entities?: DataHubEntity[],
): Promise<Finding[]> {
  const batch = entities ?? (await fetchAll(client));
  return batch.filter((e) => !hasOwner(e)).map(toFinding);
}

async function fetchAll(client: DataHubClient): Promise<DataHubEntity[]> {
  const datasets = await searchDatasets(client);
  return getEntities(client, datasets.map((d) => d.urn));
}

function toFinding(entity: DataHubEntity): Finding {
  const entityName = entity.name ?? entity.properties?.name ?? entity.urn;
  return {
    urn: entity.urn,
    kind: "missing-owner",
    severity: severityFor("missing-owner"),
    entityName,
    evidence: `Dataset "${entityName}" has no owner assigned.`,
    proposedFix:
      "Assign a technical owner via add_owners (ownership_type TECHNICAL_OWNER).",
  };
}
