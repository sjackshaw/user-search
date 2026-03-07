# Search Request Sequence

```mermaid
sequenceDiagram
    participant U as 👤 User Browser
    participant A as App Container<br/>(Express + SBERT)
    participant P as PostgreSQL<br/>(pgvector)

    U->>+A: GET /api/search?q=john+smith+AD

    Note over A: Parse query via parseQuery()
    Note over A: Detect source filter: "AD"<br/>Extract search terms: "john smith"

    A->>A: SBERT pipeline.encode("john smith")
    Note over A: Returns 384-dim float32 vector

    alt Source-Filtered Query
        A->>+P: sp_search_filtered(vector, filters, top_k)<br/>SELECT *, embedding <=> $vector AS dist<br/>FROM active_directory<br/>WHERE enabled/locked/type matches<br/>ORDER BY dist LIMIT 20
        P-->>-A: Ranked results (≤20 rows)
    else Unfiltered Query
        A->>+P: sp_search_all_sources(vector, top_k)<br/>4× UNION ALL across primary tables<br/>(AD, netForum, external_users, distribution_groups)<br/>ORDER BY dist LIMIT 20
        P-->>-A: Ranked results (≤80 rows)
    end

    Note over A: Sort combined results by distance<br/>Slice to TOP_K (20)

    A->>+P: sp_multi_lookup_emails(emails[])<br/>9× UNION ALL across all source tables<br/>(includes SP permissions + M365 memberships)
    P-->>-A: Cross-source presence map

    Note over A: Merge presence flags into results

    A-->>-U: 200 JSON { results: [...] }

    Note over U: Render search result cards<br/>with source badges
```
