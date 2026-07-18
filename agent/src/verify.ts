/**
 * Post-fix verification: re-read the entity straight from DataHub (not the
 * write's own ack) and report the before/after state per finding kind. This is
 * the independent confirmation that a mutation actually landed — recon gotcha #4
 * (descriptions live under editableProperties) is handled here.
 */
import type { DataHubClient } from "../../steward/src/datahubClient.js";
import type { Finding } from "../../steward/src/types.js";
import { getEntities, getSchemaFields } from "../../steward/src/queries.js";
import { hasOwner } from "../../steward/src/detectors/missingOwner.js";
import { hasDescription } from "../../steward/src/detectors/missingDescription.js";
import { hasPiiTerm } from "../../steward/src/detectors/piiUntagged.js";
import type { Verification } from "../../report/src/audit.js";

/** Re-read `finding`'s entity and produce a before/after verification record. */
export async function verifyFix(client: DataHubClient, finding: Finding): Promise<Verification> {
  switch (finding.kind) {
    case "missing-owner": {
      const [entity] = await getEntities(client, [finding.urn]);
      const owners = entity?.ownership?.owners ?? [];
      const ok = !!entity && hasOwner(entity);
      return {
        urn: finding.urn,
        kind: finding.kind,
        before: "no owner",
        after: ok ? `owner(s): ${ownerLabels(owners)}` : "still no owner",
        ok,
      };
    }
    case "missing-description": {
      const [entity] = await getEntities(client, [finding.urn]);
      const desc = entity?.editableProperties?.description ?? "";
      const ok = !!entity && hasDescription(entity);
      return {
        urn: finding.urn,
        kind: finding.kind,
        before: "no description",
        after: ok ? truncate(desc, 120) : "still no description",
        ok,
      };
    }
    case "pii-untagged": {
      const fields = await getSchemaFields(client, finding.urn);
      const field = fields.find((f) => f.fieldPath === finding.column);
      const ok = !!field && hasPiiTerm(field);
      return {
        urn: finding.urn,
        kind: finding.kind,
        column: finding.column,
        before: `no PII term on "${finding.column}"`,
        after: ok ? `PII term now on "${finding.column}"` : `still no PII term on "${finding.column}"`,
        ok,
      };
    }
    default:
      return {
        urn: finding.urn,
        kind: finding.kind,
        before: "n/a",
        after: "n/a",
        ok: false,
      };
  }
}

function ownerLabels(owners: unknown[]): string {
  return owners
    .map((o) => {
      if (typeof o === "string") return o;
      // DataHub shape: { owner: { urn, name, properties: { displayName } }, ... }
      const obj = o as {
        owner?: { properties?: { displayName?: string }; name?: string; urn?: string };
        ownerUrn?: string;
        urn?: string;
      };
      const nested = obj.owner;
      if (nested && typeof nested === "object") {
        return nested.properties?.displayName ?? nested.name ?? nested.urn ?? JSON.stringify(o);
      }
      return (
        (typeof obj.owner === "string" ? obj.owner : undefined) ??
        obj.ownerUrn ??
        obj.urn ??
        JSON.stringify(o)
      );
    })
    .join(", ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
