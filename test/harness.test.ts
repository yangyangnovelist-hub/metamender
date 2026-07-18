/**
 * Unit tests for the agent harness confirmation gate (Task 2.2).
 *
 * Ported from ApprovalSentinel (disclosed pre-existing pattern). The gate is in
 * CODE, not a prompt. What is pinned down here:
 *   - no fix ever runs without an explicit, fresh, per-finding "yes";
 *   - the prompt shown before each fix names the urn AND the kind AND the fix;
 *   - one confirmation authorizes exactly one fix — never batched;
 *   - "quit" stops immediately, leaving later findings untouched;
 *   - a failed mutation surfaces its error and never counts as fixed;
 *   - the LLM-facing tool set refuses any target not in the last scan.
 */
import { describe, expect, it, vi } from "vitest";
import type { Finding } from "../steward/src/types.js";
import {
  createSessionTools,
  isExplicitYes,
  isQuit,
  runScanAndFix,
  type ApplyFixTool,
  type FixResult,
  type HarnessIO,
  type ScanTool,
} from "../agent/src/harness.js";

const ADDR =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.addresses,PROD)";
const CUST =
  "urn:li:dataset:(urn:li:dataPlatform:s3,b2fd91.demo-data-bucket/order_entry/customers,PROD)";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    urn: ADDR,
    kind: "missing-owner",
    severity: 60,
    entityName: "ADDRESSES",
    evidence: "Dataset has no owner assigned.",
    proposedFix: "Assign a technical owner via add_owners.",
    ...overrides,
  };
}

function fixResult(overrides: Partial<FixResult> = {}): FixResult {
  return {
    mutation: { tool: "add_owners", args: { entity_urns: [ADDR] } },
    result: { success: true, message: "Added owner" },
    ...overrides,
  };
}

/** Scripted IO: replays canned answers, records every line + question. */
function makeIO(answers: string[]): HarnessIO & { lines: string[]; questions: string[] } {
  const lines: string[] = [];
  const questions: string[] = [];
  return {
    lines,
    questions,
    write: (line) => lines.push(line),
    ask: async (question) => {
      questions.push(question);
      const next = answers.shift();
      if (next === undefined) throw new Error("IO asked more questions than scripted answers");
      return next;
    },
  };
}

describe("isExplicitYes / isQuit", () => {
  it("accepts only an unambiguous yes", () => {
    for (const yes of ["yes", "y", " YES ", "Y"]) expect(isExplicitYes(yes)).toBe(true);
    for (const no of ["", "no", "ok", "sure", "yes please", "yeah", "apply it"]) {
      expect(isExplicitYes(no)).toBe(false);
    }
  });
  it("recognizes quit variants", () => {
    for (const q of ["quit", "q", "exit", " QUIT "]) expect(isQuit(q)).toBe(true);
    expect(isQuit("yes")).toBe(false);
  });
});

describe("runScanAndFix — confirmation gate", () => {
  it("reports clean and never asks or fixes when there are no findings", async () => {
    const scan: ScanTool = vi.fn(async () => []);
    const applyFix = vi.fn() as unknown as ApplyFixTool;
    const io = makeIO([]);

    const summary = await runScanAndFix({ scan, applyFix, io });

    expect(summary.findings).toEqual([]);
    expect(io.questions).toHaveLength(0);
    expect(applyFix).not.toHaveBeenCalled();
  });

  it("shows urn, kind and proposedFix before asking, and asks BEFORE fixing", async () => {
    const scan: ScanTool = async () => [finding()];
    const order: string[] = [];
    const applyFix: ApplyFixTool = vi.fn(async () => {
      order.push("fix");
      return fixResult();
    });
    const io = makeIO(["yes"]);
    const originalAsk = io.ask;
    io.ask = (q) => {
      order.push("ask");
      return originalAsk(q);
    };

    await runScanAndFix({ scan, applyFix, io });

    expect(order).toEqual(["ask", "fix"]);
    const shown = io.lines.join("\n");
    expect(shown).toContain(ADDR);
    expect(shown).toContain("missing-owner");
    expect(shown).toContain("Assign a technical owner");
  });

  it("fixes exactly the confirmed finding", async () => {
    const scan: ScanTool = async () => [finding()];
    const applyFix = vi.fn(async () => fixResult()) as ApplyFixTool;
    const io = makeIO(["yes"]);

    const summary = await runScanAndFix({ scan, applyFix, io });

    expect(applyFix).toHaveBeenCalledTimes(1);
    expect(applyFix).toHaveBeenCalledWith(finding());
    expect(summary.fixed).toHaveLength(1);
  });

  it("treats anything but an explicit yes as a skip — no mutation at all", async () => {
    const scan: ScanTool = async () => [
      finding(),
      finding({ urn: CUST, entityName: "customers", kind: "missing-description" }),
    ];
    const applyFix = vi.fn(async () => fixResult()) as ApplyFixTool;
    const io = makeIO(["sure", "ok"]);

    const summary = await runScanAndFix({ scan, applyFix, io });

    expect(applyFix).not.toHaveBeenCalled();
    expect(summary.fixed).toHaveLength(0);
    expect(summary.skipped).toHaveLength(2);
  });

  it("requires one confirmation per fix — never batches", async () => {
    const scan: ScanTool = async () => [
      finding(),
      finding({ urn: CUST, entityName: "customers", kind: "pii-untagged", column: "credit_limit" }),
    ];
    const order: string[] = [];
    const applyFix: ApplyFixTool = vi.fn(async (f) => {
      order.push(`fix:${f.urn}`);
      return fixResult();
    });
    const io = makeIO(["yes", "yes"]);
    const originalAsk = io.ask;
    io.ask = (q) => {
      order.push("ask");
      return originalAsk(q);
    };

    const summary = await runScanAndFix({ scan, applyFix, io });

    expect(summary.fixed).toHaveLength(2);
    expect(order).toEqual(["ask", `fix:${ADDR}`, "ask", `fix:${CUST}`]);
  });

  it("stops immediately on quit and leaves the rest untouched", async () => {
    const scan: ScanTool = async () => [
      finding(),
      finding({ urn: CUST, entityName: "customers" }),
    ];
    const applyFix = vi.fn(async () => fixResult()) as ApplyFixTool;
    const io = makeIO(["quit"]);

    const summary = await runScanAndFix({ scan, applyFix, io });

    expect(applyFix).not.toHaveBeenCalled();
    expect(io.questions).toHaveLength(1);
    expect(summary.quit).toBe(true);
  });

  it("surfaces a failed fix and continues; never presents it as a success", async () => {
    const scan: ScanTool = async () => [
      finding(),
      finding({ urn: CUST, entityName: "customers" }),
    ];
    const applyFix: ApplyFixTool = vi
      .fn()
      .mockRejectedValueOnce(new Error("GMS rejected: bad urn"))
      .mockResolvedValueOnce(fixResult());
    const io = makeIO(["yes", "yes"]);

    const summary = await runScanAndFix({ scan, applyFix, io });

    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.error).toContain("GMS rejected");
    expect(summary.fixed).toHaveLength(1);
    const output = io.lines.join("\n");
    expect(output).toContain("FAILED");
    expect(output).not.toMatch(/Fixed .*ADDRESSES/);
  });
});

