'use strict';

const {
  preprocessQuery,
  extractAttributeFilters,
  parseQuery,
  resolveSource,
} = require('../src/queryParser');

// ── preprocessQuery ───────────────────────────────────────────────────────────

describe('preprocessQuery', () => {
  it('leaves short queries unchanged (≤3 words)', () => {
    expect(preprocessQuery('john smith')).toBe('john smith');
    expect(preprocessQuery('john')).toBe('john');
  });

  it('strips leading conversational preamble', () => {
    expect(preprocessQuery('show me the user john smith')).toBe('user john smith');
    expect(preprocessQuery('find me john smith in the company')).toBe('john smith company');
    expect(preprocessQuery('can you search for john smith in the system'))
      .toBe('john smith system');
  });

  it('strips noise words from longer queries', () => {
    const result = preprocessQuery('find the users who are disabled in the system');
    expect(result).not.toContain(' the ');
    expect(result).not.toContain(' who ');
    expect(result).not.toContain(' are ');
  });

  it('falls back to original if stripping guts the query', () => {
    // All noise words — should fall back
    expect(preprocessQuery('the a an of for on in').length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty string', () => {
    expect(preprocessQuery('')).toBe('');
  });

  it('handles whitespace-only input', () => {
    expect(preprocessQuery('   ')).toBe('');
  });
});

// ── extractAttributeFilters ───────────────────────────────────────────────────

describe('extractAttributeFilters', () => {
  it('detects "disabled" filter', () => {
    const { filters } = extractAttributeFilters('disabled users');
    expect(filters.enabled).toBe(false);
  });

  it('detects "enabled" without matching "active directory"', () => {
    const { filters } = extractAttributeFilters('enabled users');
    expect(filters.enabled).toBe(true);
  });

  it('does not match "active" in "active directory"', () => {
    const { filters } = extractAttributeFilters('active directory users');
    expect(filters.enabled).toBeUndefined();
  });

  it('detects "locked" filter', () => {
    const { filters } = extractAttributeFilters('locked accounts');
    expect(filters.locked).toBe(true);
  });

  it('detects "unlocked" filter', () => {
    const { filters } = extractAttributeFilters('unlocked accounts');
    expect(filters.locked).toBe(false);
  });

  it('detects type=contact filter', () => {
    const { filters } = extractAttributeFilters('type: contact');
    expect(filters.type).toBe('contact');
  });

  it('detects "contacts" as type filter', () => {
    const { filters } = extractAttributeFilters('all contacts in the system');
    expect(filters.type).toBe('contact');
  });

  it('detects "external users" as sourceType filter', () => {
    const { filters } = extractAttributeFilters('external users');
    expect(filters.sourceType).toBe('external_users');
  });

  it('strips matched keywords from cleaned query', () => {
    const { cleanedQuery } = extractAttributeFilters('disabled users named john');
    expect(cleanedQuery).not.toMatch(/disabled/i);
    expect(cleanedQuery).toContain('john');
  });

  it('returns empty filters when no patterns match', () => {
    const { filters } = extractAttributeFilters('john smith');
    expect(Object.keys(filters)).toHaveLength(0);
  });
});

// ── resolveSource ─────────────────────────────────────────────────────────────

describe('resolveSource', () => {
  it.each([
    ['ad', 'active_directory'],
    ['AD', 'active_directory'],
    ['active directory', 'active_directory'],
    ['netforum', 'netforum_members'],
    ['nf', 'netforum_members'],
    ['external users', 'external_users'],
    ['dg', 'distribution_groups'],
    ['distribution groups', 'distribution_groups'],
    ['sp', 'sharepoint_permissions'],
    ['sharepoint', 'sharepoint_permissions'],
    ['m365', 'm365_group_memberships'],
    ['microsoft 365', 'm365_group_memberships'],
  ])('resolves alias "%s" → %s', (alias, expected) => {
    expect(resolveSource(alias)).toBe(expected);
  });

  it('returns null for unrecognised text', () => {
    expect(resolveSource('unknown system')).toBeNull();
    expect(resolveSource('')).toBeNull();
  });
});

// ── parseQuery ────────────────────────────────────────────────────────────────

describe('parseQuery', () => {
  it('falls back to semantic search for plain text', () => {
    const result = parseQuery('john smith');
    expect(result.type).toBe('semantic');
    expect(result.searchTerm).toBe('john smith');
    expect(result.sources).toEqual([]);
  });

  it('detects single source "in AD"', () => {
    const result = parseQuery('users in AD');
    expect(result.type).toBe('intersection');
    expect(result.sources).toContain('active_directory');
  });

  it('detects multi-source intersection', () => {
    const result = parseQuery('users in AD and netforum');
    expect(result.type).toBe('intersection');
    expect(result.sources).toContain('active_directory');
    expect(result.sources).toContain('netforum_members');
  });

  it('supports NOT exclusion syntax', () => {
    const result = parseQuery('in netforum and not in AD');
    expect(result.type).toBe('intersection');
    expect(result.sources).toContain('netforum_members');
    expect(result.exclude).toContain('active_directory');
  });

  it('extracts search term from prefix text', () => {
    const result = parseQuery('john smith in AD and netforum');
    expect(result.type).toBe('intersection');
    expect(result.searchTerm).toContain('john smith');
  });

  it('returns null searchTerm when only sources specified', () => {
    const result = parseQuery('in AD and netforum');
    expect(result.type).toBe('intersection');
    expect(result.searchTerm).toBeNull();
  });

  it('de-duplicates repeated sources', () => {
    const result = parseQuery('in AD and AD');
    expect(result.sources).toHaveLength(1);
  });

  it('handles empty query', () => {
    const result = parseQuery('');
    expect(result.type).toBe('semantic');
    expect(result.searchTerm).toBe('');
  });

  it('treats unresolvable "in" clause as semantic', () => {
    const result = parseQuery('users in some random text');
    expect(result.type).toBe('semantic');
  });
});
