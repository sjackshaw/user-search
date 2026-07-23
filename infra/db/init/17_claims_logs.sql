-- Activity/audit-style logs for synthetic member benefits claims.

CREATE TABLE IF NOT EXISTS claims_logs (
  id            SERIAL PRIMARY KEY,
  log_timestamp TIMESTAMPTZ NOT NULL,
  member_id     TEXT NOT NULL,
  member_email  TEXT NOT NULL,
  claim_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  notes         TEXT,
  embedding     vector(384),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claims_logs_member_id_idx
  ON claims_logs (member_id, log_timestamp DESC);

CREATE INDEX IF NOT EXISTS claims_logs_claim_id_idx
  ON claims_logs (claim_id);

CREATE INDEX IF NOT EXISTS claims_logs_embedding_hnsw_idx
  ON claims_logs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE PROCEDURE sp_insert_claim_log(
  p_log_timestamp TIMESTAMPTZ,
  p_member_id     TEXT,
  p_member_email  TEXT,
  p_claim_id      TEXT,
  p_event_type    TEXT,
  p_notes         TEXT,
  p_embedding     TEXT
) AS $$
  INSERT INTO claims_logs
    (log_timestamp, member_id, member_email, claim_id, event_type, notes, embedding)
  VALUES
    (p_log_timestamp, p_member_id, p_member_email, p_claim_id, p_event_type,
     p_notes, p_embedding::vector);
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_truncate_claims_logs() AS $$
  TRUNCATE TABLE claims_logs RESTART IDENTITY;
$$ LANGUAGE sql;
