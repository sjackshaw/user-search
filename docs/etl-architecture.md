# ETL Architecture

## Overview

The pipeline consists of six **line** ETL services and one application service, all coordinated via Docker Compose. Each line service handles both its primary data source and its associated activity/sync log table within a single container, sharing one SBERT model instance and one Postgres connection pool.

> The former member-benefits ETL path and application were removed from this repository. Any related work now sits in the `document-search` repository.

Each line service follows this pattern on startup (and then cron, hourly):

1. **`runPrimary()`** — reads `data/primary.json`, generates 384-dimensional SBERT embeddings using `Xenova/all-MiniLM-L6-v2`, and upserts records into the primary Postgres table.
2. **`runLogs()`** — reads `data/logs.json`, generates embeddings, and upserts records into the log/sync Postgres table.

Both phases share one loaded model instance and one `pg.Pool`, reducing per-container memory by ~350–500 MB compared to running them separately.

---

## Services

### 1. etl-ad-line — Active Directory line

| Item | Value |
|---|---|
| Service dir | `services/etl-ad-line/` |
| Compose file | `docker-compose.etl-ad-line.yml` |
| Primary table | `active_directory` |
| Log table | `active_directory_activity_logs` |
| Primary data | `services/etl-ad-line/data/primary.json` |
| Log data | `services/etl-ad-line/data/logs.json` (3 000 records) |

**Primary schema — `active_directory`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `first_name` | `TEXT NOT NULL` | |
| `last_name` | `TEXT NOT NULL` | |
| `email` | `TEXT UNIQUE NOT NULL` | |
| `type` | `TEXT` | `user` or `contact` |
| `enabled` | `BOOLEAN` | Default `true` |
| `locked` | `BOOLEAN` | Default `false` |
| `passwordlastreset` | `TIMESTAMPTZ` | |
| `embedding` | `vector(384)` | SBERT embedding |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<first_name> <last_name> <email>"`

**Log schema — `active_directory_activity_logs`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `log_timestamp` | `TIMESTAMPTZ NOT NULL` | When the action occurred |
| `first_name` | `TEXT NOT NULL` | Account acted on |
| `last_name` | `TEXT NOT NULL` | |
| `email` | `TEXT NOT NULL` | |
| `changed_by` | `TEXT` | Full name of the AD user who made the change |
| `notes` | `TEXT` | Freetext description referencing up to 10 AD users |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<first_name> <last_name> <email> <changed_by> <notes>"`

---

### 2. etl-netforum-line — netForum line

| Item | Value |
|---|---|
| Service dir | `services/etl-netforum-line/` |
| Compose file | `docker-compose.etl-netforum-line.yml` |
| Primary table | `netforum_members` |
| Log table | `netforum_activity_logs` |
| Primary data | `services/etl-netforum-line/data/primary.json` (1 000 records; 250 sampled from AD) |
| Log data | `services/etl-netforum-line/data/logs.json` (2 000 records) |

**Primary schema — `netforum_members`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `first_name` | `TEXT NOT NULL` | |
| `last_name` | `TEXT NOT NULL` | |
| `email` | `TEXT UNIQUE NOT NULL` | |
| `type` | `TEXT` | Always `member` |
| `enabled` | `BOOLEAN` | |
| `last_login` | `TIMESTAMPTZ` | |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<first_name> <last_name> <email>"`

**Log schema** — identical structure to `active_directory_activity_logs`. Subjects are drawn from the netForum dataset; `changed_by` is always an AD user.

---

### 3. etl-eu-line — External Users line

| Item | Value |
|---|---|
| Service dir | `services/etl-eu-line/` |
| Compose file | `docker-compose.etl-eu-line.yml` |
| Primary table | `external_users` |
| Log table | `external_user_activity_logs` |
| Primary data | `services/etl-eu-line/data/primary.json` (1 000 records; 100 sampled from AD contacts) |
| Log data | `services/etl-eu-line/data/logs.json` (2 000 records) |

**Primary schema — `external_users`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `first_name` | `TEXT NOT NULL` | |
| `last_name` | `TEXT NOT NULL` | |
| `email` | `TEXT UNIQUE NOT NULL` | |
| `type` | `TEXT` | Always `external-user` |
| `enabled` | `BOOLEAN` | |
| `sponsor` | `TEXT` | Full name of the sponsoring AD user |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<first_name> <last_name> <email> <sponsor>"`

