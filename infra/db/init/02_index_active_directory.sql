-- Schema + HNSW index for the active-directory ETL.
-- Fields mirror services/active-directory/data/synthetic.json.

CREATE TABLE IF NOT EXISTS active_directory (
  id                 SERIAL  PRIMARY KEY,
  first_name         TEXT    NOT NULL,
  last_name          TEXT    NOT NULL,
  email              TEXT    UNIQUE NOT NULL,
  type               TEXT,
  enabled            BOOLEAN DEFAULT true,
  locked             BOOLEAN DEFAULT false,
  passwordlastreset  TIMESTAMP WITH TIME ZONE,
  embedding          vector(384),
  created_at         TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- HNSW index for cosine-similarity nearest-neighbour search.
-- Tuning: m = max edges per node (recall vs memory); ef_construction = build candidate list (recall vs speed).
CREATE INDEX IF NOT EXISTS active_directory_embedding_hnsw_idx
  ON active_directory USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
