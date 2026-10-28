'use strict';

const {
  VALID_SYSTEMS,
  SYSTEM_LABELS,
  SAFE_TABLES,
  SAFE_COLUMNS,
  GROUP_NAME_PREFIXES,
  MIN_GROUP_OWNERS,
  SEVERITY_WEIGHT,
  validateTargetSystem,
  escapeLike,
  safeTable,
  safeColumn,
  checkGroupNamingConvention,
  computeComplianceScore,
} = require('../validation');

// ── validateTargetSystem ──────────────────────────────────────────────────────

describe('validateTargetSystem', () => {
  it.each(VALID_SYSTEMS)('accepts valid system "%s"', (system) => {
    expect(() => validateTargetSystem(system)).not.toThrow();
  });

  it('rejects unknown system', () => {
    expect(() => validateTargetSystem('nonexistent')).toThrow(/Invalid target system/);
  });

  it('rejects empty string', () => {
    expect(() => validateTargetSystem('')).toThrow(/Invalid target system/);
  });

  it('rejects SQL injection attempt', () => {
    expect(() => validateTargetSystem('active_directory; DROP TABLE users;--'))
      .toThrow(/Invalid target system/);
  });
});

// ── escapeLike ────────────────────────────────────────────────────────────────

describe('escapeLike', () => {
  it('escapes percent sign', () => {
    expect(escapeLike('100%')).toBe('100\\%');
  });

  it('escapes underscore', () => {
    expect(escapeLike('user_name')).toBe('user\\_name');
  });

  it('escapes multiple special characters', () => {
    expect(escapeLike('%_test_%')).toBe('\\%\\_test\\_\\%');
  });

  it('leaves normal strings unchanged', () => {
    expect(escapeLike('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeLike('')).toBe('');
  });
});

// ── SAFE_TABLES ───────────────────────────────────────────────────────────────

describe('SAFE_TABLES', () => {
  it('has a quoted identifier for every valid system', () => {
    for (const system of VALID_SYSTEMS) {
      expect(SAFE_TABLES[system]).toBeDefined();
      expect(SAFE_TABLES[system]).toMatch(/^"[a-z_]+"$/);
    }
  });

  it('does not have entries outside VALID_SYSTEMS', () => {
    for (const key of Object.keys(SAFE_TABLES)) {
      expect(VALID_SYSTEMS).toContain(key);
    }
  });
});

// ── SAFE_COLUMNS ──────────────────────────────────────────────────────────────

describe('SAFE_COLUMNS', () => {
  const EXPECTED_FIELDS = ['email', 'first_name', 'last_name', 'type', 'sponsor'];

  it('covers all updatable fields', () => {
    for (const field of EXPECTED_FIELDS) {
      expect(SAFE_COLUMNS[field]).toBeDefined();
      expect(SAFE_COLUMNS[field]).toMatch(/^"[a-z_]+"$/);
    }
  });
});

// ── safeTable ─────────────────────────────────────────────────────────────────

describe('safeTable', () => {
  it('returns a quoted identifier for valid systems', () => {
    expect(safeTable('active_directory')).toBe('"active_directory"');
    expect(safeTable('netforum_members')).toBe('"netforum_members"');
  });

  it('throws for invalid system', () => {
    expect(() => safeTable('users; DROP TABLE--')).toThrow(/Invalid target system/);
  });
});

// ── safeColumn ────────────────────────────────────────────────────────────────

describe('safeColumn', () => {
  it('returns a quoted identifier for allowed fields', () => {
    expect(safeColumn('email')).toBe('"email"');
    expect(safeColumn('sponsor')).toBe('"sponsor"');
  });

  it('throws for disallowed field', () => {
    expect(() => safeColumn('password')).toThrow(/not an updatable attribute/);
  });

  it('throws for SQL injection attempt in field name', () => {
    expect(() => safeColumn('email"; DROP TABLE users;--')).toThrow(/not an updatable attribute/);
  });
});

// ── SYSTEM_LABELS ─────────────────────────────────────────────────────────────

describe('SYSTEM_LABELS', () => {
  it('has a human-readable label for every valid system', () => {
    for (const system of VALID_SYSTEMS) {
      expect(typeof SYSTEM_LABELS[system]).toBe('string');
      expect(SYSTEM_LABELS[system].length).toBeGreaterThan(0);
    }
  });
});

// ── checkGroupNamingConvention ────────────────────────────────────────────────

describe('checkGroupNamingConvention', () => {
  it('has a required prefix for every group type', () => {
    for (const groupType of Object.keys(GROUP_NAME_PREFIXES)) {
      expect(typeof GROUP_NAME_PREFIXES[groupType]).toBe('string');
      expect(GROUP_NAME_PREFIXES[groupType].length).toBeGreaterThan(0);
    }
  });

  it('flags a distribution group missing the DL- prefix', () => {
    const result = checkGroupNamingConvention('Group 761', 'Distribution');
    expect(result.compliant).toBe(false);
    expect(result.expectedPrefix).toBe('DL-');
  });

  it('accepts a compliant distribution group name', () => {
    expect(checkGroupNamingConvention('DL-All Staff', 'Distribution').compliant).toBe(true);
  });

  it('is case-insensitive when matching the prefix', () => {
    expect(checkGroupNamingConvention('dl-all staff', 'Distribution').compliant).toBe(true);
  });

  it('flags a Security group missing the SG- prefix', () => {
    const result = checkGroupNamingConvention('SOC', 'Security');
    expect(result.compliant).toBe(false);
    expect(result.expectedPrefix).toBe('SG-');
  });

  it('flags a Microsoft365 group missing the M365- prefix', () => {
    const result = checkGroupNamingConvention('Design', 'Microsoft365');
    expect(result.compliant).toBe(false);
    expect(result.expectedPrefix).toBe('M365-');
  });

  it('treats an unknown group type as compliant (no rule defined)', () => {
    expect(checkGroupNamingConvention('Anything', 'Unknown')).toEqual({ compliant: true, expectedPrefix: null });
  });
});

// ── MIN_GROUP_OWNERS ──────────────────────────────────────────────────────────

describe('MIN_GROUP_OWNERS', () => {
  it('defaults to at least one required owner', () => {
    expect(MIN_GROUP_OWNERS).toBeGreaterThanOrEqual(1);
  });
});

// ── computeComplianceScore ─────────────────────────────────────────────────────

describe('computeComplianceScore', () => {
  it('returns a perfect score with no violations', () => {
    expect(computeComplianceScore({})).toEqual({ score: 100, deduction: 0 });
  });

  it('deducts points per severity weight', () => {
    const { score, deduction } = computeComplianceScore({ low: 2 });
    expect(deduction).toBe(2 * SEVERITY_WEIGHT.low);
    expect(score).toBe(100 - deduction);
  });

  it('weighs critical violations more heavily than low ones', () => {
    const critical = computeComplianceScore({ critical: 1 });
    const low = computeComplianceScore({ low: 1 });
    expect(critical.score).toBeLessThan(low.score);
  });

  it('never drops below zero', () => {
    const { score } = computeComplianceScore({ critical: 100 });
    expect(score).toBe(0);
  });

  it('never exceeds 100', () => {
    const { score } = computeComplianceScore({});
    expect(score).toBeLessThanOrEqual(100);
  });
});
