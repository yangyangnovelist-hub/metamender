/** The kinds of governance gap MetaMender detects (read-only phase). */
export type FindingKind =
  | "pii-untagged"
  | "missing-owner"
  | "missing-description"
  | "orphan";

/**
 * One governance gap on one entity. Deterministic, serializable — the scan emits
 * a severity-sorted `Finding[]` that the agent layer explains and (on confirm) fixes.
 */
export interface Finding {
  /** The DataHub entity URN the gap is on. */
  urn: string;
  kind: FindingKind;
  /** Higher = more urgent. See severityFor(). */
  severity: number;
  /** Human-readable entity name (e.g. "ADDRESSES"). */
  entityName: string;
  /** Plain-English statement of what's missing / wrong. */
  evidence: string;
  /** What the write-back would do (Phase 2 acts on this). */
  proposedFix: string;
  /** For column-level findings (pii-untagged): the field path. */
  column?: string;
}

/**
 * Severity ordering (task spec): pii-untagged (higher when the table has active
 * downstreams) > missing-owner > missing-description > orphan. Encoded as scores
 * so a plain numeric sort ranks findings; the downstream boost keeps a PII gap on
 * a widely-consumed table above one on a leaf table.
 */
export const SEVERITY = {
  piiUntaggedWithDownstream: 100,
  piiUntagged: 80,
  missingOwner: 60,
  missingDescription: 40,
  orphan: 20,
} as const;

export function severityFor(
  kind: FindingKind,
  opts: { hasDownstream?: boolean } = {},
): number {
  switch (kind) {
    case "pii-untagged":
      return opts.hasDownstream ? SEVERITY.piiUntaggedWithDownstream : SEVERITY.piiUntagged;
    case "missing-owner":
      return SEVERITY.missingOwner;
    case "missing-description":
      return SEVERITY.missingDescription;
    case "orphan":
      return SEVERITY.orphan;
  }
}

/**
 * Sort findings most-urgent-first. Stable tiebreak on urn then column so output is
 * deterministic (important for fixture-based CLI tests).
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    if (a.urn !== b.urn) return a.urn < b.urn ? -1 : 1;
    return (a.column ?? "").localeCompare(b.column ?? "");
  });
}

/** Partial view of a DataHub entity as returned by the `get_entities` tool. */
export interface DataHubEntity {
  urn: string;
  name?: string;
  ownership?: { owners?: unknown[] } | null;
  properties?: { name?: string; description?: string } | null;
  editableProperties?: { description?: string } | null;
}

/** One schema field as returned by `list_schema_fields`. */
export interface SchemaField {
  fieldPath: string;
  nativeDataType?: string;
  editedGlossaryTerms?: Array<string | { name?: string; urn?: string }>;
  glossaryTerms?: unknown;
  terms?: Array<string | { name?: string; urn?: string }>;
}
