'use strict';

const primary = require('../data/primary.json');
const logs = require('../data/logs.json');

// ── primary.json ──────────────────────────────────────────────
describe('etl-netforum-line primary.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(primary)).toBe(true);
    expect(primary.length).toBeGreaterThan(0);
  });

  test.each(primary.slice(0, 10))('record %# has required string fields', (record) => {
    expect(typeof record.first_name).toBe('string');
    expect(typeof record.last_name).toBe('string');
    expect(typeof record.email).toBe('string');
    expect(typeof record.type).toBe('string');
  });

  test.each(primary.slice(0, 10))('record %# email is valid format', (record) => {
    expect(record.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  test.each(primary.slice(0, 10))('record %# has boolean enabled field', (record) => {
    expect(typeof record.enabled).toBe('boolean');
  });

  test.each(primary.slice(0, 10))('record %# has lastLogin string', (record) => {
    expect(typeof record.lastLogin).toBe('string');
  });
});

// ── logs.json ─────────────────────────────────────────────────
describe('etl-netforum-line logs.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  test.each(logs.slice(0, 10))('log %# has required fields', (log) => {
    expect(typeof log.timestamp).toBe('string');
    expect(typeof log.first_name).toBe('string');
    expect(typeof log.last_name).toBe('string');
    expect(typeof log.email).toBe('string');
    expect(typeof log.changed_by).toBe('string');
    expect(typeof log.notes).toBe('string');
  });

  test.each(logs.slice(0, 10))('log %# timestamp is ISO-like string', (log) => {
    expect(new Date(log.timestamp).toString()).not.toBe('Invalid Date');
  });
});
