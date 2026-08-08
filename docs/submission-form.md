# Devpost submission — pre-filled fields

Copy the English fields into **Build with DataHub: The Agent Hackathon**. The
public demo URL below matches the submitted Devpost entry.

## Project name

```text
MetaMender
```

## Tagline

```text
Find metadata debt, approve one safe repair, and prove the result in DataHub.
```

## Track

```text
Track 1 — Agents That Do Real Work
```

## Inspiration

```text
Metadata catalogs rarely fail in one dramatic event. They decay through hundreds of small gaps: an owner disappears, a description is blank, a sensitive-looking field is never classified. Search quality drops, accountability becomes ambiguous, and governance teams spend their time chasing spreadsheets instead of improving the catalog.

We wanted a steward that could do the repetitive investigation and remediation work without turning an AI model into an unchecked metadata administrator.
```

## What it does

```text
MetaMender scans a DataHub catalog through the official DataHub MCP server and produces a risk-ranked governance work queue. It detects missing owners, missing descriptions, PII-looking fields without the configured PII glossary term, and orphan cleanup candidates.

For each actionable finding, MetaMender explains the evidence and the exact DataHub change it proposes. A code-enforced terminal gate then requires a fresh explicit "yes" for that one finding. Only then can it call add_owners, update_description, or add_terms. After a successful mutation, it independently re-reads DataHub and writes a Markdown and JSON audit record containing the finding, human decision, mutation arguments, DataHub acknowledgement, and before/after verification.

With ANTHROPIC_API_KEY, Claude Agent SDK drives the scan and fix tools. Without a key, a deterministic orchestrator drives the same tools and the same gate. In both modes, a model cannot invent a write target, batch approvals, or bypass the terminal confirmation.
```

## How we built it

```text
MetaMender is a TypeScript agent built around the published mcp-server-datahub package, pinned to version 0.6.0. It keeps one long-lived MCP stdio session and uses search, get_entities, list_schema_fields, and get_lineage for discovery. Approved repairs use add_owners, update_description, and add_terms; verification reuses fresh read calls rather than trusting a mutation acknowledgement.

The agent layer exposes scan_governance_gaps and apply_governance_fix as in-process tools to Claude Agent SDK. The apply tool is wrapped by a code-enforced confirmation gate shared with the deterministic fallback. Findings must come from the latest scan and are keyed by exact URN, kind, and optional column.

The repository includes deterministic detectors, bidirectional lineage-based orphan review candidates, configurable owner/glossary targets, mutation planning, independent verification, dual-format audit reporting, 85 passing default tests, and three additional real MCP integration checks against a local DataHub quickstart. The dependency audit currently reports zero known vulnerabilities.

For the open-source bonus, we submitted a reusable read-only /datahub-audit skill to datahub-project/datahub-skills: https://github.com/datahub-project/datahub-skills/pull/70. It fills an existing routing gap in that repository and is independent of MetaMender's implementation.
```

## Challenges

```text
DataHub metadata has both ingested and editable overlays, so a description can look missing if only one aspect is checked. Column glossary terms have the same issue. We made every detector and verifier resolve the effective state instead of checking a single field.

The second challenge was agent safety. Prompt instructions alone were not enough. We enforced target provenance and per-item confirmation in code, made EOF fail closed, prohibited batch approval, and required a fresh DataHub read before reporting success.

Finally, MCP tool startup is expensive when a new server is spawned for every call. MetaMender initializes one pinned server process and reuses the session for the entire round.
```

## Accomplishments

```text
- A real read → explain → approve → write → verify workflow against DataHub OSS.
- Code-enforced one-finding/one-confirmation safety shared by LLM and deterministic modes.
- Evidence-backed PII candidates with downstream-aware severity.
- Human-readable and machine-readable audit trails.
- 85 default tests plus three passing real DataHub MCP checks.
- A validated, reusable datahub-audit skill contribution submitted as datahub-project/datahub-skills#70.
```

## What we learned

```text
A useful governance agent needs more than mutation tools. It needs clear evidence, effective-metadata semantics, target provenance, human authority at the exact point of change, and independent verification. MCP made the DataHub integration portable; the hard work was designing the boundary around writes.
```

## What's next

```text
Next we will evolve the current environment-configured owner and glossary targets into versioned policy profiles, resolve ownership through domains and teams, add bounded scheduling and trend reports, and support additional DataHub governance dimensions such as assertions and structured properties. The submitted datahub-audit skill can make read-only catalog audits reusable without installing MetaMender.
```

## Built with

```text
DataHub OSS, DataHub MCP Server, DataHub Skills, Claude Agent SDK, Model Context Protocol SDK, TypeScript, Zod, Vitest, Docker, uv
```

## Public repository

```text
https://github.com/yangyangnovelist-hub/metamender
```

## Demo video

```text
https://youtu.be/5BLmMYNmkWE
```

## AI and prior-work disclosure

```text
AI coding assistants were used during development and are disclosed here. The code-enforced confirmation-gate architecture and in-process Claude SDK MCP pattern were adapted from our pre-existing ApprovalSentinel project. All DataHub-specific detectors, MCP mappings, verification, audit reporting, CLI work, and the datahub-audit skill contribution were built during this hackathon. Third-party components include the official DataHub MCP server and showcase data, Anthropic SDKs, the Model Context Protocol SDK, Zod, TypeScript, and Vitest.
```

## Final operator checklist（不要粘贴进提交字段）

1. 确认公开 GitHub 仓库和 Apache-2.0 `LICENSE` 仍可访问。
2. 运行 `npm test`、`npm run typecheck`、`npm run test:integration` 和 `npm audit`。
3. 按 `docs/demo-video-script.md` 录制，确认上传后时长低于三分钟。
4. 确认 upstream PR https://github.com/datahub-project/datahub-skills/pull/70 可访问。
5. 在 Devpost 截止时间 **2026-08-10 5:00 PM EDT** 前提交并保存最终页面截图。
