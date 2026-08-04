# Technical Solution: User Search Platform

---

## What Was Built

User Search is a fully functional proof of concept that consolidates six identity and access systems into a single searchable interface, with an AI agent that can diagnose and action the majority of user issues without a handoff. The platform is designed to expand — additional source systems can be added as new ETL lines without architectural change, making it straightforward to include further high-value targets as they are identified.

**Analyst workflow:** [docs/diagrams/analyst-workflow.md](../diagrams/analyst-workflow.md)

It was built to answer one question: **can first-line support resolve cross-system user issues without routing to specialist teams?** The answer is yes — and this is the working code that proves it.

---

## How It Addresses the Problem

| Problem (from [problem.md](problem.md)) | Solution |
|---|---|
| No single view of a user across 6 systems | Unified search returns records from all sources in one query |
| 1–4 hours to resolve a multi-team handoff | First-line analyst diagnoses and acts in a single session |
| 2–3 teams looped in per issue | 37 agent tools cover the full action surface — no handoff required |
| Delivery teams interrupted multiple times per week | Support is self-contained; delivery teams are not the resolution path |
| No cross-system change history | Consolidated change log across all ETL sources with field-level diffs |
| Stale accounts, drifting access | Governance tools surface inactive licenses, stale guests, and consent anomalies |

---

## Architecture

