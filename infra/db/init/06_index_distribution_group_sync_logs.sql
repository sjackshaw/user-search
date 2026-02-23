-- Schema + HNSW index for the distribution-group-sync-logs ETL.
-- Stores sync log entries detailing when distribution groups were synced
-- and which accounts were added or removed.

CREATE TABLE IF NOT EXISTS distribution_group_sync_logs (
  id                SERIAL  PRIMARY KEY,
  sync_timestamp    TIMESTAMP WITH TIME ZONE NOT NULL,
  group_name        TEXT    NOT NULL,
  accounts_added    JSONB,
  accounts_removed  JSONB,
  notes             TEXT,
  embedding         vector(384),
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dg_sync_logs_embedding_hnsw_idx
  ON distribution_group_sync_logs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS dg_sync_logs_group_name_idx
  ON distribution_group_sync_logs (group_name);

CREATE INDEX IF NOT EXISTS dg_sync_logs_sync_timestamp_idx
  ON distribution_group_sync_logs (sync_timestamp DESC);
