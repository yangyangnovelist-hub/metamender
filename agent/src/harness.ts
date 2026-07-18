/**
 * MetaMender agent harness (Task 2.2).
 *
 * A read-only scan tool and a state-changing apply-fix tool behind ONE
 * code-enforced safety gate:
 *
 *   - every fix must show the entity urn + finding kind + the proposed fix and
 *     receive an explicit, fresh "yes" before any mutation is submitted;
 *   - one confirmation authorizes exactly one fix — never batched.
 *
 * The gate lives in `createGatedFix`, NOT in a prompt. Whichever brain drives
 * the tools — Claude via the Agent SDK, or the scripted orchestrator used when
 * no ANTHROPIC_API_KEY is available — it is mechanically impossible to write
 * back to DataHub without a fresh per-finding confirmation.
 *
 * Ported from ApprovalSentinel (agent/src/harness.ts), disclosed as a
 * pre-existing pattern. All DataHub-facing wiring is new.
 */
import type { Finding, FindingKind } from "../../steward/src/types.js";
import type { PlannedMutation } from "../../steward/src/fixes.js";

export interface HarnessIO {
  write(line: string): void;
  /** Prompt the user and resolve with their raw answer. */
  ask(question: string): Promise<string>;
}

/** The result of executing one fix: the mutation issued + DataHub's ack. */
export interface FixResult {
  mutation: PlannedMutation;
  result: unknown;
}

export type ScanTool = () => Promise<Finding[]>;
export type ApplyFixTool = (finding: Finding) => Promise<FixResult>;

export type GateOutcome =
  | { status: "fixed"; result: FixResult }
  | { status: "failed"; error: string }
  | { status: "declined" }
  | { status: "quit" };

/** Only an explicit, unambiguous yes opens the gate. "ok", "sure", "yes please" do not. */
export function isExplicitYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "yes" || a === "y";
}

export function isQuit(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "quit" || a === "q" || a === "exit";
}

/**
 * Wrap the raw apply-fix tool in the confirmation gate. Returns a function that
 * (1) prints urn + kind + proposedFix, (2) asks for an explicit yes,
 * (3) executes exactly one fix on yes, and reports the outcome.
 *
 * Only the mutation itself is caught (reported as `failed`); an IO/confirmation
 * error propagates and aborts the whole run — it must never be misreported as a
 * failed fix.
 */
