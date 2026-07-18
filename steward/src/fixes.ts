import type { DataHubClient } from "./datahubClient.js";
import type { Finding, SchemaField } from "./types.js";
import { getSchemaFields } from "./queries.js";
import { PII_TERM_URN } from "./detectors/piiUntagged.js";

/**
 * The write-back layer: map one governance Finding to the exact DataHub MCP
 * mutation that closes it. Tool names and arg shapes are pinned to the live
 * recon in docs/mcp-recon.md §2/§4 — the unit tests assert them field-by-field.
 *
 * Every mutation here is idempotent against a (urn, aspect) pair:
 *   - `add_owners` / `add_terms` add to a set — re-adding the same owner/term is
 *     a no-op on the GMS side;
 *   - `update_description` uses operation="replace", so re-running overwrites
 *     with the identical text.
 * So a confirmed fix can be safely retried without double-writing.
 */

/** Default technical owner (the built-in `datahub` corp user, always present on quickstart). */
export const DEFAULT_OWNER_URN = "urn:li:corpuser:datahub";
export const DEFAULT_OWNERSHIP_TYPE = "TECHNICAL_OWNER";
/** Every auto-drafted description is prefixed so a human always knows it's machine-authored. */
export const DESCRIPTION_PREFIX = "Drafted by MetaMender —";

/** A concrete tool call ready to hand to the DataHub MCP client. */
export interface PlannedMutation {
  tool: string;
  args: Record<string, unknown>;
}

export interface FixOptions {
  /** Owner urn for missing-owner fixes. Default DEFAULT_OWNER_URN. */
  ownerUrn?: string;
  /** Ownership type for missing-owner fixes. Default TECHNICAL_OWNER. */
  ownershipType?: string;
  /** Glossary term urn for pii-untagged fixes. Default the recon-verified PII term. */
  piiTermUrn?: string;
  /**
   * Optional description drafter. Default is the deterministic template below.
   * The agent layer can inject an LLM-backed drafter when ANTHROPIC_API_KEY is
   * present — MetaMender never hard-depends on an LLM for a fix to work.
   */
  draft?: (finding: Finding, fields: SchemaField[]) => string | Promise<string>;
}

/** Pull the data platform (snowflake / postgres / s3 …) out of a dataset urn. */
export function platformOf(urn: string): string | undefined {
  return urn.match(/dataPlatform:([^,]+),/)?.[1];
}

/** Deterministic, no-LLM description draft from schema + platform + name. */
export function templateDescription(finding: Finding, fields: SchemaField[]): string {
  const platform = platformOf(finding.urn);
  const names = fields.map((f) => f.fieldPath).filter(Boolean);
  const shown = names.slice(0, 8);
  const more = names.length > shown.length ? `, +${names.length - shown.length} more` : "";
  const platformPhrase = platform ? ` ${platform}` : "";
  const fieldPhrase = names.length
    ? ` It has ${names.length} field(s): ${shown.join(", ")}${more}.`
    : "";
  return (
    `${DESCRIPTION_PREFIX} "${finding.entityName}" is a${platformPhrase} dataset.` +
    `${fieldPhrase} Review and refine this auto-generated description.`
  );
}

/**
 * Map a Finding to its DataHub mutation. Reads the schema (for descriptions)
 * through the same client, so a caller only needs the finding + client.
 */
export async function planFix(
  client: DataHubClient,
  finding: Finding,
  opts: FixOptions = {},
): Promise<PlannedMutation> {
  switch (finding.kind) {
    case "missing-owner":
      return {
        tool: "add_owners",
        args: {
          owner_urns: [opts.ownerUrn ?? DEFAULT_OWNER_URN],
          entity_urns: [finding.urn],
          ownership_type: opts.ownershipType ?? DEFAULT_OWNERSHIP_TYPE,
        },
      };

    case "missing-description": {
      const fields = await getSchemaFields(client, finding.urn);
      const drafter = opts.draft ?? templateDescription;
      const description = await drafter(finding, fields);
      return {
        tool: "update_description",
        args: {
          entity_urn: finding.urn,
          operation: "replace",
          description,
        },
      };
    }

    case "pii-untagged": {
      if (!finding.column) {
        throw new Error(
          `pii-untagged finding on ${finding.urn} has no column — cannot tag a phantom field.`,
        );
      }
      return {
        tool: "add_terms",
        args: {
          term_urns: [opts.piiTermUrn ?? PII_TERM_URN],
          entity_urns: [finding.urn],
          column_paths: [finding.column],
        },
      };
    }

    case "orphan":
      throw new Error(
        "No automated fix for orphan findings — they need a human lineage/deprecation decision.",
      );
  }
}

/** A planned mutation plus the raw DataHub ack from executing it. */
export interface AppliedFix {
  mutation: PlannedMutation;
  result: unknown;
}

/** Plan the fix for a finding and execute it through the client. */
export async function applyFix(
  client: DataHubClient,
  finding: Finding,
  opts: FixOptions = {},
): Promise<AppliedFix> {
  const mutation = await planFix(client, finding, opts);
  const result = await client.callTool(mutation.tool, mutation.args);
  return { mutation, result };
}
