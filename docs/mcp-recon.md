# MetaMender — DataHub MCP Server Recon

Interface truth-source for wiring the MetaMender agent to the official DataHub MCP server, captured against a **local DataHub quickstart** with the `showcase-ecommerce` (order_entry) sample data loaded.

- Date: 2026-07-18
- MCP server: `acryldata/mcp-server-datahub` (PyPI `mcp-server-datahub`) **v0.6.0**
- Server advertises `serverInfo = {name: "datahub", version: "3.4.4"}` (that's the FastMCP/server framework version, not the package version)
- Local DataHub: quickstart, GMS `v1.5.0.6` (`/config` → serverType `quickstart`, core), UI `datahub/datahub`
- Bundled `acryl-datahub` SDK in the uvx env: 1.x (matches CLI `1.6.0.15` installed locally)
- All findings below come from an actual MCP `tools/list` + live `tools/call` round-trips, **not** from docs or guesses.

> Tokens/secrets are NOT stored in this file. Where a token would go, a placeholder is used. See "Connection config".

---

## 1. Connection config

**Auth is OFF on this local quickstart.** An unauthenticated OpenAPI call succeeds:
```
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/openapi/v3/entity/dataset?count=1"  → 200
```
So no real token is required. The MCP server still *reads* a token env var, so we pass a placeholder.

- **GMS URL**: `http://localhost:8080` (the metadata service / REST — NOT the UI on 9002). The MCP server connects to GMS, not the frontend.
- **Token**: not enforced. We pass `DATAHUB_GMS_TOKEN=PLACEHOLDER_NO_AUTH`. It's ignored because Metadata-Service auth is disabled in quickstart.
- If auth ever gets turned on: generate a Personal Access Token in UI → Settings → Access Tokens (or `datahub` CLI), and set `DATAHUB_GMS_TOKEN` to it. Note: quickstart's token-signing key is randomized on first boot, so regenerate the PAT after any DataHub upgrade.

The server reads either env vars or `~/.datahubenv`. We used env vars (cleaner for an agent). A `~/.datahubenv` with `gms_url` / `gms_token` also works and is what the `datahub` CLI uses.

**Launch command (stdio transport, what the agent should spawn):**
```
DATAHUB_GMS_URL=http://localhost:8080 \
DATAHUB_GMS_TOKEN=<placeholder-or-PAT> \
TOOLS_IS_MUTATION_ENABLED=true \
uvx --from mcp-server-datahub mcp-server-datahub --transport stdio
```
Transports supported: `stdio | sse | http` (`--transport` flag). stdio is what Claude Agent SDK / Claude Code want.

Prereq installed during recon: `uv`/`uvx` (via astral installer to `~/.local/bin`). First `uvx` run downloads ~116 packages (Python 3.13 env), a few seconds warm after that.

---

## 2. Tool inventory (from live `tools/list`)

### Default (no env toggles): 6 tools — all read-only
`search`, `get_lineage`, `get_dataset_queries`, `get_entities`, `list_schema_fields`, `get_lineage_paths_between`

`*` = required param. Types from the real JSON inputSchema.

| Tool | What it does | Params |
|---|---|---|
| `search` | Structured full-text search across entities. Supports `filter` DSL (e.g. `entity_type = dataset`), sorting, paging. | `query:str`(default `*`), `filter:str?`, `num_results:int`=10, `sort_by:str?`, `sort_order:asc\|desc`, `offset:int` |
| `get_lineage` | Upstream/downstream lineage for any entity or column. The blast-radius engine. | `urn*`, `column:str?`, `query:str?`, `filter:str?`, `upstream:bool`=true, `max_hops:int`=1, `max_results:int`=30, `offset:int` |
| `get_dataset_queries` | SQL queries touching a dataset/column (find real usage of a column). | `urn*`, `column:str?`, `source:str?`, `start:int`, `count:int` |
| `get_entities` | Full detail for one+ entities by URN: schema, tags, terms, ownership, editableProperties, structuredProperties, domains. Batch-friendly. | `urns*:array` |
| `list_schema_fields` | List a dataset's schema fields (+ per-field terms), keyword filter + paging. **`keywords` MUST be an array**, not a string. | `urn*`, `keywords:array?`, `limit:int`, `offset:int` |
| `get_lineage_paths_between` | Column/entity-level path(s) between two URNs. | `source_urn*`, `target_urn*`, `source_column:str?`, `target_column:str?`, `direction:str?` |

Two more search-group tools exist in source (`search_documents`, `grep_documents`) but are **auto-filtered out** because the catalog has no "documents" (DataHub knowledge-base docs) loaded. They'd appear if documents existed.

### Mutation tools — gated by `TOOLS_IS_MUTATION_ENABLED=true`
When set, adds **11 write tools** (+ `save_document` if also enabled). This is the "write metadata back" capability — **it works on the local OSS quickstart**, verified below.

| Tool | What it does | Params |
|---|---|---|
| `add_tags` | Add tag(s) to entities and/or their columns. | `tag_urns*:array`, `entity_urns*:array`, `column_paths:array?` |
| `remove_tags` | Remove tag(s). | same shape as add_tags |
| `add_terms` | Add glossary term(s) to entities/columns. **← MetaMender's PII-tagging path.** | `term_urns*:array`, `entity_urns*:array`, `column_paths:array?` |
| `remove_terms` | Remove glossary term(s). | same |
| `add_owners` | Add owner(s). | `owner_urns*:array`, `entity_urns*:array`, `ownership_type*:str` |
| `remove_owners` | Remove owner(s). | `owner_urns*:array`, `entity_urns*:array`, `ownership_type:str?` |
| `set_domains` | Set domain on entities. | `domain_urn*:str`, `entity_urns*:array` |
| `remove_domains` | Remove domain. | `entity_urns*:array` |
| `update_description` | Set/append/remove description on an entity or a column. Writes to the **editable** overlay (see gotcha #4). | `entity_urn*:str`, `operation:replace\|append\|remove`=replace, `description:str?`, `column_path:str?` |
| `add_structured_properties` | Add structured property values. | `property_values*:object`, `entity_urns*:array` |
| `remove_structured_properties` | Remove structured properties. | `property_urns*:array`, `entity_urns*:array` |
| `save_document` | Create/update a standalone knowledge-base doc. Only if `SAVE_DOCUMENT_TOOL_ENABLED` (default on) **and** mutation enabled. | `document_type*`, `title*`, `content*`, `urn?`, `topics?`, `related_documents?`, `related_assets?` |

### User tools — gated by `TOOLS_IS_USER_ENABLED=true`
- `get_me` — info about the authenticated user (no params).

### Data-quality tools — gated by `DATA_QUALITY_TOOLS_ENABLED=true`
- Source defines exactly one: `get_dataset_assertions`.
- **GOTCHA:** even with the flag on, it did **NOT** appear in `tools/list` on this GMS `v1.5.0.6`. It's version-gated (`@min_version` → `TOOL_VERSION_REQUIREMENTS`, filtered by `get_valid_tools_from_mcp` against the connected GMS version). Treat assertions as unavailable on this OSS build; don't depend on it for MetaMender.

### Other env toggles found in source
- `SEMANTIC_SEARCH_ENABLED` — swaps `search` for an enhanced variant; **Cloud-only** (validated at runtime), leave off for OSS.
- `SAVE_DOCUMENT_TOOL_ENABLED` (default true, needs mutation on), `SAVE_DOCUMENT_ORGANIZE_BY_USER`, `SAVE_DOCUMENT_RESTRICT_UPDATES`, `SAVE_DOCUMENT_PARENT_TITLE`.
- `DESCRIPTION_LENGTH_LIMIT` (5000), `TOOL_RESPONSE_TOKEN_LIMIT` (80000), `ENTITY_SCHEMA_TOKEN_BUDGET` (16000) — response-size guards.

**Full tool count:** 6 (default) → 19 with `TOOLS_IS_MUTATION_ENABLED` + `TOOLS_IS_USER_ENABLED` + `DATA_QUALITY_TOOLS_ENABLED` all on (DQ tool filtered by version, so effectively 6 + 11 mutation + 1 save_document + 1 get_me = 19).

---

## 3. Mutation: how to enable

Set **`TOOLS_IS_MUTATION_ENABLED=true`** in the MCP server's environment (see launch command in §1). That's the only switch needed for tags/terms/owners/domains/descriptions/structured-properties. `save_document` is additionally on by default once mutation is on.

Startup log confirms state, e.g.:
```
Mutation Tools ENABLED MCP Server.
```
(default run logs `Mutation Tools DISABLED`, `User Tools DISABLED`, `Data Quality Tools DISABLED`.)

Boolean env vars are parsed loosely (true/1/yes). No token/perm barrier on the local quickstart since auth is off — writes go straight through GMS.

---

## 4. Three-plus validated calls (real URNs + request/response)

Sample data = the `order_entry` e-commerce showcase: **24 datasets** across dbt / snowflake / postgres / s3 / looker / powerbi / tableau, all URN-prefixed `b2fd91.`.

### (a) search — find datasets
Request: `search(query="*", filter="entity_type = dataset", num_results=15)`
Response (excerpt): `total: 24`, results incl.
```
urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.addresses,PROD)  → "ADDRESSES"
urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.order_items,PROD) → "ORDER_ITEMS"
urn:li:dataset:(urn:li:dataPlatform:dbt,b2fd91.ORDER_ENTRY_DB.analytics.order_history,PROD)       → "order_history"
```
Also returns facets (container, type/subtype, platform, domain) — useful for gap dashboards.

### (b) get_entities + list_schema_fields — inspect one dataset
Target: `urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.addresses,PROD)`

`get_entities([urn])` returned: name `ADDRESSES`; platform snowflake; a tag `💲 Large Table`; a dataset-level **PII** glossaryTerm; structuredProperties (`Data Freshness SLA=Daily`, `Data Quality Score=87.1`, `Retention Period=Indefinite`); **no `ownership`** block (→ no owner); **no `properties.description`** (→ undocumented).

`list_schema_fields(urn)` → 9 fields. PII terms present on `address_id, address_line1, address_line2, customer_id`; **absent on `town_city`, `zipcode`** (obvious PII, untagged → governance gap).

### (c) MUTATION write + re-read verify  ✅
With `TOOLS_IS_MUTATION_ENABLED=true`, on the same ADDRESSES dataset:

1. `add_terms(term_urns=["urn:li:glossaryTerm:b2fd91.1598cf93-c199-43a1-8833-fce96faa9a1a"], entity_urns=[ADDR], column_paths=["zipcode"])`
   → `{"success":true,"message":"Successfully added 1 glossary term(s) to 1 entit(ies)"}`
2. `update_description(entity_urn=ADDR, operation="replace", description="[MetaMender recon test] Customer shipping addresses. Contains PII ...")`
   → `{"success":true,"message":"Description updated successfully"}`

**Verified by a fresh MCP read (not just the write's own ack):**
- `list_schema_fields(urn, keywords=["zipcode"])` → `zipcode | terms: ['PII']` (was empty before). ✅
- `get_entities([urn])` → `editableProperties.description = "[MetaMender recon test] Customer shipping addresses..."` ✅

The PII term URN (`urn:li:glossaryTerm:b2fd91.1598cf93-c199-43a1-8833-fce96faa9a1a`) is the sample data's own "PII" term under the "Classification" glossary node — reuse it for MetaMender's auto-tagging.

> These two test writes are left in place (they're legitimate improvements + good demo evidence). To revert: `remove_terms(...zipcode...)` and `update_description(entity_urn=ADDR, operation="remove")`.

### (d) bonus — get_lineage (blast radius)
`get_lineage(urn=<snowflake order_items>, upstream=false, max_hops=2, max_results=10)`
→ `downstreams.total: 17` datasets (8 Table / 6 View / 4 Custom SQL) across powerbi, tableau, dbt, spanning 3 domains. This is the "explode a column change downstream" material for the demo.

---

## 5. Governance gaps in the sample data (demo material)

Computed by batch `get_entities` over all 24 datasets + per-field term scan.

**No owner — 17 / 24 datasets.** URNs incl.:
```
urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.addresses,PROD)
urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.order_items,PROD)
urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.promotions,PROD)
urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.warehouses,PROD)
urn:li:dataset:(urn:li:dataPlatform:postgres,b2fd91.order_entry_db.order_entry.addresses,PROD)
urn:li:dataset:(urn:li:dataPlatform:postgres,b2fd91.order_entry_db.order_entry.product_information,PROD)
urn:li:dataset:(urn:li:dataPlatform:s3,b2fd91.demo-data-bucket/order_entry/customers,PROD)
urn:li:dataset:(urn:li:dataPlatform:s3,b2fd91.demo-data-bucket/order_entry/inventories,PROD)
urn:li:dataset:(urn:li:dataPlatform:powerbi,b2fd91.datahub_order_entries.Essential_KPI_Measures,PROD)
urn:li:dataset:(urn:li:dataPlatform:tableau,b2fd91.f32082e5-06b8-f46e-9047-4611fffe66b0,PROD)   (Custom SQL Query)
... (7 more: dbt order_history, snowflake ORDER_HISTORY/ORDER_ITEMS, postgres order_items/promotions, powerbi Geographic_Measures, s3 product_information/regions)
```

**No description — 19 / 24 datasets** (checked both `properties.description` and `editableProperties.description`). Overlaps heavily with the no-owner set; incl. all four snowflake `order_entry.*` tables, all postgres tables, all s3 datasets, both powerbi measure datasets, the tableau "Order Mode" and looker `order_details`.

**PII-looking fields with NO PII term — 10 fields** (prime auto-tag targets):
```
zipcode              — snowflake .addresses   (NOW TAGGED during test (c); pre-existing gap)
town_city            — snowflake .addresses
zipcode, town_city   — postgres .addresses
zipcode, town_city, credit_limit — s3 .../customers
shipping_zipcode, shipping_town_city — looker order_details (explore)
shipping_town_city   — looker order_details (view)
```
Detection heuristic used: fieldPath matches `email|phone|ssn|address|zip|zipcode|postal|dob|birth|name|credit|card|ip_address|license|gender|city|town`, and the field has no glossary term whose name contains "PII". Good enough for a demo; MetaMender can refine with the PII glossary term's own definition text (it enumerates direct/indirect identifiers, retrievable via get_entities on the term URN).

---

## 6. Gotchas / traps hit

1. **`uvx` wasn't installed** — installed `uv` via `curl -LsSf https://astral.sh/uv/install.sh | sh` → `~/.local/bin`. Agent must have `~/.local/bin` on PATH.
2. **`timeout` binary absent on macOS** — don't rely on it in scripts (use gtimeout or none).
3. **Per-call cold start is slow.** Each fresh `uvx ... mcp-server-datahub` spawn pays server init. Batch multiple `tools/call`s into ONE stdio session (one initialize) — a naive loop of one-server-per-call timed out at 2 min for 4 batches. MetaMender should keep a **single long-lived MCP session**.
4. **`update_description` writes to `editableProperties`, not `properties`.** After a write, `properties.description` stays null; read `editableProperties.description`. Any "is it documented?" check must look at BOTH. (Same overlay applies to editable tags/terms — per-field terms show under `editedGlossaryTerms`.)
5. **`list_schema_fields` `keywords` must be an array.** Passing a string → pydantic `list_type` validation error. (Easy to get wrong; the param name reads singular-ish.)
6. **`get_dataset_assertions` is version-gated off** on GMS v1.5.0.6 even with `DATA_QUALITY_TOOLS_ENABLED=true` — don't design around assertions on this OSS build.
7. **`search_documents`/`grep_documents` auto-hidden** when no knowledge-base documents exist — they're not "missing", just filtered by `document_tools_middleware`.
8. **Two "MCP"s** (unchanged from research): this is Model Context Protocol; DataHub's internal MCP = MetadataChangeProposal (the write primitive these mutation tools wrap). Don't hand-write MCPs.
9. **`search` returns max ~facet-limited results** but `total` is exact (24). Use `num_results` + `offset` to page; facets give free aggregation for gap dashboards.
10. Sample data URN prefix is `b2fd91.` on every entity (the showcase seed's namespace). Don't hardcode it in MetaMender logic beyond the demo.
11. GMS `/health` returns empty body but `/config` is the real liveness/version probe.

---

## 7. Reusable recon harness

A minimal stdio JSON-RPC MCP client used for all of the above lives in the session scratchpad (`mcp_client.py`): does `initialize` → `notifications/initialized` → `tools/list`, then runs any `tools/call`s from a JSON file in a single session. Env toggles passed as `ENV:KEY=VALUE` args. Port it into MetaMender's repo if a lightweight non-SDK client is ever needed; otherwise the Claude Agent SDK's MCP client handles this natively.
