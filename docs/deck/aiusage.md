# AI Usage Disclosure

This document identifies the AI tools used in the development of the User Search platform and in the creation of this documentation set.

---

## 1. AI Embedded in the Platform (Functional Use)

The User Search platform uses AI as a core functional component, not as a development aid. The following models are part of the running system:

### Sentence Embedding Model — all-MiniLM-L6-v2 (SBERT)

| Attribute | Detail |
|---|---|
| **Model** | `Xenova/all-MiniLM-L6-v2` |
| **Provider** | Hugging Face (weights downloaded on first run) |
| **Runtime** | ONNX Runtime via `@xenova/transformers` — runs entirely in-process, no external API call |
| **Purpose** | Converts user records and search queries into 384-dimensional semantic vectors. Used by all 6 ETL pipelines at ingestion time and by the App service at query time. |
| **Data processed** | User names, email addresses, notes, and activity log text from all 6 source systems |

### Large Language Model — Local Development

| Attribute | Detail |
|---|---|
| **Model** | `qwen2.5:3b` |
| **Provider** | Ollama (self-hosted, local only) |
| **Purpose** | Powers the 57-tool AI agent during local development and demonstration. Interprets natural-language instructions from the analyst and decides which tool to invoke. |
| **Data processed** | User data context from the local Postgres database (synthetic data in the PoC) and analyst-supplied prompts |
| **Scope** | Local development only — not used in production |

### Large Language Model — Production

| Attribute | Detail |
|---|---|
| **Model** | To be determined via formal LLM review (candidates: Anthropic Claude 3 Haiku, Amazon Nova Pro) |
| **Provider** | Amazon Bedrock |
| **Purpose** | Replaces Ollama in the production deployment. Same tool-calling interface; model selection pending evaluation of accuracy, latency, and cost at the target token volume. |
| **Data processed** | User data context retrieved from RDS (live identity records) and analyst-supplied prompts |
| **Scope** | Production only |

### Microsoft Graph API

| Attribute | Detail |
|---|---|
| **Service** | Microsoft Graph API (`graph.microsoft.com`) |
| **Provider** | Microsoft |
| **Purpose** | Executes M365 service desk and governance actions on behalf of agent tool calls (MFA, licenses, mailbox, Teams, OneDrive, Conditional Access, device compliance, BitLocker). |
| **Scope** | Production only when Entra ID credentials are configured. Local development uses a safe mock client. |

---

## 2. AI Used for Code and Documentation

The following AI tools were used in the creation and update of the code and documentation in this repository.

### GitHub Copilot — Claude Sonnet 4.6 / 5

| Attribute | Detail |
|---|---|
| **Tool** | GitHub Copilot, used in multiple agent modes across this project's development (general coding agent and a dedicated doc-specialist mode) |
| **Model** | Claude Sonnet 4.6 (Anthropic) and Claude Sonnet 5 (Anthropic), accessed via GitHub Copilot |
| **Provider** | GitHub / Anthropic |
| **What it actually did** | Autonomous, human-directed implementation work across the full stack: database schema design and migration ordering (`infra/db/init/*.sql`), backend logic in `services/genai/index.js` and `services/app/src/index.js` (governance detection, the configurable policy engine, approval-gated remediation workflow, compliance scoring, scheduled reporting), front-end UI (`services/app/src/public/index.html` — dashboard panels, drill-down overlays, the floating agent widget), Docker deployment and debugging, Jest test authoring, and the documentation set in `docs/` (including this file). |
| **Human oversight** | Every change was driven by an explicit, iterative human prompt and reviewed before being deployed; nothing was generated and shipped unattended. Destructive or irreversible actions (data wipes, deployments) were confirmed with the human operator before execution. |

This is a more complete and accurate disclosure than earlier drafts of this document, which described Copilot's role as limited to "doc-specialist agent mode" — that undersold the extent of AI-assisted code generation that produced the governance, policy, remediation, reporting, and dashboard features described in [solution.md](solution.md).

---

## 3. AI Used in Platform Development

The platform codebase's earliest version predates the development session(s) covered by the disclosure in Section 2. Other AI-assisted development tools may have been used during that earlier work; this disclosure covers only what is known and directly observable at the time of writing (GitHub Copilot activity on this repository, as described above).

---

*Last updated: 2 October 2026*
