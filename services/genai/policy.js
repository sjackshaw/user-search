'use strict';

const {
  GROUP_NAME_PREFIXES,
  MIN_GROUP_OWNERS,
  VIOLATION_SEVERITY,
  SEVERITY_WEIGHT,
} = require('./validation');

const DEFAULT_INACTIVE_DAYS = { license: 90, guest: 90 };
const SEVERITY_VALUES = ['low', 'medium', 'high', 'critical'];

// Every rule the engine understands: category (for grouping/display), valueType
// (for validation/casting), default (hardcoded fallback), and a human description.
// set_policy_rule only accepts keys defined here — unknown keys are rejected.
const POLICY_RULE_DEFS = {
  'naming_prefix.Distribution': { category: 'naming_prefix', valueType: 'string', default: GROUP_NAME_PREFIXES.Distribution, description: 'Required name prefix for Distribution groups.' },
  'naming_prefix.Security':     { category: 'naming_prefix', valueType: 'string', default: GROUP_NAME_PREFIXES.Security, description: 'Required name prefix for Security groups.' },
  'naming_prefix.Microsoft365': { category: 'naming_prefix', valueType: 'string', default: GROUP_NAME_PREFIXES.Microsoft365, description: 'Required name prefix for Microsoft365 groups.' },

  'min_group_owners': { category: 'ownership', valueType: 'integer', default: String(MIN_GROUP_OWNERS), description: 'Minimum number of owners required per M365 group.' },

  'severity.naming_convention': { category: 'severity', valueType: 'enum', enumValues: SEVERITY_VALUES, default: VIOLATION_SEVERITY.naming_convention, description: 'Severity assigned to naming_convention violations.' },
  'severity.missing_owners':    { category: 'severity', valueType: 'enum', enumValues: SEVERITY_VALUES, default: VIOLATION_SEVERITY.missing_owners, description: 'Severity assigned to missing_owners violations.' },
  'severity.orphaned_resource': { category: 'severity', valueType: 'enum', enumValues: SEVERITY_VALUES, default: VIOLATION_SEVERITY.orphaned_resource, description: 'Severity assigned to orphaned_resource violations.' },
  'severity.oversharing_risk':  { category: 'severity', valueType: 'enum', enumValues: SEVERITY_VALUES, default: VIOLATION_SEVERITY.oversharing_risk, description: 'Severity assigned to oversharing_risk violations.' },
  'severity.stale_guest':       { category: 'severity', valueType: 'enum', enumValues: SEVERITY_VALUES, default: VIOLATION_SEVERITY.stale_guest, description: 'Severity assigned to stale_guest violations.' },
  'severity.inactive_license':  { category: 'severity', valueType: 'enum', enumValues: SEVERITY_VALUES, default: VIOLATION_SEVERITY.inactive_license, description: 'Severity assigned to inactive_license violations.' },

  'severity_weight.critical': { category: 'scoring', valueType: 'integer', default: String(SEVERITY_WEIGHT.critical), description: 'Compliance-score points deducted per open critical violation.' },
  'severity_weight.high':     { category: 'scoring', valueType: 'integer', default: String(SEVERITY_WEIGHT.high), description: 'Compliance-score points deducted per open high violation.' },
  'severity_weight.medium':   { category: 'scoring', valueType: 'integer', default: String(SEVERITY_WEIGHT.medium), description: 'Compliance-score points deducted per open medium violation.' },
  'severity_weight.low':      { category: 'scoring', valueType: 'integer', default: String(SEVERITY_WEIGHT.low), description: 'Compliance-score points deducted per open low violation.' },

  'inactive_days.license': { category: 'thresholds', valueType: 'integer', default: String(DEFAULT_INACTIVE_DAYS.license), description: 'Days of inactivity before a license is flagged as unused.' },
  'inactive_days.guest':   { category: 'thresholds', valueType: 'integer', default: String(DEFAULT_INACTIVE_DAYS.guest), description: 'Days of inactivity before a guest account is flagged as stale.' },

  'check_enabled.naming_convention': { category: 'check_enabled', valueType: 'boolean', default: 'true', description: 'Whether naming-convention scanning runs.' },
  'check_enabled.missing_owners':    { category: 'check_enabled', valueType: 'boolean', default: 'true', description: 'Whether minimum-owners scanning runs.' },
  'check_enabled.orphaned_resource': { category: 'check_enabled', valueType: 'boolean', default: 'true', description: 'Whether orphaned-resource scanning runs.' },
  'check_enabled.oversharing_risk':  { category: 'check_enabled', valueType: 'boolean', default: 'true', description: 'Whether oversharing-risk scanning runs.' },
  'check_enabled.stale_guest':       { category: 'check_enabled', valueType: 'boolean', default: 'true', description: 'Whether stale-guest scanning runs.' },
  'check_enabled.inactive_license':  { category: 'check_enabled', valueType: 'boolean', default: 'true', description: 'Whether inactive-license scanning runs.' },
};

function castValue(ruleKey, rawValue) {
  const def = POLICY_RULE_DEFS[ruleKey];
  switch (def.valueType) {
    case 'integer': return parseInt(rawValue, 10);
    case 'boolean': return rawValue === 'true';
    default:        return rawValue;
  }
}

