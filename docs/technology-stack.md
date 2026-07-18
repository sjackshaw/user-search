# Technology Stack

A complete inventory of every technology, framework, library, model, and tool used in the User Search proof of concept.

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
| **PostgreSQL** | 18 | Primary relational data store |
| **pgvector** | Bundled with `pgvector/pgvector:pg18` | Vector similarity search extension |
| **vector(384)** | — | Column type storing 384-dimension embeddings |
| **HNSW indexes** | — | Approximate nearest-neighbour index (cosine distance) on 12 tables |
| **Stored procedures** | PL/pgSQL | All query logic (search, lookup, intersection, ETL job management) in `12_stored_procedures.sql` |

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
| **Ollama** | `qwen2.5:3b` | LLM inference for local development only — not used in production |
| **Amazon Bedrock** | Model TBD via LLM review (candidates: Claude 3 Haiku, Claude 3.5 Sonnet, Amazon Nova Pro) | Production LLM inference for the GenAI agent (tool calling, natural-language responses) |

Ollama runs as a sidecar Docker container (`ollama/ollama`) for local development only. The GenAI service communicates with it via the `/api/chat` REST endpoint with `stream: false`. In production, Ollama is replaced by Amazon Bedrock's `converse` API called from an EKS pod with IRSA permissions (`bedrock:InvokeModel`).

### Key LLM Parameters (local dev — Ollama)

| Parameter | Value |
|---|---|
| Temperature | 0.3 |
| Context window | 4096 tokens |
| Tool calling | Ollama native tool-call interface |

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
| **node:22** | Official Docker image | Base image for all 8 service containers |
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

## Data Generation (PoC only)

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

```
Source JSON → ETL service → SBERT (all-MiniLM-L6-v2) → 384-dim vector
  → PostgreSQL + pgvector → HNSW index (cosine distance)
  → Stored procedure (sp_search_all_sources / sp_search_filtered)
  → Express API → Browser
```

## Agent Pipeline (end to end)

**Local development (Ollama):**
```
User prompt → Express API → Ollama (qwen2.5:3b) → Tool call decision
  → Tool executor → PostgreSQL action → Ticket created
  → Tool result → Ollama (follow-up) → Natural-language reply → Browser
```

**Production (Amazon Bedrock):**
```
User prompt → Express API (EKS pod) → Bedrock converse API → Tool call decision
  → Tool executor → RDS action (via RDS Proxy) → Ticket created
  → Tool result → Bedrock (follow-up) → Natural-language reply → Browser
```
