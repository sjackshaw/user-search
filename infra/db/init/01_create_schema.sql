-- Enable pgvector extension.
-- Each ETL source creates its own table in 02_–05_*.sql.
CREATE EXTENSION IF NOT EXISTS vector;
