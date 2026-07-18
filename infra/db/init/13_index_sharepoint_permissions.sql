-- Schema + HNSW indexes for the SharePoint On-Prem permissions ETL.
-- Fields mirror services/etl-sp-line/data/primary.json and logs.json.

-- ── Primary: one row per user-site permission ─────────────────────────────────
CREATE TABLE IF NOT EXISTS sharepoint_permissions (
  id              SERIAL PRIMARY KEY,
  user_email      TEXT    NOT NULL,
  site            TEXT    NOT NULL,
  site_url        TEXT,
  role            TEXT    NOT NULL,           -- Read | Edit | FullControl
  permission_type TEXT,                       -- Direct | Inherited
  granted_by      TEXT,                       -- AD email of who granted this
  granted_at      TIMESTAMP WITH TIME ZONE,
  embedding       vector(384),
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE (user_email, site)
);

-- HNSW index for cosine-similarity nearest-neighbour search.
CREATE INDEX IF NOT EXISTS sharepoint_permissions_embedding_hnsw_idx
  ON sharepoint_permissions USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Logs: permission change audit trail ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sharepoint_permission_change_logs (
  id          SERIAL PRIMARY KEY,
  log_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  user_email  TEXT    NOT NULL,
  site        TEXT    NOT NULL,
  change_type TEXT    NOT NULL,     -- granted | modified | revoked
  old_role    TEXT,
  new_role    TEXT,
  changed_by  TEXT,
  notes       TEXT,
  embedding   vector(384),
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- HNSW index for log search.
CREATE INDEX IF NOT EXISTS sp_perm_change_logs_embedding_hnsw_idx
  ON sharepoint_permission_change_logs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
