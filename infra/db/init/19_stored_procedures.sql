-- ============================================================================
-- 19_stored_procedures.sql
-- Centralised stored procedures / functions for all application services.
-- Shared across: app, genai, etl-ad-line, etl-dg-line, etl-eu-line,
--                etl-netforum-line
-- Runs after all schema files (13-18) since several procedures reference
-- sharepoint_permissions/m365_group_memberships, created in files 13-14.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- ETL JOB LOGGING (shared by all 4 ETL services)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_etl_start_job(
  p_service      TEXT,
  p_phase        TEXT,
  p_target_table TEXT
) RETURNS INTEGER AS $$
  INSERT INTO etl_job_logs (service, phase, target_table, status, started_at)
  VALUES (p_service, p_phase, p_target_table, 'running', now())
  RETURNING id;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_etl_complete_job(
  p_job_id            INTEGER,
  p_records_processed INTEGER,
  p_records_created   INTEGER,
  p_records_updated   INTEGER,
  p_records_deleted   INTEGER
) AS $$
  UPDATE etl_job_logs
  SET    status            = 'completed',
         records_processed = p_records_processed,
         records_created   = p_records_created,
         records_updated   = p_records_updated,
         records_deleted   = p_records_deleted,
         finished_at       = now()
  WHERE  id = p_job_id;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_etl_fail_job(
  p_job_id        INTEGER,
  p_error_message TEXT
) AS $$
  UPDATE etl_job_logs
  SET    status        = 'failed',
         error_message = p_error_message,
         finished_at   = now()
  WHERE  id = p_job_id;
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────────────────────
-- CHANGE LOGGING (shared by all 4 ETL services)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE PROCEDURE sp_etl_log_change(
  p_source_table TEXT,
  p_email        TEXT,
  p_change_type  TEXT,
  p_field_name   TEXT,
  p_old_value    TEXT,
  p_new_value    TEXT,
  p_etl_job_id   INTEGER
) AS $$
  INSERT INTO source_change_logs
    (source_table, email, change_type, field_name, old_value, new_value, etl_job_id)
  VALUES
    (p_source_table, p_email, p_change_type, p_field_name, p_old_value, p_new_value, p_etl_job_id);
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────────────────────
-- ACTIVE DIRECTORY ETL PROCEDURES
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE PROCEDURE sp_upsert_active_directory(
  p_first_name        TEXT,
  p_last_name         TEXT,
  p_email             TEXT,
  p_type              TEXT,
  p_enabled           BOOLEAN,
  p_locked            BOOLEAN,
  p_passwordlastreset TIMESTAMPTZ,
  p_embedding         TEXT
) AS $$
  INSERT INTO active_directory
    (first_name, last_name, email, type, enabled, locked, passwordlastreset, embedding)
  VALUES
    (p_first_name, p_last_name, p_email, p_type, p_enabled, p_locked, p_passwordlastreset, p_embedding::vector)
  ON CONFLICT (email) DO UPDATE SET
    first_name        = EXCLUDED.first_name,
    last_name         = EXCLUDED.last_name,
    type              = EXCLUDED.type,
    enabled           = EXCLUDED.enabled,
    locked            = EXCLUDED.locked,
    passwordlastreset = EXCLUDED.passwordlastreset,
    embedding         = EXCLUDED.embedding;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION sp_get_existing_active_directory()
RETURNS TABLE(
  email             TEXT,
  first_name        TEXT,
  last_name         TEXT,
  type              TEXT,
  enabled           BOOLEAN,
  locked            BOOLEAN,
  passwordlastreset TIMESTAMPTZ
) AS $$
  SELECT email, first_name, last_name, type, enabled, locked, passwordlastreset
  FROM   active_directory;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_delete_active_directory(p_email TEXT) AS $$
  DELETE FROM active_directory WHERE email = p_email;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_insert_ad_activity_log(
  p_log_timestamp TIMESTAMPTZ,
  p_first_name    TEXT,
  p_last_name     TEXT,
  p_email         TEXT,
  p_changed_by    TEXT,
  p_notes         TEXT,
  p_embedding     TEXT
) AS $$
  INSERT INTO active_directory_activity_logs
    (log_timestamp, first_name, last_name, email, changed_by, notes, embedding)
  VALUES
    (p_log_timestamp, p_first_name, p_last_name, p_email, p_changed_by, p_notes, p_embedding::vector);
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_truncate_ad_activity_logs() AS $$
  TRUNCATE TABLE active_directory_activity_logs RESTART IDENTITY;
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────────────────────
-- DISTRIBUTION GROUP ETL PROCEDURES
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE PROCEDURE sp_upsert_distribution_group(
  p_name      TEXT,
  p_alias     TEXT,
  p_email     TEXT,
  p_contacts  TEXT,
  p_embedding TEXT
) AS $$
  INSERT INTO distribution_groups (name, alias, email, contacts, embedding)
  VALUES (p_name, p_alias, p_email, p_contacts::jsonb, p_embedding::vector)
  ON CONFLICT (email) DO UPDATE SET
    name      = EXCLUDED.name,
    alias     = EXCLUDED.alias,
    contacts  = EXCLUDED.contacts,
    embedding = EXCLUDED.embedding;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION sp_get_existing_distribution_groups()
