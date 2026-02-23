# Docker Compose Service Topology

```mermaid
flowchart TB
    classDef infra fill:#2D882D,stroke:#226622,color:#fff
    classDef app fill:#1168BD,stroke:#0E5BA7,color:#fff
    classDef etlLine fill:#A86CC1,stroke:#8B5BA3,color:#fff
    classDef volume fill:#E8A735,stroke:#C48E2C,color:#000

    subgraph net ["Docker Network: user-search-net"]
        direction TB

        PG["🗄️ postgres\npgvector/pgvector:pg15\nPort 5432"]:::infra

        APP["📦 app\nNode.js 18\nExpress + SBERT\nPort 3000:3000"]:::app

        subgraph etl_lines ["Line ETL containers (shared model + pool)"]
            direction LR
            C1["etl-ad-line\nprimary.json → active_directory\nlogs.json → ad_activity_logs"]:::etlLine
            C2["etl-netforum-line\nprimary.json → netforum_members\nlogs.json → nf_activity_logs"]:::etlLine
            C3["etl-eu-line\nprimary.json → external_users\nlogs.json → eu_activity_logs"]:::etlLine
            C4["etl-dg-line\nprimary.json → distribution_groups\nlogs.json → dg_sync_logs"]:::etlLine
        end
    end

    MC["📁 model-cache\nDocker Volume"]:::volume

    C1 & C2 & C3 & C4 -->|"SBERT model"| MC
    C1 & C2 & C3 & C4 -->|"INSERT + embedding"| PG
    APP -->|"SQL queries"| PG
    APP -->|"SBERT model"| MC

    C1 & C2 & C3 & C4 -.->|"depends_on: healthy"| PG
    APP -.->|"depends_on: healthy"| PG
```
