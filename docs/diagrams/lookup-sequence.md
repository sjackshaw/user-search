# User Lookup / Detail Panel Sequence

```mermaid
sequenceDiagram
    participant U as 👤 User Browser
    participant A as App Container<br/>(Express)
    participant P as PostgreSQL

    U->>U: Click on search result card

    U->>+A: GET /api/lookup?email=jsmith@example.com

    par Promise.all in parallel
        A->>+P: LOOKUP_SQL<br/>UNION ALL of all 8 source tables<br/>filtered by email<br/>(identity + groups + activity logs)
        P-->>-A: All records (0-N rows)
    and
        A->>+P: CHANGE_LOGS_SQL<br/>SELECT * FROM source_change_logs<br/>WHERE email=$1<br/>ORDER BY detected_at DESC LIMIT 100
        P-->>-A: Change log entries (0-N rows)
    end

    A-->>-U: 200 JSON { records: [...], changeLogs: [...] }

    Note over U: Render detail panel:<br/>- Identity info per source<br/>- Group memberships<br/>- Activity logs (preview + More toggle)<br/>- Change history (green=created, blue=updated, red=deleted)<br/>- Field-level diffs for updated entries
```
