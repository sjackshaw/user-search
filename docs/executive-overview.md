# User Search — Executive Overview

## The Problem

Today, user account data is spread across six independent systems — Active Directory, netForum, External Users, Distribution Groups, M365 Group Memberships, and SharePoint Permissions — each owned and maintained by different teams. There is no single view of a user, and no single team that can resolve a cross-system issue end to end.

When a support request comes in, the central support team must first identify which systems are involved, then route the request to the appropriate team. That team frequently discovers the issue spans one or two additional systems, triggering further handoffs. Each handoff introduces delay, context loss, and coordination overhead. In practice this means a routine user issue — an account that needs provisioning across systems, a password reset, a group membership change — can stall active delivery work across multiple teams for hours or days while ownership bounces between groups.

**This is the status quo: a user problem that should take minutes routinely blocks in-progress work across teams.**

---

## The Solution

User Search is a proof-of-concept platform that consolidates all six lines of user data into a single searchable interface backed by AI. It was built to demonstrate — with working code and synthetic data — that two capabilities can eliminate the multi-team handoff problem:

1. **Intelligent Search** — A support analyst types a name, an email fragment, or a plain-English description of the issue. The system uses vector search (semantic similarity, not just keyword matching) to surface every related record across all six data sources instantly. The analyst sees the complete picture — Active Directory status, netForum membership, group memberships, activity logs, permissions — in one place, without asking another team.

2. **AI-Powered Actions** — From that same view, the analyst can issue natural-language instructions to an AI agent: *"Provision a netForum account for this user," "Reset this user's MFA," "Show stale guest accounts," "Explain this Conditional Access block."* The agent executes the action or governance lookup, creates auditable tickets for write operations and sensitive reads, and confirms the result. No handoff required.

The result is that the **first-line support team can both diagnose and resolve** the majority of user issues that currently require multi-team coordination.

---

## How It Works

For the technology leaders in the room, a brief look under the hood:

| Layer | What It Does | Technology |
|---|---|---|
| **Data Ingestion (ETL)** | Six automated pipelines pull user data from each source system on a scheduled basis, detect changes, and load records into a central database. Each record is converted into a numerical vector (embedding) that captures its semantic meaning. | Node.js services, PostgreSQL with pgvector, SBERT embeddings (all-MiniLM-L6-v2) |
| **Search** | When an analyst searches, the query is converted into the same vector space and matched against all records using cosine similarity. This enables fuzzy, context-aware matching — not just exact keyword hits. Cross-source intersection queries show which systems a user exists in and where gaps are. | pgvector HNSW indexes, stored procedures, Express API |
| **AI Agent** | A large language model receives the analyst's request along with the user's data context. It determines the correct tool across account operations, Microsoft 365 service desk actions, and governance checks, then responds in plain English. Write actions and sensitive reads generate service tickets for audit. | Ollama `qwen2.5:3b` (local dev only); Amazon Bedrock (production), LLM tool-calling, 28 integrated tools, Microsoft Graph client |
| **Application** | A web interface where analysts search for users, view consolidated records, and interact with the AI agent — all in one screen. | Express, server-rendered UI |

All components run as Docker containers and can be started with a single command.

---

## Feasibility and Path to Production

This is not a slide deck. The proof of concept is fully functional with synthetic data that mirrors real-world structures and volumes. Detailed, step-by-step plans are already documented for two critical transitions:

- **Real Data Integration** — The ETL pipelines are designed to swap synthetic JSON files for live API connections (Microsoft Graph for Entra ID/M365, netForum REST API, Exchange, SharePoint). A production implementation guide covers credential management, authenticated API calls, and error handling for every source system.

- **AWS Cloud Deployment** — A phased migration plan moves each component to managed AWS services: PostgreSQL moves to Amazon RDS, the six ETL pipelines become AWS Lambda functions triggered by EventBridge, the application runs on Amazon EKS behind a load balancer, and the AI model calls Amazon Bedrock for managed LLM inference. The plan covers networking, security, secrets management, and cost estimates.

Both plans are included in the repository documentation and are ready for engineering estimation and scheduling.

---

## Business Impact

### Immediate Value: Unblocking Delivery

The direct benefit is operational. When the central support team can resolve user issues without routing to two or three other teams:

- **Delivery teams stay focused.** Work in progress is no longer interrupted by support requests that require their involvement.
- **Resolution time drops dramatically.** What currently takes hours or days of coordination becomes a single session in one tool.
- **Accountability is clear.** Every action is ticketed and auditable — no more requests lost between teams.

This is not a marginal improvement. For any organization where user account management spans multiple systems and teams, this eliminates a structural bottleneck.

### Strategic Value: A Reusable Template

The architecture — ingest data from multiple sources, vectorize it, serve a unified search interface, and layer AI actions on top — is not specific to user accounts. **The same pattern applies wherever teams need to search across fragmented data.**

A natural next application is **member search**: consolidating all lines of member data into a single view, similar to what this platform does for users, but extending to include specialized data such as:

- Cyber goals
- Form 7
- Certification and credential records
- Engagement and activity history across systems

The same technology stack — ETL pipelines for ingestion, PostgreSQL with pgvector for storage and search, an AI agent for natural-language interaction — would power that solution with minimal architectural change. The patterns, code structure, and deployment approach proven here transfer directly.

This positions the platform not as a one-off tool but as a **foundation for intelligent data consolidation** across the organization.

---

## Summary

| | Today | With User Search |
|---|---|---|
| **Finding a user across systems** | Manual checks across 6 systems, or ask each team | One search, all sources, instant results |
| **Resolving a cross-system issue** | 2–4 team handoffs over hours/days | First-line analyst resolves it in minutes |
| **Impact on delivery teams** | Regularly pulled off project work for support | Support is self-contained; delivery continues |
| **Extending to new data domains** | Build from scratch each time | Reuse proven architecture with new data sources |

The proof of concept is built, documented, and ready for review. The conversation now is about scheduling the transition to real data and cloud infrastructure.

---

*For detailed technical documentation, see the full [documentation index](README.md) including architecture diagrams, ETL pipeline specifications, security reviews, and AWS migration plans.*
