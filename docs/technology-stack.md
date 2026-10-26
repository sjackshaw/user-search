# Technology Stack

A complete inventory of every technology, framework, library, model, and tool used in the User Search project.

---

## Runtime & Language

| Technology | Version | Purpose |
|---|---|---|
| **Node.js** | 22 (Docker) | Application runtime for all services |
| **JavaScript (CommonJS)** | ES2022 | Primary language — strict mode throughout |
| **Python** | 3.x | Synthetic data generation and seed scripts |

---

## Web Framework

| Package | Version | Service(s) |
|---|---|---|
| **Express** | ^4.21.0 | App (port 3000), GenAI (port 3001) |

---

## Database

| Technology | Version / Image | Purpose |
|---|---|---|
| **PostgreSQL** | 15 (`pgvector/pgvector:pg15`) | Primary relational data store |
| **pgvector** | Bundled with `pgvector/pgvector:pg15` | Vector similarity search extension |
| **vector(384)** | — | Column type storing 384-dimension embeddings |
| **HNSW indexes** | — | Approximate nearest-neighbour index (cosine distance) on 12 ETL tables plus agent/search tables where applicable |
| **Stored procedures** | PL/pgSQL | All query logic (search, lookup, intersection, ETL job management) in `19_stored_procedures.sql` — runs after every table it references |
| **`agent_tickets` table** | — | Ticketing for agent write actions (`infra/db/init/15_agent_tickets.sql`) |
| **`access_requests` table** | — | Self-service access request queue with `pending → approved → rejected` lifecycle (`infra/db/init/16_access_requests.sql`) |
| **`governance_violations` table** | — | Tracked naming/ownership/orphaned-resource/oversharing/stale-guest/inactive-license violations, with a propose→approve→apply remediation workflow (`infra/db/init/17_governance_violations.sql`, `24_remediation_proposals.sql`) |
| **`scheduled_reports` table** | — | Persisted CSV snapshots of violations/change-logs, generated daily via cron plus on demand (`infra/db/init/18_scheduled_reports.sql`) |
| **`policy_rules` table** | — | Admin-editable governance thresholds (naming prefixes, min owners, severities, score weights, inactivity windows, per-check enable/disable) — empty table falls back to hardcoded defaults (`infra/db/init/23_policy_rules.sql`) |
| **Governance event triggers** | PL/pgSQL | `trg_evaluate_group_governance()` fires on every `m365_group_memberships`/`distribution_groups` write to evaluate naming/ownership rules synchronously, independent of any scan (`infra/db/init/21_governance_event_triggers.sql`) |

### Database Client

| Package | Version | Service(s) |
|---|---|---|
| **pg** (node-postgres) | ^8.13.0 | All services (app, genai, 6 ETL lines) |

---

## Embedding Model

| Model | Dimensions | Library | Purpose |
|---|---|---|---|
| **all-MiniLM-L6-v2** (SBERT) | 384 | `@xenova/transformers` ^2.17.2 | Sentence embedding for semantic search and ETL vectorisation |

The model runs **locally in-process** via ONNX Runtime (bundled inside `@xenova/transformers`). No external inference API is required. Model weights are cached to a Docker volume at `/home/node/.cache/huggingface/hub`.

---

## Large Language Model

| Technology | Model | Purpose |
|---|---|---|
| **Ollama** | `qwen2.5:3b` | Local LLM inference for the GenAI agent (tool calling, natural-language responses) |

Ollama runs as a sidecar Docker container (`ollama/ollama`). The GenAI service communicates with it via the `/api/chat` REST endpoint with `stream: false`.

### Key LLM Parameters (Ollama)

| Parameter | Value |
|---|---|
| Temperature | 0.3 |
| Context window | 4096 tokens |
| Tool calling | Ollama native tool-call interface |

### GenAI Agent Tools

The GenAI agent exposes **57 tool-calling capabilities** grouped by scope, dispatched from a single `AGENT_TOOLS` array / `executeToolCall` switch in `services/genai/index.js`:

| Group | Count | Tools | Audit behaviour |
|---|---|---|---|
| Account Operations | 6 | `provision_account`, `disable_account`, `reset_password`, `update_attribute`, `add_to_group`, `add_to_m365_group` | All write actions create and auto-close `agent_tickets` on success |
| Microsoft 365 Service Desk | 10 | `reset_mfa`, `get_mfa_status`, `assign_license`, `remove_license`, `grant_mailbox_access`, `add_email_alias`, `get_out_of_office`, `set_out_of_office`, `add_to_teams_channel`, `grant_onedrive_access` | Read-only checks skip tickets; write actions create audit tickets |
| M365 Governance Actions | 9 | `list_inactive_licenses`, `list_stale_guests`, `revoke_guest_access`, `dismiss_risky_user`, `list_app_consents`, `revoke_app_consent`, `explain_ca_block`, `get_device_compliance`, `get_bitlocker_key` | Read-only checks skip tickets except `get_bitlocker_key`, which is always ticketed |
| General / Ticketing | 3 | `create_ticket`, `list_open_tickets`, `describe_capabilities` | Informational; no additional tickets created |
| Lifecycle Management | 4 | `onboard_user`, `offboard_user`, `deprovision_cascade`, `bulk_action` | All lifecycle actions create audit tickets; `bulk_action` creates one ticket per affected user |
| Access Requests | 3 | `submit_access_request`, `list_access_requests`, `approve_access_request` | Requests stored in `access_requests` table; approvals trigger provisioning and close the request |
| Department Access Templates | 2 | `apply_access_template`, `list_access_templates` | `apply_access_template` creates an audit ticket; list is read-only |
| Governance Detection & Remediation | 7 | `list_naming_violations`, `enforce_naming_convention`, `list_groups_missing_owners`, `enforce_minimum_owners`, `list_orphaned_resources`, `reassign_resource_owner`, `list_oversharing_risks` | Detection is read-only; bulk-fix tools create one ticket-free DB transaction and are also auto-proposed as remediations on the next scan |
| Violation Tracking & Remediation Workflow | 6 | `scan_governance_violations`, `list_violations`, `assign_violation`, `resolve_violation`, `approve_remediation`, `reject_remediation` | `approve_remediation` is the only call that ever applies a proposed fix; nothing is auto-applied |
| Compliance Reporting & Analytics | 4 | `get_compliance_score`, `get_trend_analytics`, `generate_report`, `list_reports` | Read-only; `generate_report` persists a CSV snapshot row |
| Policy Rule Engine | 3 | `list_policy_rules`, `set_policy_rule`, `reset_policy_rule` | Changes take effect on the next scan, no redeploy; read-only list has no audit entry |