**Log schema** — identical structure to `active_directory_activity_logs`. Subjects are drawn from the external-user dataset; `changed_by` is always an AD user.

---

### 4. etl-dg-line — Distribution Groups line

| Item | Value |
|---|---|
| Service dir | `services/etl-dg-line/` |
| Compose file | `docker-compose.etl-dg-line.yml` |
| Primary table | `distribution_groups` |
| Log table | `distribution_group_sync_logs` |
| Primary data | `services/etl-dg-line/data/primary.json` (500 groups) |
| Log data | `services/etl-dg-line/data/logs.json` (1 500 records) |

**Primary schema — `distribution_groups`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `name` | `TEXT NOT NULL` | Group display name |
| `alias` | `TEXT UNIQUE NOT NULL` | Kebab-case alias |
| `email` | `TEXT UNIQUE NOT NULL` | `<alias>@lists.corporate.com` |
| `contacts` | `JSONB` | Array of `{first_name, last_name, email}` |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<name> <alias> <member names…>"`

**Log schema — `distribution_group_sync_logs`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `sync_timestamp` | `TIMESTAMPTZ NOT NULL` | When the sync occurred |
| `group_name` | `TEXT NOT NULL` | Distribution group name |
| `accounts_added` | `JSONB` | Array of `{first_name, last_name, email}` |
| `accounts_removed` | `JSONB` | Array of `{first_name, last_name, email}` |
| `notes` | `TEXT` | Freetext description of the sync event |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<group_name> <notes> <added member names…> <removed member names…>"`

---

### 5. etl-m365-line — M365 Group Memberships line

| Item | Value |
|---|---|
| Service dir | `services/etl-m365-line/` |
| Compose file | `docker-compose.etl-m365-line.yml` |
| Primary table | `m365_group_memberships` |
| Log table | `m365_membership_change_logs` |
| Primary data | `services/etl-m365-line/data/primary.json` |
| Log data | `services/etl-m365-line/data/logs.json` |

**Primary schema — `m365_group_memberships`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `group_name` | `TEXT NOT NULL` | |
| `group_email` | `TEXT UNIQUE NOT NULL` | |
| `group_type` | `TEXT NOT NULL` | `Microsoft365`, `Security`, or `Distribution` |
| `users` | `JSONB NOT NULL` | Array of `{email, role, source, joined_at}` |
| `embedding` | `vector(384)` | SBERT embedding |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<group_name> <group_type> <member emails>"`

**Log schema — `m365_membership_change_logs`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `log_timestamp` | `TIMESTAMPTZ NOT NULL` | When the change occurred |
| `group_name` | `TEXT NOT NULL` | |
| `user_email` | `TEXT NOT NULL` | Member affected |
| `change_action` | `TEXT NOT NULL` | `added` or `removed` |
| `role` | `TEXT` | `member` or `owner` |
| `changed_by` | `TEXT` | |
| `notes` | `TEXT` | |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<group_name> <user_email> <change_action> <notes>"`

---

### 6. etl-sp-line — SharePoint Permissions line

| Item | Value |
|---|---|
| Service dir | `services/etl-sp-line/` |
| Compose file | `docker-compose.etl-sp-line.yml` |
| Primary table | `sharepoint_permissions` |
| Log table | `sharepoint_permission_change_logs` |
| Primary data | `services/etl-sp-line/data/primary.json` |
| Log data | `services/etl-sp-line/data/logs.json` |

**Primary schema — `sharepoint_permissions`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `user_email` | `TEXT NOT NULL` | |
| `site` | `TEXT NOT NULL` | Site display name |
| `site_url` | `TEXT` | |
| `role` | `TEXT NOT NULL` | `Read`, `Edit`, or `FullControl` |
| `permission_type` | `TEXT` | `Direct` or `Inherited` |
| `granted_by` | `TEXT` | AD email of granting user |
| `granted_at` | `TIMESTAMPTZ` | |
| `embedding` | `vector(384)` | SBERT embedding |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

Unique constraint on `(user_email, site)`.

**Embedding text** — `"<user_email> <site> <role> <granted_by>"`

**Log schema — `sharepoint_permission_change_logs`**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `log_timestamp` | `TIMESTAMPTZ NOT NULL` | When the change occurred |
| `user_email` | `TEXT NOT NULL` | |
| `site` | `TEXT NOT NULL` | |
| `change_type` | `TEXT NOT NULL` | `granted`, `modified`, or `revoked` |
| `old_role` | `TEXT` | |
| `new_role` | `TEXT` | |
| `changed_by` | `TEXT` | |
| `notes` | `TEXT` | |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<user_email> <site> <change_type> <notes>"`

