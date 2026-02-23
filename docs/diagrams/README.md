# Architecture Diagrams

Mermaid diagrams documenting the user-search platform architecture, data flows, and interactions. Rendered natively by GitHub, VS Code (with Mermaid extension), and most Markdown viewers.

## Diagram Index

| Diagram | File | Description |
|---|---|---|
| C4 System Context | [c4-system-context.md](c4-system-context.md) | Top-level view: users, the platform, and external systems |
| C4 Container | [c4-container.md](c4-container.md) | All containers within the Docker platform and their relationships |
| ETL Data Flow | [etl-data-flow.md](etl-data-flow.md) | End-to-end flow from synthetic JSON through transform → vectorize → pgvector |
| Search Sequence | [search-sequence.md](search-sequence.md) | Step-by-step sequence for `/api/search` requests |
| Lookup Sequence | [lookup-sequence.md](lookup-sequence.md) | Step-by-step sequence for `/api/lookup` detail panel requests |
| Entity Relationship | [entity-relationship.md](entity-relationship.md) | All 9 database tables, fields, and relationships |
| Docker Compose Topology | [docker-compose-topology.md](docker-compose-topology.md) | Service dependencies, volumes, and network topology |
| Deployment Pipeline | [deployment-pipeline.md](deployment-pipeline.md) | `npm run deploy` execution sequence with quality gates |
| ETL Job State | [state-etl-job.md](state-etl-job.md) | State machine for a single ETL job lifecycle |
| GenAI Target Architecture | [genai-target-architecture.md](genai-target-architecture.md) | Future-state C4 container diagram per the GenAI expansion plan |

## Conventions

- **C4 standards**: System Context → Container → Component layering with color-coded stereotypes
- **Color coding**: 🔵 Application containers · 🟣 ETL services · 🟢 Database/infra · 🟡 Volumes/sources · 🔴 New/planned · ⚪ External
- **Rendering**: All diagrams use [Mermaid](https://mermaid.js.org/) syntax in fenced code blocks
