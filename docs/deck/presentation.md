---
marp: true
theme: default
paginate: true
size: 16:9
title: User Search — Identity Toolkit
---

<!--
This file is written in Marp markdown so it can be converted directly to a
PowerPoint deck:

  npx @marp-team/marp-cli docs/deck/presentation.md -o presentation.pptx

Each "---" below starts a new slide. Source content is condensed from the
companion documents in this folder: problem.md, solution.md, benefits.md,
and aiusage.md. Update this file whenever those source documents change materially.
-->

# User Search — Identity Toolkit

Semantic search, AI-powered actions, and governance in one dashboard — built in-house, proof of concept validated

**Executive & Technical Leadership Briefing**
October 2026

---

## Agenda

1. The problem
2. What we built
3. How the technology works
4. AI usage — what's real ML vs. rule-based
5. Cost & benefits
6. Production path
7. Recommendation & next steps

---

## The Problem

- Identity data fragmented across **six systems**: Active Directory, netForum, External Users, Distribution Groups, M365 Groups, SharePoint
- No unified search — support staff check each system manually, one at a time
- No cross-system actions — account provisioning, MFA reset, or permission changes require hand-offs across teams
- No governance visibility — compliance gaps discovered at audit time, not continuously
- Result: 6–20 cross-system requests per week, 1–4 hours per request, 2–3 teams involved per issue

---

## Impact

| Dimension | Effect |
|---|---|
| Support efficiency | 1,000+ hours/year lost to coordination handoffs alone |
| Delivery team interruptions | Multiple weekly interruptions @ 15–30 min refocus cost each |
| Mean resolution time | 1–4 hours per request; no single person can finish |
| Compliance risk | Gaps discovered reactively; no continuous monitoring |
| Team morale | Delivery engineers pulled into repetitive support work |

---

## What We Built

Three member-facing applications over one shared, semantic search layer:

| Application | Who | What |
|---|---|---|
| **User Search** | Support analysts | Semantic search across all 6 systems; unified identity view |
| **AI Agent Chat** | Support analysts | Execute 57 actions in plain English; automatic ticket logging |
| **Compliance Dashboard** | Governance & compliance | Live posture score, violation detection, auto-proposed fixes (human-approved) |

All three are served by a single unified service — one team, one codebase, one deployable unit.

---

## How Semantic Search Works

- Keyword search fails when the query and the record use different terminology
- **Embeddings** convert names, emails, descriptions into a 384-number vector that encodes *identity context*
- Records and queries are embedded with the same model; the system finds matches *closest in meaning*, not spelling
- A query like *"Jane Smith, contractor"* reliably finds the right person across all six systems without exact name match

---

## How the AI Agent Works

1. **Retrieve** — semantic search gathers identity context (name, email, systems, current state)
2. **Decide** — the agent examines the user's request and picks from 57 available tools (create account, reset MFA, add to group, revoke access, etc.)
3. **Act** — the agent executes the action, logs an auditable ticket, streams confirmation back in plain English

The agent cannot perform unlisted actions — it is constrained to tools that already exist in the organization.

---

## Data Pipelines

Three automated ETL pipelines keep the search index current — no manual re-indexing:

| Pipeline | Source | Content |
|---|---|---|
| Active Directory ETL | Microsoft Graph API | Users, groups, membership |
| netForum ETL | netForum vendor API | External users, roles, status |
| Permissions ETL | SharePoint Online | Site access, group permissions, owners |

Each pipeline syncs every 6–12 hours, generates embeddings, and updates the shared vector index — idempotent and incremental.

---

## Safety: Action Approval & Audit

Every AI action is subject to a deterministic approval workflow:

- User requests an action in plain English (e.g., "reset their MFA")
- Agent constructs the action, shows the operator the details
- **Human clicks approve before anything runs**
- Action executes; audit ticket is logged with full context

All decisions are reviewable. No action is ever automatic.

---

## AI Usage — What's Really "AI" Here

| Component | Type | PoC Technology | Production Technology |
|---|---|---|---|
| Text embedding | ML model | BGE-small (ONNX, in-process) | Cohere Embed v3 via AWS Bedrock |
| Vector search | Algorithm (HNSW) | pgvector on PostgreSQL | OpenSearch or Aurora + pgvector |
| Agent reasoning | LLM | Qwen 2.5 3B via Ollama | Claude Sonnet via Bedrock |
| Action validation | Rule-based | Tool schema matching | Same pattern, extended |
| Escalation detection | Rule-based regex | Pattern matching | Same pattern; candidate for ML at scale |

Two ML models provide understanding; rule-based systems enforce safety and auditability.