RETURNS TABLE(
  email    TEXT,
  name     TEXT,
  alias    TEXT,
  contacts JSONB
) AS $$
  SELECT email, name, alias, contacts FROM distribution_groups;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_delete_distribution_group(p_email TEXT) AS $$
  DELETE FROM distribution_groups WHERE email = p_email;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_insert_dg_sync_log(
  p_sync_timestamp   TIMESTAMPTZ,
  p_group_name       TEXT,
  p_accounts_added   TEXT,
  p_accounts_removed TEXT,
  p_notes            TEXT,
  p_embedding        TEXT
) AS $$
  INSERT INTO distribution_group_sync_logs
    (sync_timestamp, group_name, accounts_added, accounts_removed, notes, embedding)
  VALUES
    (p_sync_timestamp, p_group_name, p_accounts_added::jsonb, p_accounts_removed::jsonb, p_notes, p_embedding::vector);
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_truncate_dg_sync_logs() AS $$
  TRUNCATE TABLE distribution_group_sync_logs RESTART IDENTITY;
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────────────────────
-- EXTERNAL USER ETL PROCEDURES
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE PROCEDURE sp_upsert_external_user(
  p_first_name TEXT,
  p_last_name  TEXT,
  p_email      TEXT,
  p_type       TEXT,
  p_enabled    BOOLEAN,
  p_sponsor    TEXT,
  p_embedding  TEXT
) AS $$
  INSERT INTO external_users
    (first_name, last_name, email, type, enabled, sponsor, embedding)
  VALUES
    (p_first_name, p_last_name, p_email, p_type, p_enabled, p_sponsor, p_embedding::vector)
  ON CONFLICT (email) DO UPDATE SET
    first_name = EXCLUDED.first_name,
    last_name  = EXCLUDED.last_name,
    type       = EXCLUDED.type,
    enabled    = EXCLUDED.enabled,
    sponsor    = EXCLUDED.sponsor,
    embedding  = EXCLUDED.embedding;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION sp_get_existing_external_users()
RETURNS TABLE(
  email      TEXT,
  first_name TEXT,
  last_name  TEXT,
  type       TEXT,
  enabled    BOOLEAN,
  sponsor    TEXT
) AS $$
  SELECT email, first_name, last_name, type, enabled, sponsor FROM external_users;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_delete_external_user(p_email TEXT) AS $$
  DELETE FROM external_users WHERE email = p_email;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_insert_eu_activity_log(
  p_log_timestamp TIMESTAMPTZ,
  p_first_name    TEXT,
  p_last_name     TEXT,
  p_email         TEXT,
  p_changed_by    TEXT,
  p_notes         TEXT,
  p_embedding     TEXT
) AS $$
  INSERT INTO external_user_activity_logs
    (log_timestamp, first_name, last_name, email, changed_by, notes, embedding)
  VALUES
    (p_log_timestamp, p_first_name, p_last_name, p_email, p_changed_by, p_notes, p_embedding::vector);
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_truncate_eu_activity_logs() AS $$
  TRUNCATE TABLE external_user_activity_logs RESTART IDENTITY;
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────────────────────
-- NETFORUM ETL PROCEDURES
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE PROCEDURE sp_upsert_netforum_member(
  p_first_name TEXT,
  p_last_name  TEXT,
  p_email      TEXT,
  p_type       TEXT,
  p_enabled    BOOLEAN,
  p_last_login TIMESTAMPTZ,
  p_embedding  TEXT
) AS $$
  INSERT INTO netforum_members
    (first_name, last_name, email, type, enabled, last_login, embedding)
  VALUES
    (p_first_name, p_last_name, p_email, p_type, p_enabled, p_last_login, p_embedding::vector)
  ON CONFLICT (email) DO UPDATE SET
    first_name = EXCLUDED.first_name,
    last_name  = EXCLUDED.last_name,
    type       = EXCLUDED.type,
    enabled    = EXCLUDED.enabled,
    last_login = EXCLUDED.last_login,
    embedding  = EXCLUDED.embedding;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION sp_get_existing_netforum_members()
RETURNS TABLE(
  email      TEXT,
  first_name TEXT,
  last_name  TEXT,
  type       TEXT,
  enabled    BOOLEAN,
  last_login TIMESTAMPTZ
) AS $$
  SELECT email, first_name, last_name, type, enabled, last_login FROM netforum_members;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_delete_netforum_member(p_email TEXT) AS $$
  DELETE FROM netforum_members WHERE email = p_email;
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_insert_nf_activity_log(
  p_log_timestamp TIMESTAMPTZ,
  p_first_name    TEXT,
  p_last_name     TEXT,
  p_email         TEXT,
  p_changed_by    TEXT,
  p_notes         TEXT,
  p_embedding     TEXT
) AS $$
  INSERT INTO netforum_activity_logs
    (log_timestamp, first_name, last_name, email, changed_by, notes, embedding)
  VALUES
    (p_log_timestamp, p_first_name, p_last_name, p_email, p_changed_by, p_notes, p_embedding::vector);
$$ LANGUAGE sql;

