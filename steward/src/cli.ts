#!/usr/bin/env -S npx tsx
import type { DataHubClient } from "./datahubClient.js";
import { StdioDataHubClient, configFromEnv } from "./datahubClient.js";
import type { Finding, FindingKind } from "./types.js";
import { scan } from "./scan.js";

export interface CliDeps {
  client: DataHubClient;
  out: (line: string) => void;
}

const KIND_LABEL: Record<FindingKind, string> = {
  "pii-untagged": "PII untagged",
  "missing-owner": "Missing owner",
  "missing-description": "Missing description",
  orphan: "Orphan",
};

/**
 * Parse argv and run. Injectable deps (client + output sink) keep this unit-testable
 * without spawning the real MCP server. Returns a process exit code.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  const json = rest.includes("--json");
  const dryRun = rest.includes("--dry-run");

  if (command !== "scan") {
    deps.out(`Unknown command: ${command ?? "(none)"}`);
    deps.out("Usage: steward scan [--json] [--dry-run]");
    return 1;
  }

  const findings = await scan(deps.client);

  if (json) {
    deps.out(JSON.stringify(findings, null, 2));
    return 0;
  }

  renderHuman(findings, deps.out, dryRun);
  return 0;
}

function renderHuman(findings: Finding[], out: (s: string) => void, dryRun: boolean): void {
  const counts = countByKind(findings);
  out("MetaMender governance scan");
  out("==========================");
  out(
    `Found ${findings.length} governance gaps: ` +
      `${counts["pii-untagged"] ?? 0} PII untagged, ` +
      `${counts["missing-owner"] ?? 0} missing owner, ` +
      `${counts["missing-description"] ?? 0} missing description.`,
  );
  out("");

  for (const f of findings) {
    const col = f.column ? ` [${f.column}]` : "";
    out(`[sev ${f.severity}] ${KIND_LABEL[f.kind]} — ${f.entityName}${col}`);
    out(`  ${f.urn}`);
    out(`  why: ${f.evidence}`);
    out(`  fix: ${f.proposedFix}`);
    out("");
  }

  out(
    dryRun
      ? "(dry-run: read-only scan, no writes performed — this phase never mutates.)"
      : "(read-only scan — write-back requires the agent's per-item confirmation.)",
  );
}

function countByKind(findings: Finding[]): Partial<Record<FindingKind, number>> {
  const c: Partial<Record<FindingKind, number>> = {};
  for (const f of findings) c[f.kind] = (c[f.kind] ?? 0) + 1;
  return c;
}

// Entrypoint: only runs when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const client = new StdioDataHubClient(configFromEnv());
  runCli(process.argv.slice(2), { client, out: (s) => console.log(s) })
    .then(async (code) => {
      await client.close();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err);
      await client.close();
      process.exit(1);
    });
}