export function createGatedFix(
  applyFix: ApplyFixTool,
  io: HarnessIO,
): (finding: Finding) => Promise<GateOutcome> {
  return async (finding: Finding): Promise<GateOutcome> => {
    const col = finding.column ? ` [column: ${finding.column}]` : "";
    io.write("");
    io.write("About to apply ONE governance fix:");
    io.write(`  entity:  ${finding.entityName}${col}`);
    io.write(`  urn:     ${finding.urn}`);
    io.write(`  kind:    ${finding.kind}`);
    io.write(`  fix:     ${finding.proposedFix}`);
    const answer = await io.ask(
      `Apply this ${finding.kind} fix to ${finding.entityName}? Type "yes" to write it back, "no" to skip, "quit" to stop: `,
    );
    if (isQuit(answer)) return { status: "quit" };
    if (!isExplicitYes(answer)) {
      io.write('Skipped (no explicit "yes").');
      return { status: "declined" };
    }
    try {
      const result = await applyFix(finding);
      return { status: "fixed", result };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export interface FixOutcome {
  finding: Finding;
  result: FixResult;
}

export interface ScanAndFixSummary {
  findings: Finding[];
  fixed: FixOutcome[];
  skipped: Finding[];
  failed: Array<{ finding: Finding; error: string }>;
  quit: boolean;
}

const KIND_LABEL: Record<FindingKind, string> = {
  "pii-untagged": "PII untagged",
  "missing-owner": "Missing owner",
  "missing-description": "Missing description",
  orphan: "Orphan",
};

function presentFindings(findings: Finding[], io: HarnessIO): void {
  io.write(`Found ${findings.length} governance gap(s), highest severity first:`);
  findings.forEach((f, i) => {
    const col = f.column ? ` [${f.column}]` : "";
    io.write("");
    io.write(`${i + 1}. [sev ${f.severity}] ${KIND_LABEL[f.kind]} — ${f.entityName}${col}`);
    io.write(`   ${f.urn}`);
    io.write(`   why: ${f.evidence}`);
    io.write(`   fix: ${f.proposedFix}`);
  });
}

/**
 * Scripted orchestration: scan → present findings → per-finding confirmation
 * gate → apply on explicit yes. Used directly when no LLM is available, and
 * unit-tested with mocked tools to pin the gate semantics.
 */
export async function runScanAndFix(deps: {
  scan: ScanTool;
  applyFix: ApplyFixTool;
  io: HarnessIO;
}): Promise<ScanAndFixSummary> {
  const { io } = deps;
  io.write("Scanning DataHub for governance gaps…");
  const findings = await deps.scan();

  const summary: ScanAndFixSummary = {
    findings,
    fixed: [],
    skipped: [],
    failed: [],
    quit: false,
  };
  if (findings.length === 0) {
    io.write("Clean: no governance gaps found. Nothing to fix.");
    return summary;
  }

  presentFindings(findings, io);
  const gatedFix = createGatedFix(deps.applyFix, io);

  for (const finding of findings) {
    if (summary.quit) break;
    const outcome = await gatedFix(finding);
    if (outcome.status === "quit") {
      summary.quit = true;
      io.write("Stopping at your request. Remaining gaps were NOT touched.");
    } else if (outcome.status === "declined") {
      summary.skipped.push(finding);
    } else if (outcome.status === "failed") {
      io.write(`FAILED to fix ${finding.entityName} (${finding.kind}): ${outcome.error}`);
      summary.failed.push({ finding, error: outcome.error });
    } else {
      summary.fixed.push({ finding, result: outcome.result });
      io.write(`Fixed ${finding.entityName} (${finding.kind}) via ${outcome.result.mutation.tool}.`);
    }
  }

  io.write("");
  io.write(
    `Done. Fixed ${summary.fixed.length}, skipped ${summary.skipped.length}, failed ${summary.failed.length}` +
      (summary.quit ? " (stopped early at user request)" : "") +
      ".",
  );
  return summary;
}

export type ApplyFixByRefOutcome = GateOutcome | { status: "rejected"; error: string };

export interface SessionTools {
  scan(): Promise<Finding[]>;
  /**
   * Apply a fix by (urn, kind, column?) — only findings surfaced by the LAST
   * scan are eligible, so the model cannot invent a target.
   */
  applyFixByRef(urn: string, kind: string, column?: string): Promise<ApplyFixByRefOutcome>;
}

/**
 * Tool pair for the LLM-driven mode. Two safety properties on top of the
 * confirmation gate:
 *   - a fix is only possible for a (urn, kind, column) present in the most
 *     recent scan — the model cannot fabricate a target;
 *   - the terminal confirmation gate still runs for every fix.
 */
export function createSessionTools(deps: {
  scan: ScanTool;
  applyFix: ApplyFixTool;
  io: HarnessIO;
}): SessionTools {
  let lastFindings: Finding[] = [];
  const gate = createGatedFix(deps.applyFix, deps.io);

  return {
    scan: async () => {
      lastFindings = await deps.scan();
      return lastFindings;
    },
    applyFixByRef: async (urn, kind, column) => {
      const finding = lastFindings.find(
        (f) =>
          f.urn === urn &&
          f.kind === kind &&
          (f.column ?? undefined) === (column ?? undefined),
      );
      if (!finding) {
        return {
          status: "rejected",
          error: `No ${kind} finding for ${urn}${column ? ` column ${column}` : ""} in the last scan — run scan first and use an exact (urn, kind, column) from its output.`,
        };
      }
      return gate(finding);
    },
  };
}

/** System prompt for the LLM-driven mode (Claude Agent SDK). */
export const GOVERNANCE_STEWARD_SYSTEM_PROMPT = `You are MetaMender, a meticulous data-governance steward for a DataHub catalog.

Your job:
1. Use the scan tool to list the catalog's governance gaps (missing owners,
   missing descriptions, untagged PII columns), highest severity first.
2. For each gap, explain to the user in plain English what is wrong, why it
   matters (compliance/discoverability/blast-radius), and what the proposed
   fix would write back.
3. For a gap the user may want fixed, call apply_governance_fix for that ONE
   finding using its exact (urn, kind, column) from the scan. The tool shows the
   exact entity and proposed change in the terminal and obtains a fresh explicit
   "yes". One confirmation authorizes exactly one fix — never batch.
4. Report the mutation that was written after each fix. Never claim a fix
   succeeded without the tool's confirmation.

Note: apply_governance_fix itself asks the user for terminal confirmation and
will refuse without an explicit yes. It also refuses any target not in the last
scan. Do not try to work around either control. Be concise, factual, and never
pressure the user.`;