CREATE OR REPLACE PROCEDURE sp_truncate_nf_activity_logs() AS $$
  TRUNCATE TABLE netforum_activity_logs RESTART IDENTITY;
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────────────────────
-- APP SERVICE: ANN SEMANTIC SEARCH (primary entity tables only)
-- Log/activity data appears in user profiles via sp_lookup_by_email instead.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_search_all_sources(
  p_vector TEXT,
  p_top_k  INTEGER
) RETURNS TABLE(
  source           TEXT,
  first_name       TEXT,
  last_name        TEXT,
  email            TEXT,
  type             TEXT,
  contacts         JSONB,
  enabled          BOOLEAN,
  locked           BOOLEAN,
  passwordlastreset TIMESTAMPTZ,
  last_login       TIMESTAMPTZ,
  sponsor          TEXT,
  group_name       TEXT,
  group_alias      TEXT,
  created_at       TIMESTAMPTZ,
  distance         DOUBLE PRECISION
) AS $$
  WITH candidates AS (
    (SELECT 'active_directory'::text AS source,
            ad.first_name, ad.last_name, ad.email, ad.type, NULL::jsonb AS contacts,
            ad.enabled, ad.locked, ad.passwordlastreset,
            NULL::timestamptz AS last_login, NULL::text AS sponsor,
            NULL::text AS group_name, NULL::text AS group_alias,
            ad.created_at,
            (ad.embedding <=> p_vector::vector)::double precision AS distance
     FROM   active_directory ad
     ORDER  BY ad.embedding <=> p_vector::vector
     LIMIT  p_top_k)

    UNION ALL

    (SELECT 'netforum_members'::text,
            nm.first_name, nm.last_name, nm.email, nm.type, NULL::jsonb,
            nm.enabled, NULL::boolean, NULL::timestamptz,
            nm.last_login, NULL::text,
            NULL::text, NULL::text,
            nm.created_at,
            (nm.embedding <=> p_vector::vector)::double precision
     FROM   netforum_members nm
     ORDER  BY nm.embedding <=> p_vector::vector
     LIMIT  p_top_k)

    UNION ALL

    (SELECT 'external_users'::text,
            eu.first_name, eu.last_name, eu.email, eu.type, NULL::jsonb,
            eu.enabled, NULL::boolean, NULL::timestamptz,
            NULL::timestamptz, eu.sponsor,
            NULL::text, NULL::text,
            eu.created_at,
            (eu.embedding <=> p_vector::vector)::double precision
     FROM   external_users eu
     ORDER  BY eu.embedding <=> p_vector::vector
     LIMIT  p_top_k)

    UNION ALL

    (SELECT 'distribution_groups'::text,
            dg.name, dg.alias, dg.email, 'group'::text, dg.contacts,
            NULL::boolean, NULL::boolean, NULL::timestamptz,
            NULL::timestamptz, NULL::text,
            dg.name, dg.alias,
            dg.created_at,
            (dg.embedding <=> p_vector::vector)::double precision
     FROM   distribution_groups dg
     ORDER  BY dg.embedding <=> p_vector::vector
     LIMIT  p_top_k)
  )
  SELECT * FROM candidates
  ORDER  BY distance
  LIMIT  p_top_k;
$$ LANGUAGE sql STABLE SET hnsw.ef_search = 100;

