-- Schema + HNSW index for the distribution-group ETL.
-- Fields mirror services/distribution-group/data/synthetic.json.
-- Embeddings are enriched with contact names to support membership search.

CREATE TABLE IF NOT EXISTS distribution_groups (
  id        SERIAL  PRIMARY KEY,
  name      TEXT    NOT NULL,
  alias     TEXT    NOT NULL,
  email     TEXT    UNIQUE NOT NULL,
  contacts  JSONB,
  embedding vector(384),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS distribution_groups_embedding_hnsw_idx
  ON distribution_groups USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