---

## Database initialisation

Init scripts in `infra/db/init/` are executed once by Postgres on first startup, in filename order:

| File | Creates |
|---|---|
| `01_create_schema.sql` | pgvector extension, shared setup |
| `02_index_active_directory.sql` | `active_directory` table + HNSW index |
| `03_index_distribution_group.sql` | `distribution_groups` table + HNSW index |
| `04_index_external_user.sql` | `external_users` table + HNSW index |
| `05_index_netforum.sql` | `netforum_members` table + HNSW index |
| `06_index_distribution_group_sync_logs.sql` | `distribution_group_sync_logs` table + HNSW index |
| `07_index_active_directory_activity_logs.sql` | `active_directory_activity_logs` table + HNSW + supporting indexes |
| `08_index_external_user_activity_logs.sql` | `external_user_activity_logs` table + HNSW + supporting indexes |
| `09_index_netforum_activity_logs.sql` | `netforum_activity_logs` table + HNSW + supporting indexes |
| `10_logging_tables.sql` | `etl_job_logs` + `source_change_logs` tables |
| `11_chat_tables.sql` | `chat_messages` table |
| `12_stored_procedures.sql` | All stored procedures (search, lookup, intersection, ETL job management) |
| `13_index_sharepoint_permissions.sql` | `sharepoint_permissions` + `sharepoint_permission_change_logs` tables + HNSW indexes |
| `14_index_m365_group_memberships.sql` | `m365_group_memberships` + `m365_membership_change_logs` tables + HNSW indexes |
| `15_agent_tickets.sql` | `agent_tickets` table |

All HNSW indexes use `vector_cosine_ops` with `m=16, ef_construction=64`. Activity-log and change-log tables additionally carry indexes on `email`/`user_email`, `log_timestamp DESC`, and `changed_by`.

---

## App service

| Item | Value |
|---|---|
| Service dir | `services/app/` |
| Compose file | `docker-compose.app.yml` |
| Port | `3000` |

The app exposes two API endpoints:

### `GET /api/search?q=<query>`

Semantic search across all twelve tables. Supports:
- **Natural-language semantic** — embeds the query with SBERT and performs a UNION ALL nearest-neighbour search across every table using pgvector HNSW indexes.
- **Intersection / exclusion** — queries like `"users in active directory and netforum"` or `"john in ad and not in external users"` are detected by a pattern parser and resolved via cross-table email intersection SQL, with optional ANN re-ranking when a search term is also present.

Source aliases understood by the parser include: `ad`, `netforum`, `nf`, `external`, `groups`, `dg`, `m365`, `sharepoint`, `sp`, `sync logs`, `ad activity logs`, `nf activity`, `external activity`, and more (see `SOURCE_ALIASES` in `services/app/src/index.js`).

### `GET /api/lookup?email=<email>`

Returns every record associated with a given email or group name across all twelve tables. Activity-log records are sorted newest-first per source and grouped by source in the UI, with a three-entry preview and a "More…" expand toggle.

---

## Data flow

```
services/etl-ad-line/data/primary.json       (AD users & contacts)
services/etl-netforum-line/data/primary.json  (1 000 members; 250 sampled from AD)
services/etl-eu-line/data/primary.json        (1 000 external users; 100 sampled from AD)
services/etl-dg-line/data/primary.json        (500 distribution groups)
services/etl-m365-line/data/primary.json      (M365 group memberships)
services/etl-sp-line/data/primary.json        (SharePoint user permissions)
        │
       ▼  (generate_synthetic.py seeds all primary/log data files)
services/etl-ad-line/data/logs.json          (3 000 AD activity logs)
services/etl-netforum-line/data/logs.json    (2 000 netForum activity logs)
services/etl-eu-line/data/logs.json          (2 000 external user activity logs)
services/etl-dg-line/data/logs.json          (1 500 DG sync logs)
services/etl-m365-line/data/logs.json        (M365 membership change logs)
services/etl-sp-line/data/logs.json          (SharePoint permission change logs)
                │
                ▼  (vectorize.js — runPrimary() then runLogs(), on startup + cron hourly)
        Postgres / pgvector  (12 ETL tables + etl_job_logs + chat_messages + agent_tickets)
                │
                ▼
         services/app  ──► http://localhost:3000
```
