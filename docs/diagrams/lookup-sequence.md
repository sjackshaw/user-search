# User Lookup / Detail Panel Sequence

```mermaid
sequenceDiagram
    participant U as 👤 User Browser
    participant A as App Container<br/>(Express)
    participant P as PostgreSQL

    U->>U: Click on search result card

    U->>+A: GET /api/lookup?email=jsmith@example.com

    par Promise.all in parallel
        A->>+P: sp_lookup_by_email(email)<br/>UNION ALL across 10 sources:<br/>AD, netForum, external_users,<br/>distribution_groups, DG sync logs,<br/>AD/EU/NF activity logs,<br/>sharepoint_permissions, m365_group_memberships
        P-->>-A: All records (0-N rows)
    and
        A->>+P: sp_get_change_logs(email)<br/>SELECT * FROM source_change_logs<br/>WHERE email=$1<br/>ORDER BY detected_at DESC LIMIT 100
        P-->>-A: Change log entries (0-N rows)
    end

    A-->>-U: 200 JSON { records: [...], changeLogs: [...] }

    Note over U: Render detail panel:<br/>- Identity info per source<br/>- Group memberships (DG + M365)<br/>- SharePoint permissions<br/>- Activity logs (preview + More toggle)<br/>- Change history (green=created, blue=updated, red=deleted)<br/>- Field-level diffs for updated entries
```
