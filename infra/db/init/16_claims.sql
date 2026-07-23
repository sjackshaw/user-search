-- Schema + HNSW index for member benefits claims.
-- Claims are scoped to netForum-derived member IDs and are owned by the
-- member-benefits app/ETL path, not the existing user search app.

CREATE TABLE IF NOT EXISTS claims (
  id            SERIAL PRIMARY KEY,
  member_id     TEXT NOT NULL,
  member_email  TEXT NOT NULL,
  claim_id      TEXT UNIQUE NOT NULL,
  claim_type    TEXT NOT NULL,
  service_date  DATE NOT NULL,
  provider      TEXT,
  amount_billed NUMERIC(10,2),
  amount_paid   NUMERIC(10,2),
  plan_year     INT NOT NULL,
  status        TEXT NOT NULL,
  embedding     vector(384),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claims_member_id_idx
  ON claims (member_id, service_date DESC);

CREATE INDEX IF NOT EXISTS claims_member_email_idx
  ON claims (member_email);

CREATE INDEX IF NOT EXISTS claims_status_idx
  ON claims (status);

CREATE INDEX IF NOT EXISTS claims_embedding_hnsw_idx
  ON claims USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE PROCEDURE sp_upsert_claim(
  p_member_id     TEXT,
  p_member_email  TEXT,
  p_claim_id      TEXT,
  p_claim_type    TEXT,
  p_service_date  DATE,
  p_provider      TEXT,
  p_amount_billed NUMERIC,
  p_amount_paid   NUMERIC,
  p_plan_year     INT,
  p_status        TEXT,
  p_embedding     TEXT
) AS $$
  INSERT INTO claims
    (member_id, member_email, claim_id, claim_type, service_date, provider,
     amount_billed, amount_paid, plan_year, status, embedding, updated_at)
  VALUES
    (p_member_id, p_member_email, p_claim_id, p_claim_type, p_service_date,
     p_provider, p_amount_billed, p_amount_paid, p_plan_year, p_status,
     p_embedding::vector, now())
  ON CONFLICT (claim_id) DO UPDATE SET
    member_id     = EXCLUDED.member_id,
    member_email  = EXCLUDED.member_email,
    claim_type    = EXCLUDED.claim_type,
    service_date  = EXCLUDED.service_date,
    provider      = EXCLUDED.provider,
    amount_billed = EXCLUDED.amount_billed,
    amount_paid   = EXCLUDED.amount_paid,
    plan_year     = EXCLUDED.plan_year,
    status        = EXCLUDED.status,
    embedding     = EXCLUDED.embedding,
    updated_at    = now();
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION sp_get_existing_claims()
RETURNS TABLE(
  claim_id      TEXT,
  member_id     TEXT,
  member_email  TEXT,
  claim_type    TEXT,
  service_date  DATE,
  provider      TEXT,
  amount_billed NUMERIC,
  amount_paid   NUMERIC,
  plan_year     INT,
  status        TEXT
) AS $$
  SELECT claim_id, member_id, member_email, claim_type, service_date, provider,
         amount_billed, amount_paid, plan_year, status
  FROM claims;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_delete_claim(p_claim_id TEXT) AS $$
  DELETE FROM claims WHERE claim_id = p_claim_id;
$$ LANGUAGE sql;
