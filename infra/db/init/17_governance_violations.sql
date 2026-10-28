-- Persistent governance violation tracking for the user-card agent.
-- Populated by scan_governance_violations (naming convention, missing/orphaned
-- owners, oversharing risk, stale guests) and read by list_violations,
-- assign_violation, resolve_violation, and the compliance score endpoint.
--
-- Unlike agent_tickets (audit record of agent actions), this table tracks the
-- lifecycle of a detected policy violation: severity, assignee, and age.

CREATE TABLE IF NOT EXISTS governance_violations (
  id              SERIAL       PRIMARY KEY,
  violation_type  TEXT         NOT NULL,                 -- naming_convention | missing_owners | orphaned_resource | oversharing_risk | stale_guest
  resource_type   TEXT         NOT NULL,                 -- m365_group | sharepoint_site | distribution_group | external_user
  resource_name   TEXT         NOT NULL,
  resource_id     TEXT,                                   -- email / site_url / group_email, when available
  severity        TEXT         NOT NULL DEFAULT 'medium', -- low | medium | high | critical
  status          TEXT         NOT NULL DEFAULT 'open',   -- open | acknowledged | resolved
  assigned_to     TEXT,
  details         JSONB        NOT NULL DEFAULT '{}',
  detected_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (violation_type, resource_type, resource_name)
);

CREATE INDEX IF NOT EXISTS governance_violations_status_idx
  ON governance_violations (status, severity, detected_at DESC);
