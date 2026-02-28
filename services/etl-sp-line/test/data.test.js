'use strict';

const primary = require('../data/primary.json');
const logs    = require('../data/logs.json');

// ── primary.json ──────────────────────────────────────────────
describe('etl-sp-line primary.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(primary)).toBe(true);
    expect(primary.length).toBeGreaterThan(0);
  });

  test.each(primary.slice(0, 10))('record %# has required string fields', (record) => {
    expect(typeof record.user).toBe('string');
    expect(typeof record.site).toBe('string');
    expect(typeof record.site_url).toBe('string');
    expect(typeof record.role).toBe('string');
  });

  test.each(primary.slice(0, 10))('record %# user is valid email format', (record) => {
    expect(record.user).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  test.each(primary.slice(0, 10))('record %# role is one of the allowed values', (record) => {
    expect(['Read', 'Edit', 'FullControl']).toContain(record.role);
  });

  test.each(primary.slice(0, 10))('record %# permission_type is Direct or Inherited', (record) => {
    expect(['Direct', 'Inherited']).toContain(record.permission_type);
  });
});

// ── logs.json ─────────────────────────────────────────────────
describe('etl-sp-line logs.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  test.each(logs.slice(0, 10))('log %# has required fields', (log) => {
    expect(typeof log.timestamp).toBe('string');
    expect(typeof log.user_email).toBe('string');
    expect(typeof log.site).toBe('string');
    expect(typeof log.change_type).toBe('string');
    expect(typeof log.changed_by).toBe('string');
    expect(typeof log.notes).toBe('string');
  });

  test.each(logs.slice(0, 10))('log %# timestamp is ISO-like string', (log) => {
    expect(new Date(log.timestamp).toString()).not.toBe('Invalid Date');
  });

  test.each(logs.slice(0, 10))('log %# change_type is one of the allowed values', (log) => {
    expect(['granted', 'modified', 'revoked']).toContain(log.change_type);
  });
});
