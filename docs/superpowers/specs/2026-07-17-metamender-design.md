# MetaMender — a governance-steward agent for DataHub (Design)

Date: 2026-07-17
Competition: Build with DataHub: The Agent Hackathon (Devpost), Track 1 "Agents That Do Real Work"
Deadline: 2026-08-10 17:00 EDT · Prize: $6,000 grand / $3,000 track / $1,000 HM (all cash)
Rules constraints: Apache 2.0 LICENSE required; project newly created during submission
period (pre-existing code allowed with disclosure); judges must be able to run it;
demo video under 3 minutes with real running footage.

## Problem

Every real DataHub deployment accumulates governance debt: datasets with no owner,
tables with no description, PII-looking columns with no tags, deprecated assets still
referenced downstream. Data teams know the debt is there but auditing thousands of
entities by hand doesn't happen, so the catalog rots and trust in it erodes.

## Solution (one sentence)

An agent that sweeps the DataHub metadata graph, finds and risk-ranks governance gaps,
explains each one in plain English, and, only after an explicit per-item "yes", writes
the fix back to the graph through DataHub's Model Context Protocol server.

This directly targets judging criterion #1's stated preference ("writes back to the
metadata graph") and reuses the confirmation-gate architecture proven in
ApprovalSentinel (disclosed as pre-existing pattern; all DataHub-facing code is new).

## Scope

- Detectors (the sweep): missing owner · missing description (dataset and field level)
  · PII-pattern columns without PII tag (name heuristics: email, ssn, phone, address,
  dob, ip_address...) · deprecated assets with active downstream lineage · orphan
  datasets (no lineage at all, candidates for cleanup).
- Fixes (the write-back, each behind the gate): add owner · write AI-drafted
  description (from schema + lineage context, marked as AI-drafted) · apply PII tag ·
  propose deprecation note to downstream owners · tag orphan for review.
- Demo dataset: official showcase-ecommerce datapack (~1,050 entities with lineage) —
  no real warehouse needed, judges can reproduce with one command.
- Out of scope: custom UI (CLI + report is the product; DataHub's own UI shows the
  written-back results), multi-instance support, real warehouse connectors, auto-fix
  without confirmation (the gate IS the product stance).

## Architecture (three units)

1. **`steward/` scanner (TypeScript)** — read-only sweep via the DataHub MCP server's
   query tools (search, get_entities, list_schema_fields, get_lineage). Emits
   `Finding {urn, kind, severity, evidence, proposedFix}` JSON, severity-ranked
   (e.g. PII-unlabelled on a table with many downstreams outranks a missing
   description on an orphan). Deterministic, testable with fixture responses.
2. **`agent/` conversation layer (Claude Agent SDK)** — presents findings in plain
   English, answers "why does this matter", and on explicit per-finding confirmation
   calls the MCP mutation tools (`TOOLS_IS_MUTATION_ENABLED=true`): add_owners,
   update_description, add_tags. Scripted fallback mode (no ANTHROPIC_API_KEY) drives
   the same loop deterministically, same pattern as ApprovalSentinel's harness.
   The confirmation gate lives in code, not in a prompt.
3. **`report/`** — every run writes an audit report (markdown + JSON in `examples/`):
   what was found, what the human approved, what was written back, with before/after
   entity URLs. Doubles as the rules-recommended examples folder.

Transport: bare streamable-HTTP MCP client against self-hosted GMS `:8080/mcp`
(reusing our proven handshake pattern; disclosed), falling back to the official
Python stdio server via a thin bridge if the HTTP endpoint misbehaves.

## Bonus play (judging criterion #6)

Contribute a `governance-audit` skill PR to datahub-project/datahub-skills (their
skills are Claude Code plugin format, which we know well): a distilled read-only
version of the sweep as a reusable skill. Filed during the window, linked in the
submission.

## Error handling

MCP calls retry with backoff; mutation calls are idempotent per (urn, aspect); every
write is logged before and after; a `--dry-run` flag runs the whole loop without
mutations. If the mutation toolset is unavailable (env flag off), the agent degrades
to report-only and says so, never silently.

## Testing

Scanner unit tests on fixture MCP responses (recorded from the live local instance);
gate tests proving no mutation happens without a fresh explicit yes (port of the
ApprovalSentinel harness tests); one end-to-end run against local quickstart +
showcase-ecommerce captured for the demo video.

## Division of labor

Claude writes all code, docs, demo script. User: Devpost registration/submission,
demo recording (script with Chinese operator column, same as previous two projects).
