# Prepared `datahub-audit` upstream contribution

Target: `datahub-project/datahub-skills`.

## Files

| Prepared file | Upstream destination |
| --- | --- |
| `skills/datahub-audit/SKILL.md` | `skills/datahub-audit/SKILL.md` |
| `skills/datahub-audit/README.md` | `skills/datahub-audit/README.md` |
| `commands/catalog-audit.md` | `commands/catalog-audit.md` |
| `PR-BODY.md` | Pull-request description |

Suggested PR title: `feat: add read-only DataHub governance audit skill`.

Before filing, apply these files to a fresh fork of the official repository, run its
`pre-commit run --all-files`, and include any upstream README/routing-table updates requested
by maintainers. Do not copy MetaMender implementation code into the skill; the contribution
is a reusable MCP/CLI workflow and has no dependency on this project.
