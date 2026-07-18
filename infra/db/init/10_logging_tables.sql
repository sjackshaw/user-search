-- Logging tables for ETL job tracking and source-data change detection.
-- Part of the GenAI expansion: Phase 1 — Create Logging Schemas.

-- ── etl_job_logs ──────────────────────────────────────────────────────────────
-- Records the start, completion, or failure of every runPrimary() / runLogs()
-- phase across all four ETL line services.

CREATE TABLE IF NOT EXISTS etl_job_logs (
  id             SERIAL       PRIMARY KEY,
  service        TEXT         NOT NULL,                 -- e.g. 'etl-ad-line'
  phase          TEXT         NOT NULL,                 -- 'primary' | 'logs'
  target_table   TEXT         NOT NULL,                 -- e.g. 'active_directory'
  status         TEXT         NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  records_processed INTEGER   DEFAULT 0,
  records_created   INTEGER   DEFAULT 0,
  records_updated   INTEGER   DEFAULT 0,
  records_deleted   INTEGER   DEFAULT 0,
  error_message  TEXT,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS etl_job_logs_service_idx    ON etl_job_logs (service);
CREATE INDEX IF NOT EXISTS etl_job_logs_status_idx     ON etl_job_logs (status);
CREATE INDEX IF NOT EXISTS etl_job_logs_started_at_idx ON etl_job_logs (started_at DESC);


-- ── source_change_logs ────────────────────────────────────────────────────────
-- Immutable append-only log of every detected change (create / update / delete)
-- during runPrimary() for person-type tables.

CREATE TABLE IF NOT EXISTS source_change_logs (
  id             SERIAL       PRIMARY KEY,
  source_table   TEXT         NOT NULL,                 -- e.g. 'active_directory'
  email          TEXT         NOT NULL,                 -- record identifier
  change_type    TEXT         NOT NULL,                 -- 'created' | 'updated' | 'deleted'
  field_name     TEXT,                                  -- NULL for create/delete; column name for update
  old_value      TEXT,                                  -- previous value (NULL for creates)
  new_value      TEXT,                                  -- new value (NULL for deletes)
  detected_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  etl_job_id     INTEGER      REFERENCES etl_job_logs(id)
);

CREATE INDEX IF NOT EXISTS source_change_logs_email_idx      ON source_change_logs (email);
CREATE INDEX IF NOT EXISTS source_change_logs_source_idx     ON source_change_logs (source_table);
CREATE INDEX IF NOT EXISTS source_change_logs_detected_idx   ON source_change_logs (detected_at DESC);
CREATE INDEX IF NOT EXISTS source_change_logs_change_type_idx ON source_change_logs (change_type);
