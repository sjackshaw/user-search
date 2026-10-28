-- Adds a dedicated "last sign-in" signal to active_directory, decoupled from
-- passwordlastreset (a weak proxy for inactivity). Gives list_inactive_licenses
-- a purpose-built staleness signal instead of repurposing the password-reset date.

ALTER TABLE active_directory
  ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS active_directory_last_sign_in_idx
  ON active_directory (last_sign_in_at);

-- ── Re-create the upsert/read procedures with the new column ──────────────────
-- Signatures changed, so the originals (from 19_stored_procedures.sql) must be
-- dropped before CREATE OR REPLACE can define the new parameter list.

DROP PROCEDURE IF EXISTS sp_upsert_active_directory(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, TIMESTAMPTZ, TEXT);

CREATE OR REPLACE PROCEDURE sp_upsert_active_directory(
  p_first_name  TEXT,
  p_last_name   TEXT,
  p_email       TEXT,
  p_type        TEXT,
  p_enabled     BOOLEAN,
  p_locked      BOOLEAN,
  p_passwordlastreset TIMESTAMPTZ,
  p_last_sign_in_at   TIMESTAMPTZ,
  p_embedding   TEXT
) AS $$
  INSERT INTO active_directory
    (first_name, last_name, email, type, enabled, locked, passwordlastreset, last_sign_in_at, embedding)
  VALUES
    (p_first_name, p_last_name, p_email, p_type, p_enabled, p_locked,
     p_passwordlastreset, p_last_sign_in_at, p_embedding::vector)
  ON CONFLICT (email) DO UPDATE SET
    first_name        = EXCLUDED.first_name,
    last_name         = EXCLUDED.last_name,
    type              = EXCLUDED.type,
    enabled           = EXCLUDED.enabled,
    locked            = EXCLUDED.locked,
    passwordlastreset = EXCLUDED.passwordlastreset,
    last_sign_in_at   = EXCLUDED.last_sign_in_at,
    embedding         = EXCLUDED.embedding;
$$ LANGUAGE sql;

DROP FUNCTION IF EXISTS sp_get_existing_active_directory();

CREATE OR REPLACE FUNCTION sp_get_existing_active_directory()
RETURNS TABLE(
  email             TEXT,
  first_name        TEXT,
  last_name         TEXT,
  type              TEXT,
  enabled           BOOLEAN,
  locked            BOOLEAN,
  passwordlastreset TIMESTAMPTZ,
  last_sign_in_at   TIMESTAMPTZ
) AS $$
  SELECT email, first_name, last_name, type, enabled, locked, passwordlastreset, last_sign_in_at
  FROM   active_directory;
$$ LANGUAGE sql STABLE;
