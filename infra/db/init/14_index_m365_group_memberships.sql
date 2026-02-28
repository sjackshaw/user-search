-- Schema + HNSW indexes for the Microsoft 365 group memberships ETL.
-- Fields mirror services/etl-m365-line/data/primary.json and logs.json.

-- ── Primary: one row per M365 group ──────────────────────────────────────────
-- Users are stored as a JSONB array:
--   [{ "email": "...", "role": "member|owner",
--      "source": "active_directory|external_users", "joined_at": "ISO timestamp" }]
CREATE TABLE IF NOT EXISTS m365_group_memberships (
  id          SERIAL PRIMARY KEY,
  group_name  TEXT    NOT NULL,
  group_email TEXT    UNIQUE NOT NULL,
  group_type  TEXT    NOT NULL,   -- Microsoft365 | Security | Distribution
  users       JSONB   NOT NULL DEFAULT '[]',
  embedding   vector(384),
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- HNSW index for cosine-similarity nearest-neighbour search.
CREATE INDEX IF NOT EXISTS m365_group_memberships_embedding_hnsw_idx
  ON m365_group_memberships USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Logs: membership change audit trail ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS m365_membership_change_logs (
  id            SERIAL PRIMARY KEY,
  log_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  group_name    TEXT    NOT NULL,
  user_email    TEXT    NOT NULL,
  change_action TEXT    NOT NULL,  -- added | removed
  role          TEXT,              -- member | owner
  changed_by    TEXT,
  notes         TEXT,
  embedding     vector(384),
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- HNSW index for log search.
CREATE INDEX IF NOT EXISTS m365_membership_change_logs_embedding_hnsw_idx
  ON m365_membership_change_logs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
