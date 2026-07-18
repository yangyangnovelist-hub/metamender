import type { DataHubClient } from "../datahubClient.js";
import type { Finding } from "../types.js";
import { severityFor } from "../types.js";
import { getLineageCount, searchDatasets, type DatasetRef } from "../queries.js";

const LINEAGE_CONCURRENCY = 5;

/**
 * Flag datasets with neither upstream nor downstream lineage. Query failures are
 * inconclusive and never become findings.
 */
export async function detectOrphans(
  client: DataHubClient,
  datasets?: DatasetRef[],
): Promise<Finding[]> {
  const targets = datasets ?? (await searchDatasets(client));
  const findings: Finding[] = [];

  for (let start = 0; start < targets.length; start += LINEAGE_CONCURRENCY) {
    const batch = targets.slice(start, start + LINEAGE_CONCURRENCY);
    const evaluated = await Promise.all(
      batch.map(async (dataset): Promise<Finding | undefined> => {
        const [upstreams, downstreams] = await Promise.all([
          getLineageCount(client, dataset.urn, true),
          getLineageCount(client, dataset.urn, false),
        ]);
        if (upstreams === undefined || downstreams === undefined) return undefined;
        if (upstreams > 0 || downstreams > 0) return undefined;
        return {
          urn: dataset.urn,
          kind: "orphan",
          severity: severityFor("orphan"),
          entityName: dataset.name,
          evidence: `Dataset "${dataset.name}" has no upstream or downstream lineage.`,
          proposedFix: "Review for deprecation, deletion, or missing lineage; no automatic mutation is proposed.",
        };
      }),
    );
    findings.push(...evaluated.filter((finding): finding is Finding => finding !== undefined));
  }

  return findings;
}