-- ────────────────────────────────────────────────────────────────────────────
-- APP SERVICE: EMAIL LOOKUP ACROSS ALL SOURCES
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_lookup_by_email(p_email TEXT)
RETURNS TABLE(
  source           TEXT,
  id               INTEGER,
  first_name       TEXT,
  last_name        TEXT,
  email            TEXT,
  type             TEXT,
  contacts         JSONB,
  name             TEXT,
  alias            TEXT,
  enabled          BOOLEAN,
  locked           BOOLEAN,
  passwordlastreset TIMESTAMPTZ,
  last_login       TIMESTAMPTZ,
  sponsor          TEXT,
  created_at       TIMESTAMPTZ,
  sync_timestamp   TIMESTAMPTZ,
  accounts_added   JSONB,
  accounts_removed JSONB,
  notes            TEXT
) AS $$
  SELECT 'active_directory'::text AS source,
         ad.id, ad.first_name, ad.last_name, ad.email, ad.type,
         NULL::jsonb, NULL::text, NULL::text,
         ad.enabled, ad.locked, ad.passwordlastreset,
         NULL::timestamptz, NULL::text,
         ad.created_at,
         NULL::timestamptz, NULL::jsonb, NULL::jsonb, NULL::text
  FROM   active_directory ad
  WHERE  ad.email = p_email

  UNION ALL

  SELECT 'netforum_members'::text,
         nm.id, nm.first_name, nm.last_name, nm.email, nm.type,
         NULL::jsonb, NULL::text, NULL::text,
         nm.enabled, NULL::boolean, NULL::timestamptz,
         nm.last_login, NULL::text,
         nm.created_at,
         NULL::timestamptz, NULL::jsonb, NULL::jsonb, NULL::text
  FROM   netforum_members nm
  WHERE  nm.email = p_email

  UNION ALL

  SELECT 'external_users'::text,
         eu.id, eu.first_name, eu.last_name, eu.email, eu.type,
         NULL::jsonb, NULL::text, NULL::text,
         eu.enabled, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, eu.sponsor,
         eu.created_at,
         NULL::timestamptz, NULL::jsonb, NULL::jsonb, NULL::text
  FROM   external_users eu
  WHERE  eu.email = p_email

  UNION ALL

  SELECT 'distribution_groups'::text,
         dg.id, NULL, NULL, dg.email, 'group'::text,
         dg.contacts, dg.name, dg.alias,
         NULL::boolean, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, NULL::text,
         dg.created_at,
         NULL::timestamptz, NULL::jsonb, NULL::jsonb, NULL::text
  FROM   distribution_groups dg
  WHERE  dg.email = p_email
     OR  EXISTS (
           SELECT 1 FROM jsonb_array_elements(dg.contacts) c
           WHERE  c->>'email' = p_email
         )

  UNION ALL

  SELECT 'distribution_group_sync_logs'::text,
         dsl.id, NULL, NULL, NULL, 'sync-log'::text,
         NULL::jsonb, dsl.group_name, NULL::text,
         NULL::boolean, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, NULL::text,
         dsl.created_at,
         dsl.sync_timestamp,
         dsl.accounts_added, dsl.accounts_removed,
         dsl.notes
  FROM   distribution_group_sync_logs dsl
  WHERE  LOWER(dsl.group_name) = p_email
     OR  dsl.group_name = (SELECT dg2.name FROM distribution_groups dg2 WHERE dg2.email = p_email LIMIT 1)
     OR  EXISTS (
           SELECT 1 FROM jsonb_array_elements(dsl.accounts_added) a
           WHERE  LOWER(a->>'email') = p_email
         )
     OR  EXISTS (
           SELECT 1 FROM jsonb_array_elements(dsl.accounts_removed) a
           WHERE  LOWER(a->>'email') = p_email
         )

  UNION ALL

  SELECT 'active_directory_activity_logs'::text,
         aal.id, aal.first_name, aal.last_name, aal.email, 'activity-log'::text,
         NULL::jsonb, NULL::text, NULL::text,
         NULL::boolean, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, aal.changed_by,
         aal.created_at,
         aal.log_timestamp,
         NULL::jsonb, NULL::jsonb,
         aal.notes
  FROM   active_directory_activity_logs aal
  WHERE  aal.email = p_email

  UNION ALL

  SELECT 'external_user_activity_logs'::text,
         eul.id, eul.first_name, eul.last_name, eul.email, 'activity-log'::text,
         NULL::jsonb, NULL::text, NULL::text,
         NULL::boolean, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, eul.changed_by,
         eul.created_at,
         eul.log_timestamp,
         NULL::jsonb, NULL::jsonb,
         eul.notes
  FROM   external_user_activity_logs eul
  WHERE  eul.email = p_email

  UNION ALL

  SELECT 'netforum_activity_logs'::text,
         nal.id, nal.first_name, nal.last_name, nal.email, 'activity-log'::text,
         NULL::jsonb, NULL::text, NULL::text,
         NULL::boolean, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, nal.changed_by,
         nal.created_at,
         nal.log_timestamp,
         NULL::jsonb, NULL::jsonb,
         nal.notes
  FROM   netforum_activity_logs nal
  WHERE  nal.email = p_email

  UNION ALL

  -- SharePoint On-Prem permissions for this user.
  -- Column mapping: name=site, alias=site_url, type=role,
  --                 sponsor=granted_by, sync_timestamp=granted_at, notes=permission_type
  SELECT 'sharepoint_permissions'::text,
         sp.id, NULL::text, NULL::text, sp.user_email, sp.role,
         NULL::jsonb, sp.site, sp.site_url,
         NULL::boolean, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, sp.granted_by,
         sp.created_at,
         sp.granted_at,
         NULL::jsonb, NULL::jsonb,
         sp.permission_type
  FROM   sharepoint_permissions sp
  WHERE  sp.user_email = p_email

  UNION ALL

  -- M365 group memberships for this user (one row per group they belong to).
  -- Column mapping: name=group_name, alias=group_email, type=role (member|owner),
  --                 contacts=full users array, sponsor=group_type, sync_timestamp=joined_at,
  --                 notes=user source (active_directory|external_users)
  SELECT 'm365_group_memberships'::text,
         mg.id, NULL::text, NULL::text, u->>'email', u->>'role',
         mg.users, mg.group_name, mg.group_email,
         NULL::boolean, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, mg.group_type,
         mg.created_at,
         (u->>'joined_at')::timestamptz,
         NULL::jsonb, NULL::jsonb,
         u->>'source'
  FROM   m365_group_memberships mg,
         jsonb_array_elements(mg.users) u
  WHERE  u->>'email' = p_email

  ORDER BY source, created_at;
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- APP/GENAI: CHANGE LOGS (shared — with optional email filter + configurable limit)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_get_change_logs(
  p_email    TEXT    DEFAULT NULL,
  p_max_rows INTEGER DEFAULT 100
) RETURNS TABLE(
  id           INTEGER,
  source_table TEXT,
  email        TEXT,
  change_type  TEXT,
  field_name   TEXT,
  old_value    TEXT,
  new_value    TEXT,
  detected_at  TIMESTAMPTZ,
  etl_job_id   INTEGER
) AS $$
  SELECT scl.id, scl.source_table, scl.email, scl.change_type,
         scl.field_name, scl.old_value, scl.new_value, scl.detected_at, scl.etl_job_id
  FROM   source_change_logs scl
  WHERE  (p_email IS NULL OR scl.email = p_email)
  ORDER  BY scl.detected_at DESC
  LIMIT  p_max_rows;
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- APP/GENAI: ETL JOB LOGS (shared — configurable limit)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_get_etl_jobs(p_max_rows INTEGER DEFAULT 50)
RETURNS TABLE(
  id                INTEGER,
  service           TEXT,
  phase             TEXT,
  target_table      TEXT,
  status            TEXT,
  records_processed INTEGER,
  records_created   INTEGER,
  records_updated   INTEGER,
  records_deleted   INTEGER,
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ
) AS $$
  SELECT ejl.id, ejl.service, ejl.phase, ejl.target_table, ejl.status,
         ejl.records_processed, ejl.records_created, ejl.records_updated,
         ejl.records_deleted, ejl.error_message, ejl.started_at, ejl.finished_at
  FROM   etl_job_logs ejl
  ORDER  BY ejl.started_at DESC
  LIMIT  p_max_rows;
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- GENAI: FAILED ETL JOBS
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_get_failed_etl_jobs(p_max_rows INTEGER DEFAULT 5)
RETURNS TABLE(
  service       TEXT,
  phase         TEXT,
  target_table  TEXT,
  error_message TEXT,
  started_at    TIMESTAMPTZ
) AS $$
  SELECT ejl.service, ejl.phase, ejl.target_table, ejl.error_message, ejl.started_at
  FROM   etl_job_logs ejl
  WHERE  ejl.status = 'failed'
  ORDER  BY ejl.started_at DESC
  LIMIT  p_max_rows;
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- APP: MULTI-EMAIL SOURCE MEMBERSHIP
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_multi_lookup_emails(p_emails TEXT[])
RETURNS TABLE(source TEXT, email TEXT) AS $$
  SELECT 'active_directory'::text, ad.email
  FROM   active_directory ad WHERE ad.email = ANY(p_emails)
  UNION ALL
  SELECT 'netforum_members'::text, nm.email
  FROM   netforum_members nm WHERE nm.email = ANY(p_emails)
  UNION ALL
  SELECT 'external_users'::text, eu.email
  FROM   external_users eu WHERE eu.email = ANY(p_emails)
  UNION ALL
  SELECT 'distribution_groups'::text, c->>'email'
  FROM   distribution_groups dg, jsonb_array_elements(dg.contacts) c
  WHERE  c->>'email' = ANY(p_emails)
  UNION ALL
  SELECT 'active_directory_activity_logs'::text, aal.email
  FROM   active_directory_activity_logs aal WHERE aal.email = ANY(p_emails)
  UNION ALL
  SELECT 'external_user_activity_logs'::text, eul.email
  FROM   external_user_activity_logs eul WHERE eul.email = ANY(p_emails)
  UNION ALL
  SELECT 'netforum_activity_logs'::text, nal.email
  FROM   netforum_activity_logs nal WHERE nal.email = ANY(p_emails)
  UNION ALL
  SELECT 'sharepoint_permissions'::text, sp.user_email
  FROM   sharepoint_permissions sp WHERE sp.user_email = ANY(p_emails)
  UNION ALL
  SELECT 'm365_group_memberships'::text, u->>'email'
  FROM   m365_group_memberships mg, jsonb_array_elements(mg.users) u
  WHERE  u->>'email' = ANY(p_emails);
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- APP: ANN RE-RANKING (intersection search with search term)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_ann_rerank(p_vector TEXT, p_emails TEXT[])
RETURNS TABLE(email TEXT, distance DOUBLE PRECISION) AS $$
  SELECT ad.email, (ad.embedding <=> p_vector::vector)::double precision AS distance
  FROM   active_directory ad
  WHERE  ad.email = ANY(p_emails)
  ORDER  BY ad.embedding <=> p_vector::vector;
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- APP: DYNAMIC INTERSECTION QUERY
-- Accepts arrays of source names to include/exclude.
-- Uses dynamic SQL internally to build the intersection.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_intersection_search(
  p_sources TEXT[],
  p_exclude TEXT[],
  p_limit   INTEGER DEFAULT 200
) RETURNS TABLE(
  email      TEXT,
  first_name TEXT,
  last_name  TEXT,
  type       TEXT
) AS $$
DECLARE
  v_sql    TEXT;
  v_ctes   TEXT[] := '{}';
  v_source TEXT;
  v_subq   TEXT;
  v_joins  TEXT := '';
  v_exc_joins  TEXT := '';
  v_exc_where  TEXT := '';
  i        INTEGER;
