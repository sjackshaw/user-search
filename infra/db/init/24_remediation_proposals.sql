-- Automated remediation with human approval — adds a propose/approve/reject/
-- apply lifecycle to governance_violations, modeled on GitHub Copilot's "review
-- then accept" pattern: detection automatically proposes a fix (no human
-- action needed to get a proposal), but nothing is ever applied to a system
-- without an explicit approve_remediation call.

ALTER TABLE governance_violations
  ADD COLUMN IF NOT EXISTS remediation_action       TEXT,       -- rename_group | promote_owner | reassign_owner (NULL = no safe auto-fix known)
  ADD COLUMN IF NOT EXISTS remediation_params        JSONB,      -- action-specific parameters computed at proposal time
  ADD COLUMN IF NOT EXISTS remediation_status        TEXT NOT NULL DEFAULT 'none'
    CHECK (remediation_status IN ('none', 'proposed', 'approved', 'rejected', 'applied', 'failed')),
  ADD COLUMN IF NOT EXISTS remediation_requested_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remediation_decided_by    TEXT,
  ADD COLUMN IF NOT EXISTS remediation_decided_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remediation_applied_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remediation_error         TEXT;

CREATE INDEX IF NOT EXISTS governance_violations_remediation_status_idx
  ON governance_violations (remediation_status) WHERE remediation_status = 'proposed';
