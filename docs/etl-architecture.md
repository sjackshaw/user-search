# ETL Architecture

## Overview

The pipeline consists of four **line** ETL services and one application service, all coordinated via Docker Compose. Each line service handles both its primary data source and its associated activity/sync log table within a single container, sharing one SBERT model instance and one Postgres connection pool.

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

All HNSW indexes use `vector_cosine_ops` with `m=16, ef_construction=64`. Activity-log tables additionally carry indexes on `email`, `log_timestamp DESC`, and `changed_by`.

---

## App service

| Item | Value |
|---|---|
| Service dir | `services/app/` |
| Compose file | `docker-compose.app.yml` |
| Port | `3000` |

The app exposes two API endpoints:

### `GET /api/search?q=<query>`

Semantic search across all nine tables. Supports:
- **Natural-language semantic** — embeds the query with SBERT and performs a UNION ALL nearest-neighbour search across every table using pgvector HNSW indexes.
- **Intersection / exclusion** — queries like `"users in active directory and netforum"` or `"john in ad and not in external users"` are detected by a pattern parser and resolved via cross-table email intersection SQL, with optional ANN re-ranking when a search term is also present.

### `GET /api/lookup?email=<email>`

Returns every record associated with a given email or group name across all nine tables. Activity-log records are sorted newest-first per source and grouped by source in the UI.

---

## Data flow

```
services/etl-ad-line/data/primary.json  (committed seed — AD users & contacts)
        │
        ▼
generate_synthetic.py  (Python 3, seeded)
        │
        ├── services/etl-netforum-line/data/primary.json   (1 000 members)
        ├── services/etl-eu-line/data/primary.json         (1 000 external users)
        ├── services/etl-dg-line/data/primary.json         (500 groups)
        │
        ├── services/etl-ad-line/data/logs.json            (3 000 AD activity logs)
        ├── services/etl-netforum-line/data/logs.json      (2 000 NF activity logs)
        ├── services/etl-eu-line/data/logs.json            (2 000 EU activity logs)
        └── services/etl-dg-line/data/logs.json            (1 500 DG sync logs)
                        │
                        ▼  (vectorize.js — runPrimary() then runLogs(), on startup + cron)
                 Postgres / pgvector
                        │
                        ▼
                 services/app  ──► http://localhost:3000
```

1. **Index** (`index.js`) — reads `data/synthetic.json`, applies a lightweight transform, and writes a JSON output file to `data-output/<service>/`.
2. **Vectorize** (`vectorize.js`) — reads the same `synthetic.json`, generates 384-dimensional SBERT embeddings using `Xenova/all-MiniLM-L6-v2`, and upserts records into Postgres via pgvector. Runs immediately on startup and then on a configurable cron schedule (default: every hour).

Each vectorize service runs continuously (`restart: unless-stopped`) and requires a healthy Postgres instance (via `depends_on: condition: service_healthy`).

---

## Services

### 1. active-directory

| Item | Value |
|---|---|
| Service dir | `services/active-directory/` |
| Compose file | `docker-compose.etl-active-directory.yml` |
| Postgres table | `active_directory` |
| Data generator | `services/active-directory/data/generate_synthetic.js` |

**Schema**

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

---

### 2. netForum

| Item | Value |
|---|---|
| Service dir | `services/netForum/` |
| Compose file | `docker-compose.etl-netforum.yml` |
| Postgres table | `netforum_members` |
| Data generator | `generate_synthetic.py` |

250 of 1 000 records are sampled from Active Directory; the remaining 750 are freshly generated.

**Schema**

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

---

### 3. external-user

| Item | Value |
|---|---|
| Service dir | `services/external-user/` |
| Compose file | `docker-compose.etl-external-user.yml` |
| Postgres table | `external_users` |
| Data generator | `generate_synthetic.py` |

100 of 1 000 records are sampled from Active Directory contacts; 900 are freshly generated.

**Schema**

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

---

### 4. distribution-group

| Item | Value |
|---|---|
| Service dir | `services/distribution-group/` |
| Compose file | `docker-compose.etl-distribution-group.yml` |
| Postgres table | `distribution_groups` |
| Data generator | `generate_synthetic.py` |

500 groups, each with 3–12 contacts drawn from all AD records.

**Schema**

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

---

### 5. distribution-group-sync-logs

| Item | Value |
|---|---|
| Service dir | `services/distribution-group-sync-logs/` |
| Compose file | `docker-compose.etl-distribution-group-sync-logs.yml` |
| Postgres table | `distribution_group_sync_logs` |
| Data generator | `generate_synthetic.py` |

Audit trail of distribution group membership changes.

