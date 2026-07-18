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
 * With ANTHROPIC_API_KEY, Claude Agent SDK drives the scan/apply-fix tools. Without
 * it, a deterministic scripted loop drives the same tools. Confirmations are read
 * from stdin (a closed stdin can never authorize a fix — EOF answers "quit"). The
 * confirmation gate is the SAME code path either way (agent/src/harness.ts).
 */
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  StdioDataHubClient,
  configFromEnv,
  loadProjectEnv,
} from "../../steward/src/datahubClient.js";
import type { DataHubClient } from "../../steward/src/datahubClient.js";
import type { Finding, FindingKind } from "../../steward/src/types.js";
import { scan as scanCatalog } from "../../steward/src/scan.js";
import { applyFix, type FixOptions } from "../../steward/src/fixes.js";
import {
  createSessionTools,
  GOVERNANCE_STEWARD_SYSTEM_PROMPT,
  runScanAndFix,
  type HarnessIO,
  type ScanAndFixSummary,
} from "./harness.js";
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
 * Optional LLM description drafter. Any SDK or model failure falls back to the
 * deterministic template, so a description fix never depends on an LLM response.
 */
function buildFixOptions(): FixOptions {
  const options: FixOptions = {
    ...(process.env.METAMENDER_OWNER_URN
      ? { ownerUrn: process.env.METAMENDER_OWNER_URN }
      : {}),
    ...(process.env.METAMENDER_PII_TERM_URN
      ? { piiTermUrn: process.env.METAMENDER_PII_TERM_URN }
      : {}),
  };
  if (!process.env.ANTHROPIC_API_KEY) return options;
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
  return { ...options, draft };
}

/** Claude Agent SDK mode, reusing the same code-enforced gate as scripted mode. */
async function runLlmMode(
  client: DataHubClient,
  args: ParsedArgs,
  io: HarnessIO,
): Promise<number> {
  const [{ query, tool, createSdkMcpServer }, { z }] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("zod"),
  ]);
  const fixOpts = buildFixOptions();
  const scan = async () => filterFindings(await scanCatalog(client), args.targets);
  const applyFn = (f: Finding) => applyFix(client, f, fixOpts);
  const sessionTools = createSessionTools({ scan, applyFix: applyFn, io });
  let lastFindings: Finding[] = [];
  const summary: ScanAndFixSummary = {
    findings: [],
    fixed: [],
    skipped: [],
    failed: [],
    quit: false,
  };

  const steward = createSdkMcpServer({
    name: "metamender",
    version: "0.1.0",
    tools: [
      tool(
        "scan_governance_gaps",
        "Scan the configured DataHub scope and return severity-ranked governance findings.",
        {},
        async () => {
          lastFindings = await sessionTools.scan();
          summary.findings = lastFindings;
          return { content: [{ type: "text", text: JSON.stringify(lastFindings, null, 2) }] };
        },
      ),
      tool(
        "apply_governance_fix",
        "Apply ONE finding from the last scan. The terminal asks for a fresh explicit confirmation and rejects invented targets.",
        {
          urn: z.string().describe("Entity URN exactly as returned by scan_governance_gaps"),
          kind: z.enum(KINDS).describe("Finding kind exactly as returned by the scan"),
          column: z.string().optional().describe("Column path for pii-untagged findings"),
        },
        async ({ urn, kind, column }) => {
          const finding = lastFindings.find(
            (f) =>
              f.urn === urn &&
              f.kind === kind &&
              (f.column ?? undefined) === (column ?? undefined),
          );
          const outcome = await sessionTools.applyFixByRef(urn, kind, column);
          if (finding) {
            if (outcome.status === "fixed") {
              summary.fixed.push({ finding, result: outcome.result });
            } else if (outcome.status === "declined") {
              summary.skipped.push(finding);
            } else if (outcome.status === "failed") {
              summary.failed.push({ finding, error: outcome.error });
            } else if (outcome.status === "quit") {
              summary.quit = true;
            }
          }
          return { content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }] };
        },
      ),
    ],
  });

  const targetText = args.targets.length
    ? ` Restrict the scan to these configured targets: ${args.targets
        .map((t) => `${t.kind}${t.column ? `/${t.column}` : ""}@${t.urnSubstr}`)
        .join(", ")}.`
    : "";
  const result = query({
    prompt:
      "Scan this DataHub catalog for governance gaps, explain the findings, and help me fix only the items I explicitly confirm." +
      targetText,
    options: {
      systemPrompt: GOVERNANCE_STEWARD_SYSTEM_PROMPT,
      mcpServers: { metamender: steward },
      allowedTools: [
        "mcp__metamender__scan_governance_gaps",
        "mcp__metamender__apply_governance_fix",
      ],
      maxTurns: 30,
    },
  });

  for await (const message of result) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") io.write(block.text);
      }
    } else if (message.type === "result") {
      io.write("");
      io.write(
        message.subtype === "success"
          ? "Session complete."
          : `Session ended: ${message.subtype}`,
      );
    }
  }

  if (summary.findings.length === 0) {
    io.write("Claude did not complete a catalog scan; no audit report was written.");
    return 1;
  }
  return verifyAndWriteAudit(client, args, io, summary);
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
  const fixOpts = buildFixOptions();
  const scan = async () => filterFindings(await scanCatalog(client), args.targets);
  const applyFn = (f: Finding) => applyFix(client, f, fixOpts);

  const summary = await runScanAndFix({ scan, applyFix: applyFn, io });

  return verifyAndWriteAudit(client, args, io, summary);
}

async function verifyAndWriteAudit(
  client: DataHubClient,
  args: ParsedArgs,
  io: HarnessIO,
  summary: ScanAndFixSummary,
): Promise<number> {
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
    target:
      process.env.METAMENDER_SCOPE_LABEL ??
      `DataHub at ${process.env.DATAHUB_GMS_URL ?? "http://localhost:8080"}`,
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
  loadProjectEnv();
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
    if (process.env.ANTHROPIC_API_KEY) {
      io.write("ANTHROPIC_API_KEY found — Claude Agent SDK is driving this session.");
      return await runLlmMode(client, args, io);
    }
    io.write("ANTHROPIC_API_KEY not set — running deterministic scripted mode.");
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
