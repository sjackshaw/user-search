-- Adds an explicit sharing-scope concept to sharepoint_permissions so literal
-- "Everyone" / "Everyone except external users" / anonymous-link oversharing
-- can be detected directly, instead of only via the external-user + elevated-
-- role heuristic in list_oversharing_risks.

ALTER TABLE sharepoint_permissions
  ADD COLUMN IF NOT EXISTS share_scope TEXT NOT NULL DEFAULT 'user'
    CHECK (share_scope IN ('user', 'everyone', 'everyone_except_external', 'anonymous_link'));
    -- user = permission scoped to a single named account (existing behaviour)

CREATE INDEX IF NOT EXISTS sharepoint_permissions_share_scope_idx
  ON sharepoint_permissions (share_scope) WHERE share_scope <> 'user';

-- ── Re-create the upsert/read procedures with the new share_scope parameter ───
-- Signatures changed, so the originals (from 19_stored_procedures.sql) must be
-- dropped before CREATE OR REPLACE can define the new parameter list.

DROP PROCEDURE IF EXISTS sp_upsert_sharepoint_permission(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT);

CREATE OR REPLACE PROCEDURE sp_upsert_sharepoint_permission(
  p_user_email      TEXT,
  p_site            TEXT,
  p_site_url        TEXT,
  p_role            TEXT,
  p_permission_type TEXT,
  p_granted_by      TEXT,
  p_granted_at      TIMESTAMPTZ,
  p_share_scope     TEXT,
  p_embedding       TEXT
) AS $$
  INSERT INTO sharepoint_permissions
    (user_email, site, site_url, role, permission_type, granted_by, granted_at, share_scope, embedding)
  VALUES
    (p_user_email, p_site, p_site_url, p_role, p_permission_type,
     p_granted_by, p_granted_at, COALESCE(p_share_scope, 'user'), p_embedding::vector)
  ON CONFLICT (user_email, site) DO UPDATE SET
    site_url        = EXCLUDED.site_url,
    role            = EXCLUDED.role,
    permission_type = EXCLUDED.permission_type,
    granted_by      = EXCLUDED.granted_by,
    granted_at      = EXCLUDED.granted_at,
    share_scope     = EXCLUDED.share_scope,
    embedding       = EXCLUDED.embedding;
$$ LANGUAGE sql;

DROP FUNCTION IF EXISTS sp_get_existing_sharepoint_permissions();

CREATE OR REPLACE FUNCTION sp_get_existing_sharepoint_permissions()
RETURNS TABLE(
  user_email      TEXT,
  site            TEXT,
  role            TEXT,
  permission_type TEXT,
  granted_by      TEXT,
  granted_at      TIMESTAMPTZ,
  share_scope     TEXT
) AS $$
  SELECT user_email, site, role, permission_type, granted_by, granted_at, share_scope
  FROM   sharepoint_permissions;
$$ LANGUAGE sql STABLE;

