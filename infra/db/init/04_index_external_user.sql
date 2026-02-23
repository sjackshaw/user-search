-- Schema + HNSW index for the external-user ETL.
-- Fields mirror services/external-user/data/synthetic.json.

CREATE TABLE IF NOT EXISTS external_users (
  id         SERIAL  PRIMARY KEY,
  first_name TEXT    NOT NULL,
  last_name  TEXT    NOT NULL,
  email      TEXT    UNIQUE NOT NULL,
  type       TEXT,
  enabled    BOOLEAN DEFAULT true,
  sponsor    TEXT,
  embedding  vector(384),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_users_embedding_hnsw_idx
  ON external_users USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
