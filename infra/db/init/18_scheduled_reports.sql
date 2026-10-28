-- Persisted report snapshots (CSV) for the user-card agent's reporting/export
-- capability. Populated on-demand (generate_report tool) and on a daily
-- schedule (see runScheduledReports() in services/genai/index.js).

CREATE TABLE IF NOT EXISTS scheduled_reports (
  id            SERIAL       PRIMARY KEY,
  report_type   TEXT         NOT NULL,               -- violations | change_logs
  format        TEXT         NOT NULL DEFAULT 'csv',
  row_count     INTEGER      NOT NULL DEFAULT 0,
  content       TEXT         NOT NULL,               -- CSV content
  generated_by  TEXT         NOT NULL DEFAULT 'schedule', -- schedule | agent
  generated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_reports_type_idx
  ON scheduled_reports (report_type, generated_at DESC);