describe("createSessionTools — LLM-facing tool safety", () => {
  it("refuses to fix a finding that was not in the last scan", async () => {
    const scan: ScanTool = async () => [finding()];
    const applyFix = vi.fn(async () => fixResult()) as ApplyFixTool;
    const io = makeIO([]);
    const tools = createSessionTools({ scan, applyFix, io });

    await tools.scan();
    const outcome = await tools.applyFixByRef(CUST, "missing-owner");

    expect(outcome.status).toBe("rejected");
    expect(applyFix).not.toHaveBeenCalled();
    expect(io.questions).toHaveLength(0); // rejected before the gate even asks
  });

  it("refuses any fix before the first scan", async () => {
    const scan = vi.fn(async () => [finding()]) as ScanTool;
    const applyFix = vi.fn(async () => fixResult()) as ApplyFixTool;
    const tools = createSessionTools({ scan, applyFix, io: makeIO([]) });

    const outcome = await tools.applyFixByRef(ADDR, "missing-owner");

    expect(outcome.status).toBe("rejected");
    expect(applyFix).not.toHaveBeenCalled();
  });

  it("still runs the terminal confirmation gate for a known finding", async () => {
    const scan: ScanTool = async () => [finding()];
    const applyFix = vi.fn(async () => fixResult()) as ApplyFixTool;
    const io = makeIO(["yes"]);
    const tools = createSessionTools({ scan, applyFix, io });

    await tools.scan();
    const outcome = await tools.applyFixByRef(ADDR, "missing-owner");

    expect(io.questions).toHaveLength(1);
    expect(outcome.status).toBe("fixed");
    expect(applyFix).toHaveBeenCalledTimes(1);
  });

  it("reports declined when the user does not give an explicit yes", async () => {
    const scan: ScanTool = async () => [finding()];
    const applyFix = vi.fn(async () => fixResult()) as ApplyFixTool;
    const io = makeIO(["no"]);
    const tools = createSessionTools({ scan, applyFix, io });

    await tools.scan();
    const outcome = await tools.applyFixByRef(ADDR, "missing-owner");

    expect(outcome.status).toBe("declined");
    expect(applyFix).not.toHaveBeenCalled();
  });

  it("matches a column-level finding by (urn, kind, column)", async () => {
    const pii = finding({ kind: "pii-untagged", column: "town_city" });
    const scan: ScanTool = async () => [pii];
    const applyFix = vi.fn(async () => fixResult()) as ApplyFixTool;
    const io = makeIO(["yes"]);
    const tools = createSessionTools({ scan, applyFix, io });

    await tools.scan();
    // Wrong column → rejected; right column → gated + fixed.
    expect((await tools.applyFixByRef(ADDR, "pii-untagged", "zipcode")).status).toBe("rejected");
    expect((await tools.applyFixByRef(ADDR, "pii-untagged", "town_city")).status).toBe("fixed");
    expect(applyFix).toHaveBeenCalledTimes(1);
    expect(applyFix).toHaveBeenCalledWith(pii);
  });
});
