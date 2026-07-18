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
  validateTargetSystem,
  escapeLike,
  safeTable,
  safeColumn,
};
