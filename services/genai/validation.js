'use strict';

// ── Shared constants for executor validation ──────────────────────────────────

const VALID_SYSTEMS = ['active_directory', 'netforum_members', 'external_users'];

const SYSTEM_LABELS = {
  active_directory: 'Active Directory',
  netforum_members: 'NetForum',
  external_users:   'External Users',
};

// Safe quoted-identifier maps — prevents SQL injection even if allow-lists change
const SAFE_TABLES = {
  active_directory:  '"active_directory"',
  netforum_members:  '"netforum_members"',
  external_users:    '"external_users"',
};

const SAFE_COLUMNS = {
  email:      '"email"',
  first_name: '"first_name"',
  last_name:  '"last_name"',
  type:       '"type"',
  sponsor:    '"sponsor"',
};

function validateTargetSystem(target_system) {
  if (!VALID_SYSTEMS.includes(target_system)) {
    throw new Error(`Invalid target system: ${target_system}`);
  }
}

// Required name prefix per group type — applies to distribution_groups (type
// "Distribution") and m365_group_memberships (Microsoft365 | Security | Distribution).
const GROUP_NAME_PREFIXES = {
  Distribution: 'DL-',
  Security:     'SG-',
  Microsoft365: 'M365-',
};

// Minimum number of role:"owner" members an M365 group must retain.
const MIN_GROUP_OWNERS = 1;

/**
 * Check a group name against the naming convention for its type.
 * `prefixes` defaults to the hardcoded map but may be overridden by policy_rules.
 * Returns { compliant, expectedPrefix } — does not throw.
 */
function checkGroupNamingConvention(groupName, groupType, prefixes = GROUP_NAME_PREFIXES) {
  const expectedPrefix = prefixes[groupType] || null;
  if (!expectedPrefix) return { compliant: true, expectedPrefix: null };
  const compliant = groupName.toUpperCase().startsWith(expectedPrefix.toUpperCase());
  return { compliant, expectedPrefix };
}

// Default severity assigned to each detected violation type.
const VIOLATION_SEVERITY = {
  naming_convention: 'low',
  missing_owners:    'medium',
  orphaned_resource: 'high',
  oversharing_risk:  'critical',
  stale_guest:       'medium',
  inactive_license:  'low',
};

// Points deducted from the compliance score per open violation, by severity.
const SEVERITY_WEIGHT = { critical: 15, high: 8, medium: 4, low: 1 };

/**
 * Compute a 0-100 compliance score from open-violation counts by severity.
 * `weights` defaults to the hardcoded map but may be overridden by policy_rules.
 * Returns { score, deduction } — does not throw.
 */
function computeComplianceScore(countsBySeverity, weights = SEVERITY_WEIGHT) {
  const deduction = Object.entries(weights).reduce(
    (sum, [severity, weight]) => sum + weight * (countsBySeverity[severity] || 0),
    0
  );
  const score = Math.max(0, Math.min(100, 100 - deduction));
  return { score, deduction };
}

function escapeLike(value) {
  return value.replace(/[%_]/g, '\\$&');
}

/**
 * Return a safe quoted SQL identifier for a table, or throw.
 */
function safeTable(target_system) {
  const id = SAFE_TABLES[target_system];
  if (!id) throw new Error(`Invalid target system: ${target_system}`);
  return id;
}

/**
 * Return a safe quoted SQL identifier for a column, or throw.
 */
function safeColumn(field) {
  const id = SAFE_COLUMNS[field];
  if (!id) throw new Error(`Field "${field}" is not an updatable attribute.`);
  return id;
}

module.exports = {
  VALID_SYSTEMS,
  SYSTEM_LABELS,
  SAFE_TABLES,
  SAFE_COLUMNS,
  GROUP_NAME_PREFIXES,
  MIN_GROUP_OWNERS,
  VIOLATION_SEVERITY,
  SEVERITY_WEIGHT,
  validateTargetSystem,
  escapeLike,
  safeTable,
  safeColumn,
  checkGroupNamingConvention,
  computeComplianceScore,
};