---

## Proof of Concept vs. Production

| Dimension | Proof of Concept | Production |
|---|---|---|
| Data | Synthetic 20,000 identities | Live Microsoft Graph, netForum, SharePoint APIs |
| Embedding | BGE-small, CPU, in-process (384d) | Cohere Embed v3 via Bedrock (1024d) |
| Language model | Qwen 2.5 3B, local Ollama | Claude Sonnet via Bedrock |
| Vector store | PostgreSQL + pgvector | Aurora + pgvector or OpenSearch Serverless |
| Compute | Docker Compose on a laptop | AWS Lambda + EKS |
| Auth | Open in local dev; API key | SAML via Entra ID, role-based access control |
| Cost | ~$0 (local) | ~$3,500/year |

---

## Cost — Direct AWS Running Cost

| Configuration | Production (annual) |
|---|---|
| Lambda + Aurora + Claude Sonnet (recommended) | ~$3,500 |
| Lambda + Aurora + Claude Haiku (cost-optimized) | ~$2,200 |

**Fixed infrastructure cost** — scales with query volume, not user count. No per-user licensing.

---

## Cost — Avoided Costs

| Item | Why it's not a new cost |
|---|---|
| Directory licensing | Active Directory, M365 already deployed |
| Authentication infrastructure | Entra ID SSO already in place |
| Search/AI vendor platform | No third-party product introduced |
| External development labour | Built in-house — no contractors required |
| System-of-record changes | All six source systems remain unchanged |

---

## Cost — vs. Buying a Vendor Platform

| Product Category | Est. Annual Cost (org-wide) |
|---|---|
| Enterprise identity search (Okta, Ping, Sailpoint) | ~$120,000 – $360,000 |
| AI agent automation (Automation Anywhere, UiPath) | ~$80,000 – $200,000 |
| **This solution (AWS, in-house)** | **~$3,500** |

**5-year total: ~$17,500 (this solution) vs. $1,000,000–$2,800,000 (vendor platforms)**

---

## Cost — vs. Hiring Contractors

| Item | In-House | Contractor |
|---|---|---|
| Development labour | Existing team (already budgeted) | $150,000 – $250,000 upfront |
| Time to start | Immediately — PoC already built | 6–12 weeks sourcing delay |
| Year 2–3 maintenance | Existing team | $40,000 – $80,000/year |
| Knowledge retention | Stays with the team | Leaves with the contractor |
| **3-year total** | **~$15,000** | **$230,000 – $410,000** |

---

## Operational & Strategic Benefits

**Operational**
- Support analysts resolve tickets in one sitting — no handoffs
- Delivery teams reclaim ~250–300 hours/year from interruptions
- Full audit trail of every action (who, when, what, why)
- Real-time compliance visibility instead of annual audit

**Strategic**
- First in-house AI agent deployment — reusable patterns for future automation
- Demonstrates responsible AI: constrained actions, human approval, full auditability
- Reduces dependency on vendor roadmaps for identity management

---

## Production Architecture

- **Compute**: AWS Lambda + API Gateway (serverless); Amazon EventBridge for ETL scheduling
- **Data**: Aurora PostgreSQL + pgvector; S3 for staging
- **Auth**: SAML single sign-on through Entra ID via ALB OIDC — no new infrastructure
- **Security**: Private VPC subnets, AWS WAF, Secrets Manager, CloudTrail, GuardDuty, automatic action approval

---

## Migration Phases

| Phase | Deliverable |
|---|---|
| 1 | Data layer: Aurora + S3; API connectors for Microsoft Graph and netForum |
| 2 | ETL pipelines against live sources; EventBridge orchestration |
| 3 | Search API live on Lambda — early analyst value |
| 4 | AI agent with action execution and audit logging |
| 5 | Compliance dashboard with violation detection + proposed fixes |
| 6 | Production hardening: WAF, GuardDuty, CloudTrail, CI/CD, load testing |

Each phase is independently deliverable — member value starts after Phase 3.

**Timeline: 10–15 weeks for one engineer; 6–9 weeks with two in parallel**

---

## Recommendation

- The proof of concept demonstrates the technology is mature, deployable, and cost-predictable
- Direct running cost (~$3,500/year) is a fraction of vendor platforms or a contractor build
- No new licensing, authentication, or system-of-record investment required
- **Recommend proceeding to Phase 1** (data layer + connector setup) to begin the production path
- Full technical implementation plans are documented in the repository

---

# Questions?

**Companion documents:**
[The Problem](problem.md) · [The Solution](solution.md) · [How AI Is Used](aiusage.md) · [Benefits](benefits.md)
