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
| **Purpose** | Powers the 37-tool AI agent during local development and demonstration. Interprets natural-language instructions from the analyst and decides which tool to invoke. |
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
| **Tool** | GitHub Copilot (doc-specialist agent mode) |
| **Model** | Claude Sonnet 4.6 (Anthropic) and 5 (Anthropic), accessed via GitHub Copilot |
| **Provider** | GitHub / Anthropic |

---

## 3. AI Used in Platform Development

The platform codebase was developed prior to this documentation session. AI-assisted development tools may have been used during that work; this disclosure covers only what is known at the time of writing.

---

*Last updated: 3 August 2026*
