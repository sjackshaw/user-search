# GenAI Architecture (C4 Container — Current State)

> Current local state: 7 ETL lines, 28 user-card agent tools, Graph mock fallback for local development, and a separate claims ETL line for the planned Member Benefits Bot. See `docs/next-steps/agentic-ai-expansion.md` for the remaining production-hardening work.

```mermaid
graph TB
    classDef person fill:#08427B,stroke:#073B6F,color:#fff
    classDef existing fill:#1168BD,stroke:#0E5BA7,color:#fff
    classDef genai fill:#D4451A,stroke:#B83A15,color:#fff
    classDef database fill:#2D882D,stroke:#226622,color:#fff
    classDef external fill:#999999,stroke:#6B6B6B,color:#fff

    User["👤 IT Administrator"]:::person

    subgraph DockerPlatform [" Docker Platform — user-search "]
        direction TB

        App["📦 App Container<br/><br/>Node.js 22 / Express<br/>Search UI + Chat UI + SBERT<br/>SSE streaming proxy<br/>Port 3000"]:::existing

        GenAI["🤖 GenAI Service<br/><br/>Node.js 22<br/>28 user-card tools<br/>Graph mock fallback<br/>Tool calling + ticket audit<br/>Port 3001"]:::genai

        Ollama["🧠 Ollama Container<br/><br/>qwen2.5:3b<br/>Local LLM inference<br/>Port 11434"]:::genai

        Postgres["🗄️ PostgreSQL + pgvector<br/><br/>Search + claims tables<br/>HNSW vector indexes<br/>+ etl_job_logs<br/>+ source_change_logs<br/>+ chat_messages<br/>+ agent_tickets"]:::database

        subgraph ETLServices [" 7 ETL Line Services "]
            ETL_AD["etl-ad-line<br/>active_directory + activity_logs"]:::existing
            ETL_NF["etl-netforum-line<br/>netforum_members + activity_logs"]:::existing
            ETL_EU["etl-eu-line<br/>external_users + activity_logs"]:::existing
            ETL_DG["etl-dg-line<br/>distribution_groups + sync_logs"]:::existing
            ETL_M365["etl-m365-line<br/>m365_group_memberships + change_logs"]:::existing
            ETL_SP["etl-sp-line<br/>sharepoint_permissions + change_logs"]:::existing
            ETL_CLAIMS["etl-claims-line<br/>claims + claims_logs"]:::existing
        end
    end

    HF["Hugging Face Hub"]:::external

    User -->|"Search queries"| App
    User -->|"Natural language questions<br/>'What changed for jsmith last week?'"| App
    App -->|"Search API + SBERT embeddings"| Postgres
    App -->|"Chat proxy SSE stream<br/>POST /api/chat"| GenAI
    GenAI -->|"RAG context retrieval"| Postgres
    GenAI -->|"Vector search /api/search"| App
    GenAI -->|"LLM inference"| Ollama
    GenAI -->|"Persist conversation"| Postgres
    ETL_AD -->|"Vectors + change logs"| Postgres
    ETL_NF -->|"Vectors + change logs"| Postgres
    ETL_EU -->|"Vectors + change logs"| Postgres
    ETL_DG -->|"Vectors + change logs"| Postgres
    ETL_M365 -->|"Vectors + change logs"| Postgres
    ETL_SP -->|"Vectors + change logs"| Postgres
    ETL_CLAIMS -->|"Benefits claim vectors + logs"| Postgres
    App -.->|"SBERT model weights"| HF
```