BEGIN
  -- Build CTEs for included sources
  FOR i IN 1..array_length(p_sources, 1) LOOP
    v_source := p_sources[i];
    CASE v_source
      WHEN 'distribution_groups' THEN
        v_subq := 'SELECT c->>''email'' AS email, c->>''first_name'' AS first_name, c->>''last_name'' AS last_name, ''group-member''::text AS type FROM distribution_groups, jsonb_array_elements(contacts) c';
      WHEN 'sharepoint_permissions' THEN
        v_subq := 'SELECT user_email AS email, NULL::text AS first_name, NULL::text AS last_name, role AS type FROM sharepoint_permissions';
      WHEN 'm365_group_memberships' THEN
        v_subq := 'SELECT u->>''email'' AS email, NULL::text AS first_name, NULL::text AS last_name, u->>''role'' AS type FROM m365_group_memberships, jsonb_array_elements(users) u';
      ELSE
        v_subq := format('SELECT email, first_name, last_name, type FROM %I', v_source);
    END CASE;
    v_ctes := array_append(v_ctes, format('src_%s AS (%s)', i - 1, v_subq));
    IF i > 1 THEN
      v_joins := v_joins || format(' JOIN src_%s ON src_%s.email = src_0.email', i - 1, i - 1);
    END IF;
  END LOOP;

  -- Build CTEs for excluded sources
  IF p_exclude IS NOT NULL AND array_length(p_exclude, 1) > 0 THEN
    FOR i IN 1..array_length(p_exclude, 1) LOOP
      v_source := p_exclude[i];
      CASE v_source
        WHEN 'distribution_groups' THEN
          v_subq := 'SELECT c->>''email'' AS email, c->>''first_name'' AS first_name, c->>''last_name'' AS last_name, ''group-member''::text AS type FROM distribution_groups, jsonb_array_elements(contacts) c';
        WHEN 'sharepoint_permissions' THEN
          v_subq := 'SELECT user_email AS email, NULL::text AS first_name, NULL::text AS last_name, role AS type FROM sharepoint_permissions';
        WHEN 'm365_group_memberships' THEN
          v_subq := 'SELECT u->>''email'' AS email, NULL::text AS first_name, NULL::text AS last_name, u->>''role'' AS type FROM m365_group_memberships, jsonb_array_elements(users) u';
        ELSE
          v_subq := format('SELECT email, first_name, last_name, type FROM %I', v_source);
      END CASE;
      v_ctes := array_append(v_ctes, format('exc_%s AS (%s)', i - 1, v_subq));
      v_exc_joins := v_exc_joins || format(' LEFT JOIN exc_%s ON exc_%s.email = src_0.email', i - 1, i - 1);
      IF i = 1 THEN
        v_exc_where := format(' WHERE exc_%s.email IS NULL', i - 1);
      ELSE
        v_exc_where := v_exc_where || format(' AND exc_%s.email IS NULL', i - 1);
      END IF;
    END LOOP;
  END IF;

  v_sql := format(
    'WITH %s SELECT DISTINCT src_0.email, src_0.first_name, src_0.last_name, src_0.type FROM src_0%s%s%s ORDER BY src_0.last_name, src_0.first_name LIMIT %s',
    array_to_string(v_ctes, ', '),
    v_joins,
    v_exc_joins,
    v_exc_where,
    p_limit
  );

  RETURN QUERY EXECUTE v_sql;