Two entry points reach the same agent: the per-user detail card (bound to a real searched user) and a floating chat icon available on every page (bound to a fixed sentinel identity, no real user). The GenAI service enforces server-side which of the 57 tools each entry point may use — the 26 account-specific tools above (Account Operations, M365 Service Desk, and most M365 Governance Actions) are refused when invoked from the floating widget, since there is no real target user; the remaining groups work from either entry point.

Microsoft Graph integration is centralized in `services/genai/graph-client.js`. Local development uses a safe mock client unless `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, and `ENTRA_CLIENT_SECRET` are configured.

### Supporting GenAI Modules

| File | Purpose |
|---|---|
| `services/genai/validation.js` | Naming-convention/compliance-score pure functions; accepts policy overrides, falls back to hardcoded defaults |
| `services/genai/policy.js` | `POLICY_RULE_DEFS` — single source of truth for every admin-editable policy rule key, its category/type/default/description |
| `services/genai/csv.js` | Serializes query result rows to CSV for scheduled and on-demand report downloads |
| `services/genai/graph-client.js` | Microsoft Graph client wrapper with a real/mock switch |

---

## ETL & Scheduling

| Package | Version | Purpose |
|---|---|---|
| **node-cron** | ^3.0.3 | Cron-based scheduling for ETL pipeline runs |

Each ETL service is a long-running containerised process that:

1. Loads the SBERT model at startup
2. Reads source JSON data
3. Vectorises records in configurable batches (`BATCH_SIZE=64`)
4. Upserts into PostgreSQL with change detection
5. Sleeps until the next cron tick (`CRON_SCHEDULE=0 * * * *`)

---

## Containerisation & Orchestration

| Technology | Version / Image | Purpose |
|---|---|---|
| **Docker** | — | Container runtime for all services |
| **Docker Compose** | v2 (multi-file) | Service orchestration via 9 compose fragments |
| **node:22** | Official Docker image | Base image for all 9 service containers |
| **pgvector/pgvector:pg15** | Official image | Postgres + pgvector extension |
| **ollama/ollama** | Official image | LLM inference server (local dev only) |

### Compose Fragments

| File | Services Defined |
|---|---|
| `docker-compose.postgres.yml` | postgres |
| `docker-compose.app.yml` | app |
| `docker-compose.genai.yml` | genai, ollama |
| `docker-compose.etl-ad-line.yml` | etl-ad-line |
| `docker-compose.etl-netforum-line.yml` | etl-netforum-line |
| `docker-compose.etl-eu-line.yml` | etl-eu-line |
| `docker-compose.etl-dg-line.yml` | etl-dg-line |
| `docker-compose.etl-m365-line.yml` | etl-m365-line |
| `docker-compose.etl-sp-line.yml` | etl-sp-line |

---

## Testing

| Tool | Version | Purpose |
|---|---|---|
| **Jest** | ^29.0.0 | Unit and data-shape test runner |

Tests cover:

- Query parser logic (source aliases, intersection detection, attribute filters, preprocessing)
- GenAI validation module (safe identifiers, target system validation, SQL injection prevention)
- ETL data-shape validation for all 6 source datasets

---

## Linting & Code Quality

| Tool | Version | Purpose |
|---|---|---|
| **ESLint** | ^9.39.3 | JavaScript linting (flat config format) |
| **@eslint/js** | ^10.0.1 | ESLint recommended rule set |
| **markdownlint-cli** | ^0.32.0 | Markdown documentation lint |

---

## Data Generation

| Script | Language | Purpose |
|---|---|---|
| `generate_synthetic.py` | Python | Generates synthetic user records across all 6 source systems |
| `seed_change_logs.py` | Python | Generates realistic historical change-log and ETL-job-log data |
| `seed_change_logs.sql` | SQL | Output of seed script, applied via `docker exec` |

---

## Documentation

| Tool | Purpose |
|---|---|
| **Mermaid** | Diagrams (C4, ER, sequence, state, flowchart) embedded in Markdown |
| **Markdown** | All documentation in `docs/` directory |

---

## Vector Search Pipeline (end to end)

```text
Source JSON → ETL service → SBERT (all-MiniLM-L6-v2) → 384-dim vector
  → PostgreSQL + pgvector → HNSW index (cosine distance)
  → Stored procedure (sp_search_all_sources / sp_search_filtered)
  → Express API → Browser
```

## Agent Pipeline (end to end)

```text
User prompt → Express API → Ollama (qwen2.5:3b) → Tool call decision
  → Tool executor → PostgreSQL action, Graph mock (graph-client.js), or access_requests table
  → Ticket / access request when required
  → Tool result → Ollama (follow-up) → Natural-language reply → Browser
```
