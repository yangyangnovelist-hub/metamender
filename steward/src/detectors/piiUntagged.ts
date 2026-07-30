import type { DataHubClient } from "../datahubClient.js";
import type { Finding, SchemaField } from "../types.js";
import { severityFor } from "../types.js";
import {
  searchDatasets,
  getSchemaFields,
  getDownstreamCount,
  type DatasetRef,
} from "../queries.js";

/**
 * The showcase-ecommerce catalog's own "PII" glossary term (under the Classification
 * node), captured live in docs/mcp-recon.md §4c. Reused as the auto-tag target so a
 * fix applies the same term the sample data already uses on its tagged columns.
 */
export const PII_TERM_URN =
  "urn:li:glossaryTerm:b2fd91.1598cf93-c199-43a1-8833-fce96faa9a1a";

export function configuredPiiTermUrn(env: NodeJS.ProcessEnv = process.env): string {
  return env.METAMENDER_PII_TERM_URN ?? PII_TERM_URN;
}

/**
 * Substrings that mark a field name as PII-looking. `ip` is handled separately as a
 * whole token (below) so it doesn't fire on "description", "recipient", etc.
 */
const PII_SUBSTRINGS = [
  "email",
  "ssn",
  "phone",
  "zip",
  "address",
  "dob",
  "credit",
  "shipping",
  "town_city",
];
const PII_TOKENS = ["ip"];
const SCHEMA_CONCURRENCY = 5;

/** Name heuristic: does this field name look like it holds personal data? */
export function isPiiFieldName(name: string): boolean {
  const n = name.toLowerCase();
  if (PII_SUBSTRINGS.some((k) => n.includes(k))) return true;
  const tokens = n.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => PII_TOKENS.includes(t));
}

/** True iff the field carries the configured term URN or a term named as PII. */
export function hasPiiTerm(field: SchemaField, piiTermUrn = PII_TERM_URN): boolean {
  const names: string[] = [];
  for (const source of [field.editedGlossaryTerms, field.terms, field.glossaryTerms]) {
    collectTermNames(source, names);
  }
  return names.some((n) => n === piiTermUrn || /pii/i.test(n));
}

function collectTermNames(source: unknown, out: string[]): void {
  if (!Array.isArray(source)) {
    // glossaryTerms can arrive as { terms: [{ term: { name } }] }.
    const nested = (source as { terms?: unknown } | null)?.terms;
    if (Array.isArray(nested)) collectTermNames(nested, out);
    return;
  }
  for (const t of source) {
    if (typeof t === "string") out.push(t);
    else if (t && typeof t === "object") {
      const o = t as { name?: string; urn?: string; term?: { name?: string } };
      if (o.name) out.push(o.name);
      if (o.urn) out.push(o.urn);
      if (o.term?.name) out.push(o.term.name);
    }
  }
}

/** Pure core: flag PII-looking fields on one dataset that carry no PII term. */
export function detectPiiUntaggedForDataset(
  dataset: DatasetRef,
  fields: SchemaField[],
  hasDownstream: boolean,
  piiTermUrn = PII_TERM_URN,
): Finding[] {
  return fields
    .filter((f) => isPiiFieldName(f.fieldPath) && !hasPiiTerm(f, piiTermUrn))
    .map((f) => ({
      urn: dataset.urn,
      kind: "pii-untagged" as const,
      severity: severityFor("pii-untagged", { hasDownstream }),
      entityName: dataset.name,
      column: f.fieldPath,
      evidence:
        `Column "${f.fieldPath}" on "${dataset.name}" looks like PII but has no PII glossary term` +
        (hasDownstream ? " (and the table has active downstreams)." : "."),
      proposedFix: `Apply the PII glossary term (${piiTermUrn}) to column "${f.fieldPath}" via add_terms.`,
    }));
}

/**
 * Detect untagged-PII columns across datasets. For each dataset: `list_schema_fields`
 * (keywords MUST be an array — recon gotcha #5, handled in getSchemaFields) plus a
 * best-effort downstream count for severity boosting. Pass `datasets` to reuse the
 * scan's search result; otherwise it searches.
 */
export async function detectPiiUntagged(
  client: DataHubClient,
  datasets?: DatasetRef[],
): Promise<Finding[]> {
  const targets = datasets ?? (await searchDatasets(client));
  const piiTermUrn = configuredPiiTermUrn();
  const findings: Finding[] = [];
  for (let start = 0; start < targets.length; start += SCHEMA_CONCURRENCY) {
    const batch = targets.slice(start, start + SCHEMA_CONCURRENCY);
    const evaluated = await Promise.all(
      batch.map(async (ds) => {
        const fields = await getSchemaFields(client, ds.urn);
        const hasCandidate = fields.some(
          (f) => isPiiFieldName(f.fieldPath) && !hasPiiTerm(f, piiTermUrn),
        );
        if (!hasCandidate) return [];
        // Only pay for lineage when there's actually something to rank.
        const hasDownstream = (await getDownstreamCount(client, ds.urn)) > 0;
        return detectPiiUntaggedForDataset(ds, fields, hasDownstream, piiTermUrn);
      }),
    );
    findings.push(...evaluated.flat());
  }
  return findings;
}
