# Architecture Diagrams

Mermaid diagrams documenting the user-search platform architecture, data flows, and interactions. Rendered natively by GitHub, VS Code (with Mermaid extension), and most Markdown viewers.

## Diagram Index

| Diagram | File | Description |
|---|---|---|
| Analyst Workflow | [analyst-workflow.md](analyst-workflow.md) | End-to-end flow from support request to resolution — search, detail panel, AI agent action |
| AWS Target Architecture | [aws-target-architecture.md](aws-target-architecture.md) | Primary (EKS — App + ETL + GenAI on shared cluster + Bedrock) and Lambda fallback (native Node.js zip packages) |
| C4 System Context | [c4-system-context.md](c4-system-context.md) | Top-level view: users, the platform, and external systems |
| ETL Data Flow | [etl-data-flow.md](etl-data-flow.md) | End-to-end flow from synthetic JSON through transform → vectorize → pgvector (6 lines) |
| Search Sequence | [search-sequence.md](search-sequence.md) | Step-by-step sequence for `/api/search` requests (stored-procedure based) |
| Lookup Sequence | [lookup-sequence.md](lookup-sequence.md) | Step-by-step sequence for `/api/lookup` detail panel requests (10 sources) |
| Entity Relationship | [entity-relationship.md](entity-relationship.md) | Database tables, fields, and relationships across search and agent data |
| Docker Compose Topology | [docker-compose-topology.md](docker-compose-topology.md) | Service dependencies, volumes, and network topology (9 compose fragments) |
| ETL Job State | [state-etl-job.md](state-etl-job.md) | State machine for a single ETL job lifecycle |
| GenAI Architecture | [genai-target-architecture.md](genai-target-architecture.md) | C4 container diagram — local dev GenAI platform architecture, including the 37-tool agent, Microsoft Graph mock fallback, and ticketing/access-request flow |

## Conventions

- **C4 standards**: System Context → Container → Component layering with color-coded stereotypes
- **Color coding**: 🔵 Application containers · 🟣 ETL services · 🟢 Database/infra · 🟡 Volumes/sources · 🔴 New/planned · ⚪ External
- **Rendering**: All diagrams use [Mermaid](https://mermaid.js.org/) syntax in fenced code blocks