The platform has four layers. Each is independently deployable and replaces a manual step in the current support workflow.

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 4 — AI Agent                                              │
│  Natural-language instructions → tool execution → audit ticket   │
├──────────────────────────────────────────────────────────────────┤
│  Layer 3 — Application                                           │
│  Unified search UI + detail panel + change history               │
├──────────────────────────────────────────────────────────────────┤
│  Layer 2 — Database                                              │
│  PostgreSQL + pgvector  ·  16 tables  ·  HNSW vector indexes     │
├──────────────────────────────────────────────────────────────────┤
│  Layer 1 — ETL Pipelines                                         │
│  6 automated ingestion services  ·  hourly  ·  change detection  │
└──────────────────────────────────────────────────────────────────┘
```

### Layer 1 — ETL Pipelines

Six automated services run on an hourly schedule. Each service:

1. Reads source data for one system (Active Directory, netForum, External Users, Distribution Groups, M365 Group Memberships, SharePoint Permissions)
2. Detects creates, updates, and deletes since the last run
3. Converts each record into a 384-dimensional semantic vector using the SBERT `all-MiniLM-L6-v2` model
4. Upserts records into the central database and logs every detected change with field-level diffs

The same pipeline also ingests activity logs (who changed what, when, and why) for each source. These are vectorised alongside primary records, making historical events searchable.

**In production:** source data feeds come from live API connections — Microsoft Graph for AD/M365, netForum REST API, Exchange, SharePoint REST. The pipeline structure does not change; only the data source swaps from file to API.

### Layer 2 — Database

A single PostgreSQL database with the `pgvector` extension holds all 16 tables. Key design decisions:

| Decision | Rationale |
|---|---|
| Vector columns on every searchable table | Enables semantic similarity search on every source without a separate vector store |
| HNSW indexes (cosine distance) | Sub-millisecond approximate nearest-neighbour lookup at the volumes involved (~20,000 records) |
| Stored procedures for all query logic | Query logic lives in the database, not scattered across application code; easier to test and tune |
| Change log table (`source_change_logs`) | Centralised, cross-source audit trail — one query covers all systems |
| Agent tables (`agent_tickets`, `access_requests`) | Every agent write action and access request is persisted for audit, independent of whether an ITSM system is connected |

### Layer 3 — Application

A browser-based interface served by a Node.js Express application. Analysts do not need to learn any query syntax — the interface accepts plain-text input.

**Search** — the analyst types a name, email fragment, or a plain-English description (e.g. "Jane Smith contractor"). The query is encoded into the same vector space as the stored records and matched using cosine similarity across all source tables simultaneously. Results show which systems a user exists in, with source badges.

**Detail panel** — clicking a result runs a parallel lookup across all 10 source views (primary records + activity/sync logs + SharePoint permissions + M365 memberships). The analyst sees the user's complete picture: account status, group memberships, permissions, and a chronological change history with field-level diffs, without switching systems.

**Intersection search** — the analyst can ask "show me users in AD but not in netForum" or "show me external users with SharePoint access". Cross-source intersection queries are handled by a stored procedure that accepts include/exclude arrays.

### Layer 4 — AI Agent

An LLM-powered agent embedded in the detail panel. The analyst describes what they need in plain English; the agent selects the appropriate tool, executes it, and responds in plain English. Every write action and sensitive read creates an auditable ticket.

**37 tools across 7 groups:**

| Group | Tools | Who uses it |
|---|---|---|
| Account Operations | Provision, disable, reset password, update attributes, add to distribution/M365 group | First-line support |
| M365 Service Desk | MFA reset/status, license assign/remove, mailbox access, aliases, out-of-office, Teams channel, OneDrive | First-line support |
| Governance | Inactive licenses, stale guests, guest revocation, risky-user dismissal, app consents, Conditional Access, device compliance, BitLocker recovery | IT governance / security |
| Lifecycle Management | Full onboarding workflow, full offboarding workflow, post-disable deprovisioning cascade, bulk operations | HR / IT transitions |
| Access Requests | Submit, list, and approve self-service access requests | End users + approvers |
| Department Templates | Apply pre-defined license + group bundles for 8 department roles | Onboarding teams |
| General / Ticketing | Create tickets, list open tickets, describe capabilities | All |

**Local development:** The agent uses Ollama running `qwen2.5:3b` locally — no internet connection or cloud credentials required. This makes the PoC fully self-contained.

**Production:** Ollama is replaced by Amazon Bedrock's managed LLM API (model to be selected via a formal LLM review — candidate options include Claude 3 Haiku and Amazon Nova Pro). No code restructuring is required; one function replaces the Ollama call.

**Microsoft Graph integration** is already wired in. When Entra ID credentials are provided, the Graph client switches from a safe local mock to the real Microsoft Graph SDK automatically. M365 actions (MFA, licenses, mailbox, Teams, OneDrive, governance) execute against the live tenant without any further code changes.

---

## Current State

The proof of concept is **fully functional**. Every component described above is built and running.

| Component | Status |
|---|---|
| 6 ETL pipelines | ✅ Built — running against synthetic data (~20,000 records across all sources) |
| Central database (16 tables, HNSW indexes, stored procedures) | ✅ Built |
| Unified search (vector, filtered, intersection) | ✅ Built |
| Detail panel with cross-source lookup and change history | ✅ Built |
| AI agent — all 37 tools | ✅ Built — executes against local database; Microsoft Graph mock in local dev |
| Agent tickets and access request tables | ✅ Built |
| Department access templates (8 departments) | ✅ Built |
| Microsoft Graph client (mock + real) | ✅ Built — switches on Entra credentials |
| Docker Compose full-stack startup | ✅ One command: `./startup/setup.sh` |
| Unit and data-shape tests | ✅ Jest test suite across query parser, agent validation, ETL data shapes |

**What the synthetic data covers:** ~6,000 AD accounts, 1,000 netForum members, 1,000 external users, 500 distribution groups, 200 M365 groups, 3,000 SharePoint permission records — plus activity logs, sync logs, and change logs for each source. The data is designed to mirror real-world structures and volumes.

---

## Path to Production

Three workstreams run in parallel. None require restructuring what is already built.

### Workstream 1 — Real Data (ETL connections)

Swap the synthetic JSON source files for live API connections. The ETL pipeline structure is unchanged; only the data-read step is updated per source.

| Source | API | Auth |
|---|---|---|
| Active Directory / Entra ID | Microsoft Graph API | App registration (client credentials) |
| M365 Groups | Microsoft Graph API | Same app registration |
| netForum | netForum REST API | API key |
| External Users | Existing data store / API | TBD |
| Distribution Groups | Exchange / Graph API | Same app registration |
| SharePoint | SharePoint REST / Graph API | Same app registration |

The Graph API credentials are the same ones used for Microsoft Graph agent actions — one app registration covers both ETL reads and agent writes.

### Workstream 2 — Cloud Deployment (AWS)

Move from Docker Compose to managed AWS infrastructure. Full migration plan in [aws-migration-plan.md](../next-steps/aws-migration-plan.md).

**Primary path (EKS):**

| Component | Local (now) | Production (EKS) |
|---|---|---|
| Database | PostgreSQL in Docker | Amazon RDS (PostgreSQL + pgvector), Multi-AZ |
| ETL | 6 Docker containers | 6 EKS Deployments or CronJobs on shared node group |
| App | Docker container | EKS Deployment, ALB Ingress, HTTPS via ACM |
| GenAI | Docker container + Ollama | EKS pod + Amazon Bedrock (replaces Ollama) |
| Secrets | `.env` file | AWS Secrets Manager |
| Images | Local Docker build | Artifactory (CI already configured) |

**Fallback path (Lambda):** If EKS is not available, both the App and all 6 ETL services deploy as native Node.js Lambda functions (zip packages, no ECR required). GenAI remains on EKS. Cost estimate: ~$234/month.

**Cost estimate — EKS + Bedrock (primary):** ~$295/month (RDS, EKS 3-node shared cluster, ALB, Bedrock at 50k tokens/day, S3, Secrets Manager).

### Workstream 3 — Access Control (SAML)

Enforce role-based access so that only authorised roles can invoke write and governance actions. Full plan in [saml-access-management.md](../next-steps/saml-access-management.md).

| Role | Access |
|---|---|
| `viewer` | Search, lookup, change history (all AD users by default) |
| `analyst` | Above + ETL status + read-only agent queries (inactive licenses, device compliance, etc.) |
| `operator` | Above + write actions (provision, reset, group management, M365 service desk, onboarding) |
| `admin` | All 37 tools including destructive actions (disable, offboard, BitLocker, governance writes) |

The Identity Provider is the existing corporate Active Directory / Entra ID — no new IdP required. Roles are not available from the SAML assertion and must be stored locally in a `user_roles` table, managed by an admin via a role management UI.

**Current auth state:** API key only (`x-api-key` header). SAML integration is documented and ready to build; it is a prerequisite for production go-live.

---

## Key Technical Decisions

| Decision | Alternative considered | Why this approach |
|---|---|---|
| **Vector search (pgvector + HNSW)** | Dedicated vector database (Pinecone, Weaviate) | Avoids an additional managed service; PostgreSQL already serves as the primary store; pgvector's HNSW performance is sufficient at 20,000-record volumes |
| **SBERT all-MiniLM-L6-v2** | OpenAI embeddings API | Runs entirely in-process (ONNX runtime); no external API call at query time; model weights ~80 MB; 384 dimensions is a practical balance of accuracy and index size |
| **LLM tool-calling for agent actions** | Rigid rule-based action routing | Natural language intent detection is more robust to phrasing variation than keyword matching; the LLM decides which tool applies, not a brittle if/else chain |
| **Stored procedures for all query logic** | ORM or inline SQL | Centralises and tests query logic independently of application code; simplifies switching Node versions or frameworks |
| **Node.js 22 across all services** | Mixed runtimes | Consistent toolchain, shared `@xenova/transformers` SBERT runtime, same Docker base image |
| **Mock → real Graph client switch** | Separate dev/prod codebases | A single `graph-client.js` module auto-detects credentials and switches mode; local dev runs safely with zero cloud access |

---

## What Is Not in Scope for This PoC

The following are documented, planned, and ready to build — but not implemented in the current proof of concept:

| Item | Status | Where documented |
|---|---|---|
| Live API connections for ETL sources | Not connected — synthetic data only | [genai-production-update.md](../next-steps/genai-production-update.md) |
| SAML authentication and RBAC | Not implemented — API key only | [saml-access-management.md](../next-steps/saml-access-management.md) |
| ITSM ticket integration (ServiceNow/Jira) | Not connected — local Postgres table | [agentic-ai-expansion.md](../next-steps/agentic-ai-expansion.md) |
| Amazon Bedrock LLM (production model) | Not selected — awaiting LLM review | [aws-migration-plan.md](../next-steps/aws-migration-plan.md) |
| AWS cloud infrastructure | Not provisioned — Docker only | [aws-migration-plan.md](../next-steps/aws-migration-plan.md) |

None of these are architectural unknowns. Each has a defined integration point, a documented implementation approach, and working surrounding code.

---

## Summary

| | Detail |
|---|---|
| **What is built** | Fully functional PoC — search, detail panel, change history, 37-tool AI agent, all running on synthetic data |
| **What it replaces** | 2–3 team handoff chains for the majority of user support requests |
| **Lines of code** | ~3,000 (GenAI service) + ~500 (App) + ~400 per ETL line |
| **Time to start (local)** | `./startup/setup.sh` — single command, full stack |
| **Production cost estimate** | ~$295/month (EKS + Bedrock) or ~$234/month (Lambda fallback) |
| **Production blockers** | Live data connections, SAML auth, Bedrock model selection |
| **Architecture reuse** | The same pattern (ETL → pgvector → unified search → AI agent) transfers directly to member search and other data consolidation problems |

*Full technical documentation: [docs/README.md](../README.md)*
