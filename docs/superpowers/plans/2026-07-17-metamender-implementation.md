# MetaMender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Checkboxes track progress.

**Goal:** A governance-steward agent for DataHub: sweep the metadata graph for governance gaps, explain each in plain English, and on explicit per-item confirmation write the fix back through the official DataHub MCP server.

**Architecture:** Three units. `steward/` (TS MCP stdio client + read-only detectors → severity-ranked findings), `agent/` (Claude Agent SDK harness with a code-enforced confirmation gate + scripted fallback, calls mutation tools on confirm), `report/` (audit md+json into examples/). Reuses ApprovalSentinel's scan→explain→confirm→write-back pattern (disclosed as pre-existing; all DataHub-facing code new).

**Tech Stack:** TypeScript + `@modelcontextprotocol/sdk` (StdioClientTransport) + Claude Agent SDK + vitest. The tool layer is the official `mcp-server-datahub` (Python), run as a stdio subprocess.

**Ground truth from `docs/mcp-recon.md` (verified live, do not re-guess):**
- Launch tool server: `uvx --from mcp-server-datahub mcp-server-datahub --transport stdio`, env `DATAHUB_GMS_URL=http://localhost:8080`, `DATAHUB_GMS_TOKEN=<placeholder>` (local auth OFF), and `TOOLS_IS_MUTATION_ENABLED=true` to expose write tools.
- Read tools: `search`, `get_entities(urns:array)`, `list_schema_fields(urn, keywords:array)`, `get_lineage`, `get_lineage_paths_between`, `get_dataset_queries`.
- Write tools (mutation): `add_tags(tag_urns, entity_urns, column_paths?)`, `add_terms(term_urns, entity_urns, column_paths?)`, `add_owners(owner_urns, entity_urns, ownership_type)`, `set_domains(domain_urn, entity_urns)`, `update_description(entity_urn, operation=replace|append|remove, description?, column_path?)`. Plus remove_* variants.
- **Gotchas (bake in):** descriptions write to `editableProperties.description` NOT `properties.description` — any "is it documented?" check reads BOTH; per-field terms show under `editedGlossaryTerms`; `list_schema_fields.keywords` must be an array; keep one warm MCP session (per-call cold start times out); `get_dataset_assertions` unavailable on this GMS.
- Sample data (showcase-ecommerce, already loaded): 24 datasets, 17 no owner, 19 no description, 10 PII-looking-untagged fields (`zipcode`, `town_city`, `credit_limit`, `shipping_*`). PII glossary term urn + real dataset URNs are listed in mcp-recon.md.
- Rules: Apache 2.0 LICENSE required; disclose pre-existing code; project newly-created-in-window OK (started 2026-07-17); judges must be able to run it; demo video <3 min.

---

## Phase 0 — Scaffold + MCP client smoke

### Task 0.1: Package + license
- [ ] `npm init`, TS + vitest + tsx, `@modelcontextprotocol/sdk`. Add **Apache-2.0 LICENSE file** (hard requirement). `.gitignore` node_modules + .env. Commit.

### Task 0.2: MCP stdio client wrapper (`steward/src/datahubClient.ts`)
- [ ] Thin wrapper: spawn `uvx --from mcp-server-datahub ...` via StdioClientTransport, one long-lived session (warm), typed `callTool(name, args)`. Env from `.env` (GMS URL/token/mutation flag). Expose a narrow interface so tests mock it.
- [ ] Smoke test (integration, gated, needs local DataHub): `list tools` returns the 6 read tools; with mutation flag, 17+. Commit.

## Phase 1 — Detectors (read-only, TDD, no mutations)

Findings type: `Finding { urn, kind, severity, entityName, evidence, proposedFix }`, kinds: `missing-owner | missing-description | pii-untagged | orphan`. Severity ranks pii-untagged-with-downstreams > missing-owner > missing-description > orphan.

### Task 1.1: `steward/src/detectors/missingOwner.ts`
- [ ] Given a datahub client, `search` datasets → `get_entities` → flag those with empty ownership. TDD with a recorded fixture response (capture one real `get_entities` payload into `test/fixtures/`). Commit red→green.

### Task 1.2: `steward/src/detectors/missingDescription.ts`
- [ ] Flag datasets where BOTH `properties.description` and `editableProperties.description` are empty (the gotcha). Fixture test. Commit.

### Task 1.3: `steward/src/detectors/piiUntagged.ts`
- [ ] `list_schema_fields` → name heuristic (email|ssn|phone|zip|address|dob|credit|shipping|town_city|ip) → flag fields with no PII glossary term (check `editedGlossaryTerms` too). Table-driven test on the heuristic + a fixture. Commit.

### Task 1.4: `steward/src/scan.ts` + CLI
- [ ] Compose detectors, severity-sort, emit `Finding[]`; `steward scan [--json] [--dry-run]`. Fixture-backed CLI test. Commit.

## Phase 2 — Write-back + confirmation gate

### Task 2.1: `steward/src/fixes.ts`
- [ ] Map each Finding kind to a mutation call: missing-owner → `add_owners([corpuser urn], [urn], "TECHNICAL_OWNER")`; missing-description → `update_description(urn, replace, <AI-or-template draft marked "drafted by MetaMender">)`; pii-untagged → `add_terms([PII term urn], [urn], [column])`. Idempotent per (urn, aspect). Unit-test the arg-building against recon's exact signatures. Commit.

### Task 2.2: `agent/src/harness.ts` (port ApprovalSentinel gate)
- [ ] Confirmation gate in code: one explicit per-finding "yes" before any fix runs, never batched, shows urn+kind+proposedFix, surfaces failures. Scripted mode (no ANTHROPIC_API_KEY) + LLM mode (Claude Agent SDK, tools = scan + apply-fix). Port the harness tests (gate cannot be bypassed). Commit.

### Task 2.3: Live end-to-end on local DataHub
- [ ] Scan showcase-ecommerce → confirm a few fixes → verify write-back by re-reading (owner set, description in editableProperties, PII term on column). Capture into `examples/` (md + json audit report). Screenshot the DataHub UI showing the fixed entity for the demo. Commit.

## Phase 3 — Bonus skill + submission materials

### Task 3.1: `governance-audit` skill PR to datahub-project/datahub-skills
- [ ] Distill the read-only sweep into a Claude Code plugin skill (their format). Prepare as a PR in `bounty/skill-pr/` (file during window, link in submission). Commit.

### Task 3.2: Submission package
- [ ] English README: problem → solution → mermaid arch → how it uses DataHub (MCP read+write, the write-back preference) → judging-criteria map → run-it-yourself (docker quickstart + datapack + our CLI) → **pre-existing-code disclosure** (ApprovalSentinel gate pattern) → Apache-2.0 note → tests → roadmap.
- [ ] `docs/demo-video-script.md`: <3 min, no-voiceover, captions + Chinese operator column. Shots: the governance-debt problem → scan finds gaps → agent explains one → confirm → write-back → DataHub UI shows the fix live → bonus skill. Real footage.
- [ ] `docs/submission-form.md`: Devpost fields pre-filled (project name, tagline, built-with, track=Agents That Do Real Work, repo + video TODO).

---

## Self-review notes
- Every mutation signature and gotcha traces to `docs/mcp-recon.md` (verified live), not guesses.
- Scope: 3 detectors + 3 fixes on one sample dataset pack, no custom UI (DataHub's own UI shows results), no real warehouse. YAGNI.
- Compliance: Apache-2.0 (0.1), pre-existing disclosure (3.2), newly-created-in-window (all commits ≥2026-07-17), judge-runnable (quickstart + CLI).