END;
$$ LANGUAGE plpgsql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- GENAI: USER LOOKUP BY EMAIL (across 3 person tables)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_get_user_by_email(p_email TEXT)
RETURNS TABLE(
  source            TEXT,
  first_name        TEXT,
  last_name         TEXT,
  email             TEXT,
  type              TEXT,
  enabled           BOOLEAN,
  locked            BOOLEAN,
  passwordlastreset TIMESTAMPTZ,
  last_login        TIMESTAMPTZ,
  sponsor           TEXT
) AS $$
  SELECT 'active_directory'::text, ad.first_name, ad.last_name, ad.email, ad.type,
         ad.enabled, ad.locked, ad.passwordlastreset,
         NULL::timestamptz, NULL::text
  FROM   active_directory ad WHERE ad.email = p_email

  UNION ALL

  SELECT 'netforum_members'::text, nm.first_name, nm.last_name, nm.email, nm.type,
         nm.enabled, NULL::boolean, NULL::timestamptz,
         nm.last_login, NULL::text
  FROM   netforum_members nm WHERE nm.email = p_email

  UNION ALL

  SELECT 'external_users'::text, eu.first_name, eu.last_name, eu.email, eu.type,
         eu.enabled, NULL::boolean, NULL::timestamptz,
         NULL::timestamptz, eu.sponsor
  FROM   external_users eu WHERE eu.email = p_email;
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- GENAI: USER LOOKUP BY NAME (ILIKE across 3 person tables)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_get_user_by_name(p_pattern TEXT, p_limit INTEGER DEFAULT 10)
RETURNS TABLE(
  source            TEXT,
  first_name        TEXT,
  last_name         TEXT,
  email             TEXT,
  type              TEXT,
  enabled           BOOLEAN,
  locked            BOOLEAN,
  passwordlastreset TIMESTAMPTZ,
  last_login        TIMESTAMPTZ,
  sponsor           TEXT
) AS $$
  (SELECT 'active_directory'::text, ad.first_name, ad.last_name, ad.email, ad.type,
          ad.enabled, ad.locked, ad.passwordlastreset,
          NULL::timestamptz, NULL::text
   FROM   active_directory ad
   WHERE  (ad.first_name || ' ' || ad.last_name) ILIKE p_pattern
   LIMIT  p_limit)

  UNION ALL

  (SELECT 'netforum_members'::text, nm.first_name, nm.last_name, nm.email, nm.type,
          nm.enabled, NULL::boolean, NULL::timestamptz,
          nm.last_login, NULL::text
   FROM   netforum_members nm
   WHERE  (nm.first_name || ' ' || nm.last_name) ILIKE p_pattern
   LIMIT  p_limit)

  UNION ALL

  (SELECT 'external_users'::text, eu.first_name, eu.last_name, eu.email, eu.type,
          eu.enabled, NULL::boolean, NULL::timestamptz,
          NULL::timestamptz, eu.sponsor
   FROM   external_users eu
   WHERE  (eu.first_name || ' ' || eu.last_name) ILIKE p_pattern
   LIMIT  p_limit);
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- GENAI: GROUP LOOKUP BY NAME
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_get_groups_by_name(p_pattern TEXT, p_limit INTEGER DEFAULT 5)
RETURNS TABLE(
  name     TEXT,
  alias    TEXT,
  email    TEXT,
  contacts JSONB
) AS $$
  SELECT dg.name, dg.alias, dg.email, dg.contacts
  FROM   distribution_groups dg
  WHERE  dg.name ILIKE p_pattern OR dg.alias ILIKE p_pattern
  LIMIT  p_limit;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION sp_get_sample_groups(p_limit INTEGER DEFAULT 5)
