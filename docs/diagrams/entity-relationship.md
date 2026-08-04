# Entity Relationship Diagram

16 tables total: 6 primary sources, 6 activity/sync/change log tables, 3 supporting tables (ETL logs, change logs, chat), 1 agent tickets table, and 1 access requests table.

```mermaid
erDiagram
    ACTIVE_DIRECTORY {
        serial id PK
        text first_name
        text last_name
        text email UK
        text type "user or contact"
        boolean enabled
        boolean locked
        timestamptz passwordlastreset
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    NETFORUM_MEMBERS {
        serial id PK
        text first_name
        text last_name
        text email UK
        text type "member"
        boolean enabled
        timestamptz last_login
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    EXTERNAL_USERS {
        serial id PK
        text first_name
        text last_name
        text email UK
        text type
        boolean enabled
        text sponsor
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    DISTRIBUTION_GROUPS {
        serial id PK
        text name
        text alias
        text email UK
        jsonb contacts "array of contact objects"
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    ACTIVE_DIRECTORY_ACTIVITY_LOGS {
        serial id PK
        timestamptz log_timestamp
        text first_name
        text last_name
        text email FK
        text changed_by
        text notes
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    NETFORUM_ACTIVITY_LOGS {
        serial id PK
        timestamptz log_timestamp
        text first_name
        text last_name
        text email FK
        text changed_by
        text notes
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    EXTERNAL_USER_ACTIVITY_LOGS {
        serial id PK
        timestamptz log_timestamp
        text first_name
        text last_name
        text email FK
        text changed_by
        text notes
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    DISTRIBUTION_GROUP_SYNC_LOGS {
        serial id PK
        text group_name
        timestamptz sync_timestamp
        jsonb accounts_added
        jsonb accounts_removed
        text notes
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    ETL_JOB_LOGS {
        serial id PK
        text service
        text phase "primary or logs"
        text target_table
        text status "running / completed / failed"
        int records_processed
        int records_created
        int records_updated
        int records_deleted
        text error_message
        timestamptz started_at
        timestamptz finished_at
    }

    SOURCE_CHANGE_LOGS {
        serial id PK
        text source_table
        text email FK
        text change_type "created / updated / deleted"
        text field_name
        text old_value
        text new_value
        timestamptz detected_at
        int etl_job_id FK
    }

    CHAT_MESSAGES {
        serial id PK
        uuid session_id
        text role "user or assistant"
        text content
        timestamptz created_at
    }

    SHAREPOINT_PERMISSIONS {
        serial id PK
        text user_email
        text site
        text site_url
        text role
        text permission_type
        text granted_by
        timestamptz granted_at
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    SHAREPOINT_PERMISSION_CHANGE_LOGS {
        serial id PK
        timestamptz log_timestamp
        text user_email
        text site
        text change_type
        text old_role
        text new_role
        text changed_by
        text notes
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    M365_GROUP_MEMBERSHIPS {
        serial id PK
        text group_name
        text group_email UK
        text group_type
        jsonb users "array of user objects"
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    M365_MEMBERSHIP_CHANGE_LOGS {
        serial id PK
        timestamptz log_timestamp
        text group_name
        text user_email
        text change_action
        text role
        text changed_by
        text notes
        vector embedding "384-dim HNSW"
        timestamptz created_at
    }

    AGENT_TICKETS {
        serial id PK
        text email
        text title
        text description
        text status "open / closed"
        uuid session_id
        timestamptz created_at
        timestamptz updated_at
    }

    ACCESS_REQUESTS {
        serial id PK
        text requested_for
        text requested_by
        text resource_type "distribution_group / license / sharepoint / m365_group"
        text resource_name
        text reason
        text status "pending / approved / rejected"
        text approver_note
        uuid session_id
        timestamptz created_at
        timestamptz updated_at
    }

    ACTIVE_DIRECTORY ||--o{ ACTIVE_DIRECTORY_ACTIVITY_LOGS : "email"
    NETFORUM_MEMBERS ||--o{ NETFORUM_ACTIVITY_LOGS : "email"
    EXTERNAL_USERS ||--o{ EXTERNAL_USER_ACTIVITY_LOGS : "email"
    SHAREPOINT_PERMISSIONS ||--o{ SHAREPOINT_PERMISSION_CHANGE_LOGS : "user_email + site"
    M365_GROUP_MEMBERSHIPS ||--o{ M365_MEMBERSHIP_CHANGE_LOGS : "group_name"
    ACTIVE_DIRECTORY ||--o{ SOURCE_CHANGE_LOGS : "email"
    NETFORUM_MEMBERS ||--o{ SOURCE_CHANGE_LOGS : "email"
    EXTERNAL_USERS ||--o{ SOURCE_CHANGE_LOGS : "email"
    DISTRIBUTION_GROUPS ||--o{ SOURCE_CHANGE_LOGS : "email"
    SHAREPOINT_PERMISSIONS ||--o{ SOURCE_CHANGE_LOGS : "email"
    M365_GROUP_MEMBERSHIPS ||--o{ SOURCE_CHANGE_LOGS : "email"
    ETL_JOB_LOGS ||--o{ SOURCE_CHANGE_LOGS : "etl_job_id"
```
