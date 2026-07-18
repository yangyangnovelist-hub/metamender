#!/usr/bin/env -S npx tsx
/**
 * MetaMender agent CLI (Task 2.3).
 *
 *   npx tsx agent/src/cli.ts run [--target <kind[/column]@urnSubstr>]... [--report-dir DIR]
 *
 * One gated round: scan DataHub for governance gaps → present each → require an
 * explicit per-finding "yes" → write the fix back → re-read to verify →
 * emit an audit report (md + json) into the report dir.
 *
 * Scripted mode is the default: confirmations are read from stdin (a closed
 * stdin can never authorize a fix — EOF answers "quit"). If ANTHROPIC_API_KEY is
 * present, an LLM-backed description drafter is used for missing-description
 * fixes; otherwise the deterministic template runs. The confirmation gate is the
 * SAME code path either way (agent/src/harness.ts) — never a prompt.
 */
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioDataHubClient, configFromEnv } from "../../steward/src/datahubClient.js";
import type { DataHubClient } from "../../steward/src/datahubClient.js";
import type { Finding, FindingKind } from "../../steward/src/types.js";
import { scan as scanCatalog } from "../../steward/src/scan.js";
import { applyFix, type FixOptions } from "../../steward/src/fixes.js";
import { runScanAndFix, type HarnessIO } from "./harness.js";
import { verifyFix } from "./verify.js";
import { writeAudit, type Verification } from "../../report/src/audit.js";

const here = dirname(fileURLToPath(import.meta.url));

interface Target {
  kind: FindingKind;
  column?: string;
  urnSubstr: string;
}

interface ParsedArgs {
  targets: Target[];
  reportDir: string;
}

const KINDS: FindingKind[] = ["pii-untagged", "missing-owner", "missing-description", "orphan"];

const USAGE = `Usage: npx tsx agent/src/cli.ts run [--target <kind[/column]@urnSubstr>]... [--report-dir DIR]

  --target   restrict the round to findings matching kind (+optional /column)
             whose urn contains urnSubstr. Repeatable. Omit to consider all gaps.
             e.g. --target missing-owner@warehouses
                  --target pii-untagged/credit_limit@customers
  --report-dir  where to write the audit md+json (default: examples/)`;

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "run") throw new Error(USAGE);
  const targets: Target[] = [];
  let reportDir = resolve(here, "../../examples");
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--target") {
      const value = rest[++i];
      if (!value) throw new Error(`--target expects a value\n\n${USAGE}`);
      targets.push(parseTarget(value));
    } else if (flag === "--report-dir") {
      const value = rest[++i];
      if (!value) throw new Error(`--report-dir expects a path\n\n${USAGE}`);
      reportDir = resolve(process.cwd(), value);
    } else {
      throw new Error(`Unknown flag: ${flag}\n\n${USAGE}`);
    }
  }
  return { targets, reportDir };
}

function parseTarget(value: string): Target {
  const [kindPart, urnSubstr] = value.split("@");
  if (!urnSubstr) throw new Error(`--target must be kind[/column]@urnSubstr, got "${value}"`);
  const [kind, column] = kindPart.split("/");
  if (!KINDS.includes(kind as FindingKind)) {
    throw new Error(`Unknown kind "${kind}" — use one of ${KINDS.join(", ")}`);
  }
  return { kind: kind as FindingKind, ...(column ? { column } : {}), urnSubstr };
}

function matchesTarget(f: Finding, t: Target): boolean {
  if (f.kind !== t.kind) return false;
  if (t.column && f.column !== t.column) return false;
  return f.urn.includes(t.urnSubstr);
}

function filterFindings(findings: Finding[], targets: Target[]): Finding[] {
  if (targets.length === 0) return findings;
  return findings.filter((f) => targets.some((t) => matchesTarget(f, t)));
}

/**
 * Optional LLM description drafter. Uses the Anthropic SDK via a runtime import
 * so MetaMender never hard-depends on it (dynamic specifier keeps tsc happy
 * without the package installed). Any failure falls back to the template.
 */
function buildDraftOption(): FixOptions {
  if (!process.env.ANTHROPIC_API_KEY) return {};
  const draft: FixOptions["draft"] = async (finding, fields) => {
    try {
      const specifier = "@anthropic-ai/sdk";
      const mod = await import(specifier);
      const Anthropic = mod.default ?? mod.Anthropic;
      const client = new Anthropic();
      const fieldList = fields.map((f) => f.fieldPath).join(", ");
      const msg = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content:
              `Write a one-sentence data catalog description (no preamble) for the dataset ` +
              `"${finding.entityName}" (urn ${finding.urn}). Its columns: ${fieldList}. ` +
              `Be factual and concise.`,
          },
        ],
      });
      const text = msg.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join(" ")
        .trim();
      return `Drafted by MetaMender — ${text}`;
    } catch {
      const { templateDescription } = await import("../../steward/src/fixes.js");
      return templateDescription(finding, fields);
    }
  };
  return { draft };
}

/**
 * Terminal IO that also works with piped stdin: lines arriving before a question
 * is pending are buffered; EOF answers every later question with "quit" — a
 * closed stdin can never authorize a fix.
 */
function makeTerminalIO(): { io: HarnessIO; close: () => void } {
  const rl = createInterface({ input: process.stdin });
  const buffered: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!("quit");
  });

  const io: HarnessIO = {
    write: (line) => console.log(line),
    ask: (question) => {
      process.stdout.write(question);
      const ready = buffered.shift();
      if (ready !== undefined) {
        process.stdout.write(`${ready}\n`);
        return Promise.resolve(ready);
      }
      if (closed) {
        process.stdout.write("quit (stdin closed)\n");
        return Promise.resolve("quit");
      }
      return new Promise((r) => waiters.push(r));
    },
  };
  return { io, close: () => rl.close() };
}

export async function runRound(
  client: DataHubClient,
  args: ParsedArgs,
  io: HarnessIO,
): Promise<number> {
  const fixOpts = buildDraftOption();
  const scan = async () => filterFindings(await scanCatalog(client), args.targets);
  const applyFn = (f: Finding) => applyFix(client, f, fixOpts);

  const summary = await runScanAndFix({ scan, applyFix: applyFn, io });

  // Independent re-read verification for everything we wrote back.
  const verifications: Verification[] = [];
  for (const { finding } of summary.fixed) {
    io.write(`Verifying ${finding.entityName} (${finding.kind}) by re-reading DataHub…`);
    const v = await verifyFix(client, finding);
    verifications.push(v);
    io.write(`  ${v.ok ? "VERIFIED" : "MISMATCH"}: ${v.before} → ${v.after}`);
  }

  const { mdPath, jsonPath } = writeAudit(args.reportDir, {
    runAt: new Date().toISOString(),
    target: "showcase-ecommerce (local DataHub quickstart)",
    summary,
    verifications,
  });
  io.write("");
  io.write(`Audit report written:`);
  io.write(`  ${mdPath}`);
  io.write(`  ${jsonPath}`);

  const allVerified = verifications.every((v) => v.ok);
  return summary.failed.length > 0 || !allVerified ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Mutation MUST be enabled — this round writes back.
  const client = new StdioDataHubClient({ ...configFromEnv(), mutationEnabled: true });
  const { io, close } = makeTerminalIO();
  try {
    return await runRound(client, args, io);
  } catch (error) {
    console.error(`run failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    close();
    await client.close();
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