RETURNS TABLE(
  name     TEXT,
  alias    TEXT,
  email    TEXT,
  contacts JSONB
) AS $$
  SELECT dg.name, dg.alias, dg.email, dg.contacts
  FROM   distribution_groups dg
  ORDER  BY dg.name
  LIMIT  p_limit;
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- GENAI: CHAT HISTORY
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sp_get_chat_history(p_session_id UUID, p_limit INTEGER DEFAULT 50)
RETURNS TABLE(role TEXT, content TEXT) AS $$
  SELECT cm.role, cm.content
  FROM   chat_messages cm
  WHERE  cm.session_id = p_session_id
  ORDER  BY cm.created_at
  LIMIT  p_limit;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE PROCEDURE sp_save_chat_message(
  p_session_id UUID,
  p_role       TEXT,
  p_content    TEXT
) AS $$
  INSERT INTO chat_messages (session_id, role, content)
  VALUES (p_session_id, p_role, p_content);
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────────────────────
-- APP SERVICE: ATTRIBUTE-FILTERED ANN SEARCH
-- ────────────────────────────────────────────────────────────────────────────
-- Pre-filters rows by boolean/text attributes BEFORE the ANN distance calc,
-- so only matching records are considered for nearest-neighbour ranking.
-- Pass NULL for any filter parameter to skip that filter.

CREATE OR REPLACE FUNCTION sp_search_filtered(
  p_vector      TEXT,
  p_top_k       INTEGER,
  p_enabled     BOOLEAN,
  p_locked      BOOLEAN,
  p_type        TEXT,
  p_source_type TEXT          -- restrict to a single source table (e.g. 'external_users')
) RETURNS TABLE(
  source           TEXT,
  first_name       TEXT,
  last_name        TEXT,
  email            TEXT,
  type             TEXT,
  contacts         JSONB,
  enabled          BOOLEAN,
  locked           BOOLEAN,
  passwordlastreset TIMESTAMPTZ,
  last_login       TIMESTAMPTZ,
  sponsor          TEXT,
  group_name       TEXT,
  group_alias      TEXT,
  created_at       TIMESTAMPTZ,
  distance         DOUBLE PRECISION
) AS $$
  WITH candidates AS (
    (SELECT 'active_directory'::text AS source,
            ad.first_name, ad.last_name, ad.email, ad.type, NULL::jsonb AS contacts,
            ad.enabled, ad.locked, ad.passwordlastreset,
            NULL::timestamptz AS last_login, NULL::text AS sponsor,
            NULL::text AS group_name, NULL::text AS group_alias,
            ad.created_at,
            (ad.embedding <=> p_vector::vector)::double precision AS distance
     FROM   active_directory ad
     WHERE  (p_enabled IS NULL OR ad.enabled = p_enabled)
       AND  (p_locked  IS NULL OR ad.locked  = p_locked)
       AND  (p_type    IS NULL OR ad.type    = p_type)
       AND  (p_source_type IS NULL OR p_source_type = 'active_directory')
     ORDER  BY ad.embedding <=> p_vector::vector
     LIMIT  p_top_k)

    UNION ALL

    (SELECT 'netforum_members'::text,
            nm.first_name, nm.last_name, nm.email, nm.type, NULL::jsonb,
            nm.enabled, NULL::boolean, NULL::timestamptz,
            nm.last_login, NULL::text,
            NULL::text, NULL::text,
            nm.created_at,
            (nm.embedding <=> p_vector::vector)::double precision
     FROM   netforum_members nm
     WHERE  (p_enabled IS NULL OR nm.enabled = p_enabled)
       AND  (p_locked  IS NULL)  -- netforum has no locked column
       AND  (p_type    IS NULL OR nm.type    = p_type)
       AND  (p_source_type IS NULL OR p_source_type = 'netforum_members')
     ORDER  BY nm.embedding <=> p_vector::vector
     LIMIT  p_top_k)

    UNION ALL

    (SELECT 'external_users'::text,
            eu.first_name, eu.last_name, eu.email, eu.type, NULL::jsonb,
            eu.enabled, NULL::boolean, NULL::timestamptz,
            NULL::timestamptz, eu.sponsor,
            NULL::text, NULL::text,
            eu.created_at,
            (eu.embedding <=> p_vector::vector)::double precision
     FROM   external_users eu
     WHERE  (p_enabled IS NULL OR eu.enabled = p_enabled)
       AND  (p_locked  IS NULL)  -- external_users has no locked column
       AND  (p_type    IS NULL OR eu.type    = p_type)
       AND  (p_source_type IS NULL OR p_source_type = 'external_users')
     ORDER  BY eu.embedding <=> p_vector::vector
     LIMIT  p_top_k)

    UNION ALL

    (SELECT 'distribution_groups'::text,
            dg.name, dg.alias, dg.email, 'group'::text, dg.contacts,
            NULL::boolean, NULL::boolean, NULL::timestamptz,
            NULL::timestamptz, NULL::text,
            dg.name, dg.alias,
            dg.created_at,
            (dg.embedding <=> p_vector::vector)::double precision
     FROM   distribution_groups dg
     WHERE  (p_source_type IS NULL OR p_source_type = 'distribution_groups')
       -- enabled/locked/type filters don't apply to groups; exclude when any is set
       AND  (p_enabled IS NULL AND p_locked IS NULL AND p_type IS NULL
              OR p_source_type = 'distribution_groups')
     ORDER  BY dg.embedding <=> p_vector::vector
     LIMIT  p_top_k)
  )
  SELECT * FROM candidates
  ORDER  BY distance
  LIMIT  p_top_k;
$$ LANGUAGE sql STABLE SET hnsw.ef_search = 100;
-- ============================================================================
-- SHAREPOINT ON-PREM PERMISSIONS ETL PROCEDURES  (etl-sp-line)
-- ============================================================================

