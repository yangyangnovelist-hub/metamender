/**
 * Audit report (Task 2.4).
 *
 * Every MetaMender run emits an auditable record — a Markdown narrative for
 * humans and a JSON object for machines — of exactly what was found, what the
 * human approved, what was written back to DataHub, and the before/after
 * verification. This is the accountability trail for a write-capable agent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanAndFixSummary } from "../../agent/src/harness.js";

/** One before/after check produced by re-reading DataHub after a fix. */
export interface Verification {
  urn: string;
  kind: string;
  column?: string;
  before: string;
  after: string;
  ok: boolean;
}

export interface AuditInput {
  runAt: string;
  target: string;
  summary: ScanAndFixSummary;
  verifications?: Verification[];
}

/** The serializable audit object written to examples/*.json. */
export interface AuditJson {
  runAt: string;
  target: string;
  counts: { found: number; fixed: number; skipped: number; failed: number };
  findings: Array<{
    urn: string;
    kind: string;
    column?: string;
    severity: number;
    entityName: string;
    evidence: string;
    proposedFix: string;
  }>;
  fixed: Array<{
    urn: string;
    kind: string;
    column?: string;
    entityName: string;
    mutation: { tool: string; args: Record<string, unknown> };
    ack: unknown;
  }>;
  skipped: Array<{ urn: string; kind: string; column?: string; entityName: string }>;
  failed: Array<{ urn: string; kind: string; entityName: string; error: string }>;
  verifications: Verification[];
}

export function buildAuditJson(input: AuditInput): AuditJson {
  const { summary } = input;
  return {
    runAt: input.runAt,
    target: input.target,
    counts: {
      found: summary.findings.length,
      fixed: summary.fixed.length,
      skipped: summary.skipped.length,
      failed: summary.failed.length,
    },
    findings: summary.findings.map((f) => ({
      urn: f.urn,
      kind: f.kind,
      ...(f.column ? { column: f.column } : {}),
      severity: f.severity,
      entityName: f.entityName,
      evidence: f.evidence,
      proposedFix: f.proposedFix,
    })),
    fixed: summary.fixed.map((o) => ({
      urn: o.finding.urn,
      kind: o.finding.kind,
      ...(o.finding.column ? { column: o.finding.column } : {}),
      entityName: o.finding.entityName,
      mutation: o.result.mutation,
      ack: o.result.result,
    })),
    skipped: summary.skipped.map((f) => ({
      urn: f.urn,
      kind: f.kind,
      ...(f.column ? { column: f.column } : {}),
      entityName: f.entityName,
    })),
    failed: summary.failed.map((x) => ({
      urn: x.finding.urn,
      kind: x.finding.kind,
      entityName: x.finding.entityName,
      error: x.error,
    })),
    verifications: input.verifications ?? [],
  };
}

export function renderMarkdown(input: AuditInput): string {
  const j = buildAuditJson(input);
  const L: string[] = [];
  L.push(`# MetaMender audit report`);
  L.push("");
  L.push(`- **Run at:** ${j.runAt}`);
  L.push(`- **Target:** ${j.target}`);
  L.push(
    `- **Result:** ${j.counts.found} governance gap(s) found — ` +
      `Fixed: ${j.counts.fixed}, Skipped: ${j.counts.skipped}, Failed: ${j.counts.failed}` +
      (input.summary.quit ? " (stopped early at user request)" : ""),
  );
  L.push("");

  L.push(`## Gaps found`);
  L.push("");
  L.push(`| # | Severity | Kind | Entity | Column | Why |`);
  L.push(`|---|---|---|---|---|---|`);
  j.findings.forEach((f, i) => {
    L.push(
      `| ${i + 1} | ${f.severity} | ${f.kind} | ${f.entityName} | ${f.column ?? ""} | ${f.evidence} |`,
    );
  });
  L.push("");

  L.push(`## Written back (human-approved)`);
  L.push("");
  if (j.fixed.length === 0) {
    L.push(`_None approved this run._`);
  } else {
    for (const o of j.fixed) {
      L.push(`### ${o.entityName} — ${o.kind}${o.column ? ` [${o.column}]` : ""}`);
      L.push(`- **urn:** \`${o.urn}\``);
      L.push(`- **mutation:** \`${o.mutation.tool}\``);
      L.push(`- **args:** \`${JSON.stringify(o.mutation.args)}\``);
      L.push(`- **DataHub ack:** \`${JSON.stringify(o.ack)}\``);
      L.push("");
    }
  }

  L.push(`## Verification (before → after, re-read from DataHub)`);
  L.push("");
  if (j.verifications.length === 0) {
    L.push(`_No re-read verification captured this run._`);
  } else {
    L.push(`| Entity | Kind | Column | Before | After | Status |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const v of j.verifications) {
      const short = v.urn.split(",").slice(-2)[0] ?? v.urn;
      L.push(
        `| ${short} | ${v.kind} | ${v.column ?? ""} | ${v.before} | ${v.after} | ${v.ok ? "VERIFIED" : "MISMATCH"} |`,
      );
    }
  }
  L.push("");

  if (j.skipped.length > 0) {
    L.push(`## Skipped (declined by human)`);
    L.push("");
    for (const s of j.skipped) {
      L.push(`- ${s.entityName} — ${s.kind}${s.column ? ` [${s.column}]` : ""}`);
    }
    L.push("");
  }

  if (j.failed.length > 0) {
    L.push(`## Failed`);
    L.push("");
    for (const f of j.failed) {
      L.push(`- ${f.entityName} — ${f.kind}: ${f.error}`);
    }
    L.push("");
  }

  return L.join("\n");
}

/** Write the md + json pair into `dir`, returning both paths. */
export function writeAudit(
  dir: string,
  input: AuditInput,
  basename = `audit-${input.runAt.replace(/[:.]/g, "-")}`,
): { mdPath: string; jsonPath: string } {
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, `${basename}.md`);
  const jsonPath = join(dir, `${basename}.json`);
  writeFileSync(mdPath, renderMarkdown(input), "utf8");
  writeFileSync(jsonPath, JSON.stringify(buildAuditJson(input), null, 2), "utf8");
  return { mdPath, jsonPath };
}
