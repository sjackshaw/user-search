'use strict';

const { POLICY_RULE_DEFS, validatePolicyValue } = require('../policy');

// ── POLICY_RULE_DEFS ──────────────────────────────────────────────────────────

describe('POLICY_RULE_DEFS', () => {
  it('every rule has a category, valueType, default, and description', () => {
    for (const [key, def] of Object.entries(POLICY_RULE_DEFS)) {
      expect(typeof def.category).toBe('string');
      expect(['string', 'integer', 'boolean', 'enum']).toContain(def.valueType);
      expect(def.default).toBeDefined();
      expect(typeof def.description).toBe('string');
      if (def.valueType === 'enum') {
        expect(Array.isArray(def.enumValues)).toBe(true);
        expect(def.enumValues).toContain(def.default);
      }
      expect(key).toBe(key); // key itself is just the object key — sanity check
    }
  });
});

// ── validatePolicyValue ────────────────────────────────────────────────────────

describe('validatePolicyValue', () => {
  it('rejects unknown rule keys', () => {
    expect(() => validatePolicyValue('not_a_real_key', 'x')).toThrow(/Unknown policy rule_key/);
  });

  it('accepts a valid integer for an integer rule', () => {
    expect(validatePolicyValue('min_group_owners', '2')).toBe('2');
  });

  it('rejects a negative integer', () => {
    expect(() => validatePolicyValue('min_group_owners', '-1')).toThrow(/non-negative integer/);
  });

  it('rejects a non-integer for an integer rule', () => {
    expect(() => validatePolicyValue('inactive_days.license', 'soon')).toThrow(/non-negative integer/);
  });

  it('accepts true/false for a boolean rule', () => {
    expect(validatePolicyValue('check_enabled.stale_guest', 'false')).toBe('false');
    expect(validatePolicyValue('check_enabled.stale_guest', true)).toBe('true');
  });

  it('rejects a non-boolean for a boolean rule', () => {
    expect(() => validatePolicyValue('check_enabled.stale_guest', 'maybe')).toThrow(/requires a boolean/);
  });

  it('accepts a known enum value for a severity rule', () => {
    expect(validatePolicyValue('severity.oversharing_risk', 'high')).toBe('high');
  });

  it('rejects an unknown enum value for a severity rule', () => {
    expect(() => validatePolicyValue('severity.oversharing_risk', 'super-critical')).toThrow(/must be one of/);
  });

  it('accepts a non-empty string for a naming-prefix rule', () => {
    expect(validatePolicyValue('naming_prefix.Security', 'SEC-')).toBe('SEC-');
  });

  it('rejects an empty string for a naming-prefix rule', () => {
    expect(() => validatePolicyValue('naming_prefix.Security', '')).toThrow(/non-empty string/);
  });
});
