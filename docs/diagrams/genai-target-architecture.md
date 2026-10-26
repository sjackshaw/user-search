# GenAI Architecture (C4 Container — Current State)

> Current local state: 6 ETL lines, 57 agent tools across 11 groups (account operations, M365 service desk, lifecycle management, access requests, department templates, governance detection & remediation, violation tracking, compliance reporting, policy rule engine, M365 governance actions, ticketing), reachable from a per-user detail card or a floating chat icon (no user context) with server-side tool scoping between the two, Microsoft Graph mock fallback for local development.

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

        App["📦 App Container<br/><br/>Node.js 22 / Express<br/>Search UI + dashboard panels<br/>(Compliance/Trends/Reports/Policy)<br/>+ floating agent widget<br/>Chat proxy → GenAI<br/>Port 3000"]:::existing

        GenAI["🤖 GenAI Service<br/><br/>Node.js 22<br/>57 tools across 11 groups<br/>Policy engine + CSV reports<br/>Graph mock fallback (local dev)<br/>agent_tickets + access_requests audit<br/>Port 3001"]:::genai

        Ollama["🧠 Ollama Container<br/><br/>qwen2.5:3b<br/>Local LLM inference<br/>Port 11434"]:::genai

        Postgres["🗄️ PostgreSQL + pgvector<br/><br/>Search tables<br/>HNSW vector indexes<br/>+ etl_job_logs<br/>+ source_change_logs<br/>+ chat_messages<br/>+ agent_tickets<br/>+ access_requests<br/>+ governance_violations<br/>+ scheduled_reports<br/>+ policy_rules"]:::database

        subgraph ETLServices [" 6 ETL Line Services "]
            ETL_AD["etl-ad-line<br/>active_directory + activity_logs"]:::existing
            ETL_NF["etl-netforum-line<br/>netforum_members + activity_logs"]:::existing
            ETL_EU["etl-eu-line<br/>external_users + activity_logs"]:::existing
            ETL_DG["etl-dg-line<br/>distribution_groups + sync_logs"]:::existing
            ETL_M365["etl-m365-line<br/>m365_group_memberships + change_logs"]:::existing
            ETL_SP["etl-sp-line<br/>sharepoint_permissions + change_logs"]:::existing
        end
    end

    HF["Hugging Face Hub"]:::external

    User -->|"Search queries"| App
    User -->|"Natural language questions<br/>'What changed for jsmith last week?'"| App
    App -->|"Search API + SBERT embeddings"| Postgres
    App -->|"Chat proxy POST /api/agent"| GenAI
    GenAI -->|"RAG context retrieval + ticket/request CRUD"| Postgres
    GenAI -->|"LLM inference"| Ollama
    GenAI -->|"Persist conversation"| Postgres
    ETL_AD -->|"Vectors + change logs"| Postgres
    ETL_NF -->|"Vectors + change logs"| Postgres
    ETL_EU -->|"Vectors + change logs"| Postgres
    ETL_DG -->|"Vectors + change logs"| Postgres
    ETL_M365 -->|"Vectors + change logs"| Postgres
    ETL_SP -->|"Vectors + change logs"| Postgres
    App -.->|"SBERT model weights"| HF
```
