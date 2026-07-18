'use strict';

const primary = require('../data/primary.json');
const logs    = require('../data/logs.json');

// ── primary.json ──────────────────────────────────────────────
describe('etl-m365-line primary.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(primary)).toBe(true);
    expect(primary.length).toBeGreaterThan(0);
  });

  test.each(primary.slice(0, 10))('record %# has required string fields', (record) => {
    expect(typeof record.group).toBe('string');
    expect(typeof record.group_email).toBe('string');
    expect(typeof record.group_type).toBe('string');
  });

  test.each(primary.slice(0, 10))('record %# group_email is valid email format', (record) => {
    expect(record.group_email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  test.each(primary.slice(0, 10))('record %# users is a non-empty array', (record) => {
    expect(Array.isArray(record.users)).toBe(true);
    expect(record.users.length).toBeGreaterThan(0);
  });

  test.each(primary.slice(0, 10))('record %# group_type is one of the allowed values', (record) => {
    expect(['Microsoft365', 'Security', 'Distribution']).toContain(record.group_type);
  });

  test.each(primary.slice(0, 10))('record %# each user has email, role, source and joined_at', (record) => {
    for (const user of record.users.slice(0, 5)) {
      expect(typeof user.email).toBe('string');
      expect(['member', 'owner']).toContain(user.role);
      expect(['active_directory', 'external_users']).toContain(user.source);
      expect(typeof user.joined_at).toBe('string');
    }
  });
});

// ── logs.json ─────────────────────────────────────────────────
describe('etl-m365-line logs.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  test.each(logs.slice(0, 10))('log %# has required fields', (log) => {
    expect(typeof log.timestamp).toBe('string');
    expect(typeof log.group_name).toBe('string');
    expect(typeof log.user_email).toBe('string');
    expect(typeof log.change_action).toBe('string');
    expect(typeof log.changed_by).toBe('string');
    expect(typeof log.notes).toBe('string');
  });

  test.each(logs.slice(0, 10))('log %# timestamp is ISO-like string', (log) => {
    expect(new Date(log.timestamp).toString()).not.toBe('Invalid Date');
  });

  test.each(logs.slice(0, 10))('log %# change_action is added or removed', (log) => {
    expect(['added', 'removed']).toContain(log.change_action);
  });
});