/**
 * Validate a candidate value for a rule key against its declared type/enum.
 * Returns the normalised string to store, or throws.
 */
function validatePolicyValue(ruleKey, value) {
  const def = POLICY_RULE_DEFS[ruleKey];
  if (!def) {
    throw new Error(`Unknown policy rule_key: "${ruleKey}". Valid keys: ${Object.keys(POLICY_RULE_DEFS).join(', ')}`);
  }

  if (def.valueType === 'integer') {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 0) throw new Error(`"${ruleKey}" requires a non-negative integer, got: ${value}`);
    return String(n);
  }
  if (def.valueType === 'boolean') {
    if (value !== true && value !== false && value !== 'true' && value !== 'false') {
      throw new Error(`"${ruleKey}" requires a boolean, got: ${value}`);
    }
    return String(value === true || value === 'true');
  }
  if (def.valueType === 'enum') {
    if (!def.enumValues.includes(value)) {
      throw new Error(`"${ruleKey}" must be one of: ${def.enumValues.join(', ')} — got: ${value}`);
    }
    return value;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${ruleKey}" requires a non-empty string.`);
  }
  return value;
}

/**
 * Load all policy rules, merge overrides over the hardcoded defaults, and
 * resolve them into the shaped objects consumed by the governance executors.
 */
async function loadPolicyRules(pool) {
  const { rows } = await pool.query('SELECT rule_key, value FROM policy_rules');
  const overrides = new Map(rows.map(r => [r.rule_key, r.value]));

  const resolved = {};
  for (const [ruleKey, def] of Object.entries(POLICY_RULE_DEFS)) {
    resolved[ruleKey] = castValue(ruleKey, overrides.has(ruleKey) ? overrides.get(ruleKey) : def.default);
  }

  return {
    namingPrefixes: {
      Distribution: resolved['naming_prefix.Distribution'],
      Security:     resolved['naming_prefix.Security'],
      Microsoft365: resolved['naming_prefix.Microsoft365'],
    },
    minGroupOwners: resolved['min_group_owners'],
    violationSeverity: {
      naming_convention: resolved['severity.naming_convention'],
      missing_owners:    resolved['severity.missing_owners'],
      orphaned_resource: resolved['severity.orphaned_resource'],
      oversharing_risk:  resolved['severity.oversharing_risk'],
      stale_guest:       resolved['severity.stale_guest'],
      inactive_license:  resolved['severity.inactive_license'],
    },
    severityWeight: {
      critical: resolved['severity_weight.critical'],
      high:     resolved['severity_weight.high'],
      medium:   resolved['severity_weight.medium'],
      low:      resolved['severity_weight.low'],
    },
    inactiveDays: {
      license: resolved['inactive_days.license'],
      guest:   resolved['inactive_days.guest'],
    },
    checkEnabled: {
      naming_convention: resolved['check_enabled.naming_convention'],
      missing_owners:    resolved['check_enabled.missing_owners'],
      orphaned_resource: resolved['check_enabled.orphaned_resource'],
      oversharing_risk:  resolved['check_enabled.oversharing_risk'],
      stale_guest:       resolved['check_enabled.stale_guest'],
      inactive_license:  resolved['check_enabled.inactive_license'],
    },
  };
}

/**
 * List every known rule with its effective value, whether it's overridden,
 * and audit metadata — for the list_policy_rules tool / dashboard.
 */
async function listPolicyRules(pool) {
  const { rows } = await pool.query('SELECT rule_key, value, updated_by, updated_at FROM policy_rules');
  const overrides = new Map(rows.map(r => [r.rule_key, r]));

  return Object.entries(POLICY_RULE_DEFS).map(([ruleKey, def]) => {
    const override = overrides.get(ruleKey);
    return {
      ruleKey,
      category: def.category,
      description: def.description,
      value: override ? override.value : def.default,
      defaultValue: def.default,
      isOverride: Boolean(override),
      updatedBy: override?.updated_by || null,
      updatedAt: override?.updated_at || null,
    };
  });
}

async function setPolicyRule(pool, ruleKey, value, updatedBy) {
  const normalised = validatePolicyValue(ruleKey, value);
  const def = POLICY_RULE_DEFS[ruleKey];

  const { rows } = await pool.query(
    `INSERT INTO policy_rules (rule_key, category, value, description, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (rule_key) DO UPDATE SET
       value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING rule_key, category, value, updated_by, updated_at`,
    [ruleKey, def.category, normalised, def.description, updatedBy || null]
  );

  return rows[0];
}

async function resetPolicyRule(pool, ruleKey) {
  if (!POLICY_RULE_DEFS[ruleKey]) {
    throw new Error(`Unknown policy rule_key: "${ruleKey}". Valid keys: ${Object.keys(POLICY_RULE_DEFS).join(', ')}`);
  }
  await pool.query('DELETE FROM policy_rules WHERE rule_key = $1', [ruleKey]);
  return { ruleKey, value: POLICY_RULE_DEFS[ruleKey].default, isOverride: false };
}

module.exports = {
  POLICY_RULE_DEFS,
  loadPolicyRules,
  listPolicyRules,
  setPolicyRule,
  resetPolicyRule,
  validatePolicyValue,
};
