## Summary

Add the missing `datahub-audit` interaction skill and its Claude Code command.
Existing Search and Enrich guidance already routes systematic metadata coverage work to
`/datahub-audit`; this PR supplies that read-only workflow.

The audit covers:

- effective owner and description coverage across ingested/editable overlays and siblings;
- heuristic PII-classification candidates with explicit false-positive caveats;
- deprecated assets with active downstreams;
- orphan datasets;
- bounded pagination, evidence, severity, methodology, and limitations.

The skill never mutates metadata. Selected remediation is handed to `datahub-enrich`,
which independently re-reads state, shows a before/after plan, and obtains approval.

## Why this belongs in datahub-skills

`datahub-search` handles one-off discovery and questions, while `datahub-enrich` handles
approved changes. A systematic coverage audit sits between them: it gathers evidence
across a declared scope, calculates governance coverage, prioritizes risk, and produces
a remediation-ready handoff without writing.

## Validation

- Validated the skill with the Agent Skills `quick_validate.py` schema checker.
- Kept the skill under 500 lines and limited it to existing DataHub MCP/CLI capabilities.
- Tested the underlying owner, description, PII-term, schema, and lineage workflow against
  a local DataHub quickstart populated with the official showcase-ecommerce sample.
