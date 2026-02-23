-- Schema + HNSW index for the external-user-activity-logs ETL.
-- Stores activity log entries detailing changes made to external user accounts,
-- including the subject account, the AD user who made the change, and freetext notes.

CREATE TABLE IF NOT EXISTS external_user_activity_logs (
  id             SERIAL  PRIMARY KEY,
  log_timestamp  TIMESTAMP WITH TIME ZONE NOT NULL,
  first_name     TEXT    NOT NULL,
  last_name      TEXT    NOT NULL,
  email          TEXT    NOT NULL,
  changed_by     TEXT,
  notes          TEXT,
  embedding      vector(384),
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ext_user_activity_logs_embedding_hnsw_idx
  ON external_user_activity_logs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS ext_user_activity_logs_email_idx
  ON external_user_activity_logs (email);

CREATE INDEX IF NOT EXISTS ext_user_activity_logs_log_timestamp_idx
  ON external_user_activity_logs (log_timestamp DESC);

CREATE INDEX IF NOT EXISTS ext_user_activity_logs_changed_by_idx
  ON external_user_activity_logs (changed_by);
