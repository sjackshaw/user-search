-- Schema + HNSW index for the netForum ETL.
-- Fields mirror services/netForum/data/synthetic.json.

CREATE TABLE IF NOT EXISTS netforum_members (
  id         SERIAL  PRIMARY KEY,
  first_name TEXT    NOT NULL,
  last_name  TEXT    NOT NULL,
  email      TEXT    UNIQUE NOT NULL,
  type       TEXT,
  enabled    BOOLEAN DEFAULT true,
  last_login TIMESTAMP WITH TIME ZONE,
  embedding  vector(384),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS netforum_members_embedding_hnsw_idx
  ON netforum_members USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