-- ── Upsert a single permission record ────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sp_upsert_sharepoint_permission(
  p_user_email      TEXT,
  p_site            TEXT,
  p_site_url        TEXT,
  p_role            TEXT,
  p_permission_type TEXT,
  p_granted_by      TEXT,
  p_granted_at      TIMESTAMPTZ,
  p_embedding       TEXT
) AS $$
  INSERT INTO sharepoint_permissions
    (user_email, site, site_url, role, permission_type, granted_by, granted_at, embedding)
  VALUES
    (p_user_email, p_site, p_site_url, p_role, p_permission_type,
     p_granted_by, p_granted_at, p_embedding::vector)
  ON CONFLICT (user_email, site) DO UPDATE SET
    site_url        = EXCLUDED.site_url,
    role            = EXCLUDED.role,
    permission_type = EXCLUDED.permission_type,
    granted_by      = EXCLUDED.granted_by,
    granted_at      = EXCLUDED.granted_at,
    embedding       = EXCLUDED.embedding;
$$ LANGUAGE sql;

-- ── Fetch all current records for change detection ───────────────────────────
CREATE OR REPLACE FUNCTION sp_get_existing_sharepoint_permissions()
RETURNS TABLE(
  user_email      TEXT,
  site            TEXT,
  role            TEXT,
  permission_type TEXT,
  granted_by      TEXT,
  granted_at      TIMESTAMPTZ
) AS $$
  SELECT user_email, site, role, permission_type, granted_by, granted_at
  FROM   sharepoint_permissions;
$$ LANGUAGE sql STABLE;

-- ── Delete a single permission record ────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sp_delete_sharepoint_permission(
  p_user_email TEXT,
  p_site       TEXT
) AS $$
  DELETE FROM sharepoint_permissions
  WHERE  user_email = p_user_email
    AND  site       = p_site;
$$ LANGUAGE sql;

-- ── Insert a permission change log entry ─────────────────────────────────────
CREATE OR REPLACE PROCEDURE sp_insert_sp_permission_change_log(
  p_log_timestamp TIMESTAMPTZ,
  p_user_email    TEXT,
  p_site          TEXT,
  p_change_type   TEXT,
  p_old_role      TEXT,
  p_new_role      TEXT,
  p_changed_by    TEXT,
  p_notes         TEXT,
  p_embedding     TEXT
) AS $$
  INSERT INTO sharepoint_permission_change_logs
    (log_timestamp, user_email, site, change_type, old_role, new_role,
     changed_by, notes, embedding)
  VALUES
    (p_log_timestamp, p_user_email, p_site, p_change_type, p_old_role, p_new_role,
     p_changed_by, p_notes, p_embedding::vector);
$$ LANGUAGE sql;

-- ── Truncate logs table (re-loaded on each ETL run) ──────────────────────────
CREATE OR REPLACE PROCEDURE sp_truncate_sp_permission_change_logs()
AS $$ TRUNCATE TABLE sharepoint_permission_change_logs; $$ LANGUAGE sql;

-- ============================================================================
-- M365 GROUP MEMBERSHIPS ETL PROCEDURES  (etl-m365-line)
-- ============================================================================

-- ── Upsert a single M365 group record ────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sp_upsert_m365_group(
  p_group_name  TEXT,
  p_group_email TEXT,
  p_group_type  TEXT,
  p_users       TEXT,   -- JSON string
  p_embedding   TEXT
) AS $$
  INSERT INTO m365_group_memberships
    (group_name, group_email, group_type, users, embedding)
  VALUES
    (p_group_name, p_group_email, p_group_type, p_users::jsonb, p_embedding::vector)
  ON CONFLICT (group_email) DO UPDATE SET
    group_name  = EXCLUDED.group_name,
    group_type  = EXCLUDED.group_type,
    users       = EXCLUDED.users,
    embedding   = EXCLUDED.embedding;
$$ LANGUAGE sql;

-- ── Fetch all current records for change detection ───────────────────────────
CREATE OR REPLACE FUNCTION sp_get_existing_m365_groups()
RETURNS TABLE(
  group_email TEXT,
  group_name  TEXT,
  group_type  TEXT,
  users       JSONB
) AS $$
  SELECT group_email, group_name, group_type, users
  FROM   m365_group_memberships;
$$ LANGUAGE sql STABLE;

-- ── Delete a single M365 group record ────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sp_delete_m365_group(p_group_email TEXT) AS $$
  DELETE FROM m365_group_memberships WHERE group_email = p_group_email;
$$ LANGUAGE sql;

-- ── Insert an M365 membership change log entry ───────────────────────────────
CREATE OR REPLACE PROCEDURE sp_insert_m365_membership_change_log(
  p_log_timestamp TIMESTAMPTZ,
  p_group_name    TEXT,
  p_user_email    TEXT,
  p_change_action TEXT,
  p_role          TEXT,
  p_changed_by    TEXT,
  p_notes         TEXT,
  p_embedding     TEXT
) AS $$
  INSERT INTO m365_membership_change_logs
    (log_timestamp, group_name, user_email, change_action, role,
     changed_by, notes, embedding)
  VALUES
    (p_log_timestamp, p_group_name, p_user_email, p_change_action, p_role,
     p_changed_by, p_notes, p_embedding::vector);
$$ LANGUAGE sql;

-- ── Truncate logs table (re-loaded on each ETL run) ──────────────────────────
CREATE OR REPLACE PROCEDURE sp_truncate_m365_membership_change_logs()
AS $$ TRUNCATE TABLE m365_membership_change_logs; $$ LANGUAGE sql;