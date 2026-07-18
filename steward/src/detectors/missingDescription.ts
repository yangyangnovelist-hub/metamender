import type { DataHubClient } from "../datahubClient.js";
import type { DataHubEntity, Finding } from "../types.js";
import { severityFor } from "../types.js";
import { searchDatasets, getEntities } from "../queries.js";

/**
 * True iff the entity is documented. Recon gotcha #4: `update_description` writes to
 * the *editable* overlay, so a documented entity may have its text in either
 * `properties.description` (ingested) OR `editableProperties.description` (edited).
 * A dataset is undocumented only when BOTH are blank.
 */
export function hasDescription(entity: DataHubEntity): boolean {
  const ingested = entity.properties?.description;
  const edited = entity.editableProperties?.description;
  return isNonEmpty(ingested) || isNonEmpty(edited);
}

function isNonEmpty(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Detect datasets with no description in either overlay. */
export async function detectMissingDescription(
  client: DataHubClient,
  entities?: DataHubEntity[],
): Promise<Finding[]> {
  const batch = entities ?? (await fetchAll(client));
  return batch.filter((e) => !hasDescription(e)).map(toFinding);
}

async function fetchAll(client: DataHubClient): Promise<DataHubEntity[]> {
  const datasets = await searchDatasets(client);
  return getEntities(client, datasets.map((d) => d.urn));
}

function toFinding(entity: DataHubEntity): Finding {
  const entityName = entity.name ?? entity.properties?.name ?? entity.urn;
  return {
    urn: entity.urn,
    kind: "missing-description",
    severity: severityFor("missing-description"),
    entityName,
    evidence: `Dataset "${entityName}" has no description (neither ingested nor editable).`,
    proposedFix:
      'Write an AI-drafted description (marked "drafted by MetaMender") via update_description.',
  };
}
