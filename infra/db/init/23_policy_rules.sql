-- Configurable policy/rule engine: moves governance thresholds out of hardcoded
-- constants (services/genai/validation.js) into a DB table an admin can edit at
-- runtime via the set_policy_rule / reset_policy_rule agent tools — no redeploy.
-- Only known rule_key values (POLICY_RULE_DEFS in services/genai/policy.js) are
-- ever written; an empty table means "use all hardcoded defaults" (row presence
-- = explicit override).

CREATE TABLE IF NOT EXISTS policy_rules (
  id          SERIAL       PRIMARY KEY,
  rule_key    TEXT         NOT NULL UNIQUE, -- e.g. 'naming_prefix.Security', 'min_group_owners'
  category    TEXT         NOT NULL,        -- naming_prefix | ownership | severity | scoring | thresholds | check_enabled
  value       TEXT         NOT NULL,
  description TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policy_rules_category_idx ON policy_rules (category);
