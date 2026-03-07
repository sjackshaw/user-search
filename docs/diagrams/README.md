# Architecture Diagrams

Mermaid diagrams documenting the user-search platform architecture, data flows, and interactions. Rendered natively by GitHub, VS Code (with Mermaid extension), and most Markdown viewers.

## Diagram Index

| Diagram | File | Description |
|---|---|---|
| C4 System Context | [c4-system-context.md](c4-system-context.md) | Top-level view: users, the platform, and external systems |
| C4 Container | [c4-container.md](c4-container.md) | All containers within the Docker platform and their relationships |
| ETL Data Flow | [etl-data-flow.md](etl-data-flow.md) | End-to-end flow from synthetic JSON through transform → vectorize → pgvector (6 lines) |
| Search Sequence | [search-sequence.md](search-sequence.md) | Step-by-step sequence for `/api/search` requests (stored-procedure based) |
| Lookup Sequence | [lookup-sequence.md](lookup-sequence.md) | Step-by-step sequence for `/api/lookup` detail panel requests (10 sources) |
| Entity Relationship | [entity-relationship.md](entity-relationship.md) | All 15 database tables, fields, and relationships |
| Docker Compose Topology | [docker-compose-topology.md](docker-compose-topology.md) | Service dependencies, volumes, and network topology (9 compose fragments) |
| Deployment Pipeline | [deployment-pipeline.md](deployment-pipeline.md) | Bootstrap + deployment sequence with quality gates |
| ETL Job State | [state-etl-job.md](state-etl-job.md) | State machine for a single ETL job lifecycle |
| GenAI Architecture | [genai-target-architecture.md](genai-target-architecture.md) | C4 container diagram — current GenAI platform architecture (9 tools, 6 action executors) |

## Conventions

- **C4 standards**: System Context → Container → Component layering with color-coded stereotypes
- **Color coding**: 🔵 Application containers · 🟣 ETL services · 🟢 Database/infra · 🟡 Volumes/sources · 🔴 New/planned · ⚪ External
- **Rendering**: All diagrams use [Mermaid](https://mermaid.js.org/) syntax in fenced code blocks