**Schema**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `sync_timestamp` | `TIMESTAMPTZ NOT NULL` | When the sync occurred |
| `group_name` | `TEXT NOT NULL` | Distribution group name |
| `accounts_added` | `JSONB` | Array of `{first_name, last_name, email}` |
| `accounts_removed` | `JSONB` | Array of `{first_name, last_name, email}` |
| `notes` | `TEXT` | Freetext notes referencing up to 10 AD users |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<group_name> <notes> <added member names…> <removed member names…>"`

---

### 6. active-directory-activity-logs

| Item | Value |
|---|---|
| Service dir | `services/active-directory-activity-logs/` |
| Compose file | `docker-compose.etl-active-directory-activity-logs.yml` |
| Postgres table | `active_directory_activity_logs` |
| Data generator | `generate_synthetic.py` |

500 records. Subjects are drawn from all Active Directory records. `changed_by` is always an AD user.

**Schema**

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `log_timestamp` | `TIMESTAMPTZ NOT NULL` | When the action occurred |
| `first_name` | `TEXT NOT NULL` | First name of the account acted on |
| `last_name` | `TEXT NOT NULL` | Last name of the account acted on |
| `email` | `TEXT NOT NULL` | Email of the account acted on |
| `changed_by` | `TEXT` | Full name of the AD user who made the change |
| `notes` | `TEXT` | Freetext description referencing up to 10 AD users |
| `embedding` | `vector(384)` | |
| `created_at` | `TIMESTAMPTZ` | Default `now()` |

**Embedding text** — `"<first_name> <last_name> <email> <changed_by> <notes>"`

---

### 7. external-user-activity-logs

| Item | Value |
|---|---|
| Service dir | `services/external-user-activity-logs/` |
| Compose file | `docker-compose.etl-external-user-activity-logs.yml` |
| Postgres table | `external_user_activity_logs` |
| Data generator | `generate_synthetic.py` |

500 records. Subjects are drawn from the external-user dataset. `changed_by` is always an AD user.

**Schema** — identical to `active_directory_activity_logs` (see above).

**Embedding text** — `"<first_name> <last_name> <email> <changed_by> <notes>"`

---

### 8. netforum-activity-logs

| Item | Value |
|---|---|
| Service dir | `services/netforum-activity-logs/` |
| Compose file | `docker-compose.etl-netforum-activity-logs.yml` |
| Postgres table | `netforum_activity_logs` |
| Data generator | `generate_synthetic.py` |

500 records. Subjects are drawn from the netForum dataset. `changed_by` is always an AD user.

**Schema** — identical to `active_directory_activity_logs` (see above).

**Embedding text** — `"<first_name> <last_name> <email> <changed_by> <notes>"`

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

All HNSW indexes use `vector_cosine_ops` with `m=16, ef_construction=64`. Activity-log tables additionally carry indexes on `email`, `log_timestamp DESC`, and `changed_by`.

If Postgres has already been initialised, apply new scripts manually:

```sh
docker exec -i <postgres-container> psql -U postgres -d appdb \
  < infra/db/init/<script>.sql
```

---

## App service

| Item | Value |
|---|---|
| Service dir | `services/app/` |
| Compose file | `docker-compose.app.yml` |
| Port | `3000` |

The app exposes two API endpoints:

### `GET /api/search?q=<query>`

Semantic search across all nine tables. Supports:
- **Natural-language semantic** — embeds the query with SBERT and performs a UNION ALL nearest-neighbour search across every table using pgvector HNSW indexes.
- **Intersection / exclusion** — queries like `"users in active directory and netforum"` or `"john in ad and not in external users"` are detected by a pattern parser and resolved via cross-table email intersection SQL, with optional ANN re-ranking when a search term is also present.

Source aliases understood by the parser include: `ad`, `netforum`, `nf`, `external`, `groups`, `dg`, `sync logs`, `ad activity logs`, `nf activity`, `external activity`, and more (see `SOURCE_ALIASES` in `services/app/src/index.js`).

### `GET /api/lookup?email=<email>`

Returns every record associated with a given email or group name across all nine tables. Activity-log records are sorted newest-first per source and grouped by source in the UI, with a three-entry preview and a "More…" expand toggle.

---

## Data flow diagram

```
generate_synthetic.js  ─────────────────────────────────────┐
  (Node.js, seeded)                                          │
                                                             ▼
                                          services/active-directory/data/synthetic.json
                                                             │
generate_synthetic.py  ◄───────────────────── reads AD data ┘
  (Python 3, seeded)
      │
      ├── services/netForum/data/synthetic.json
      ├── services/external-user/data/synthetic.json
      ├── services/distribution-group/data/synthetic.json
      ├── services/distribution-group-sync-logs/data/synthetic.json
      ├── services/active-directory-activity-logs/data/synthetic.json
      ├── services/external-user-activity-logs/data/synthetic.json
      └── services/netforum-activity-logs/data/synthetic.json
                     │
                     ▼  (vectorize.js, on startup + cron)
              Postgres / pgvector
                     │
                     ▼
              services/app  ──► http://localhost:3000
```
