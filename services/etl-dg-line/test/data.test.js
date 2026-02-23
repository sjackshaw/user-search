'use strict';

const primary = require('../data/primary.json');
const logs = require('../data/logs.json');

// ── primary.json ──────────────────────────────────────────────
describe('etl-dg-line primary.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(primary)).toBe(true);
    expect(primary.length).toBeGreaterThan(0);
  });

  test.each(primary.slice(0, 10))('record %# has required string fields', (record) => {
    expect(typeof record.name).toBe('string');
    expect(typeof record.alias).toBe('string');
    expect(typeof record.email).toBe('string');
  });

  test.each(primary.slice(0, 10))('record %# email is valid format', (record) => {
    expect(record.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  test.each(primary.slice(0, 10))('record %# contacts is an array', (record) => {
    expect(Array.isArray(record.contacts)).toBe(true);
  });
});

// ── logs.json ─────────────────────────────────────────────────
describe('etl-dg-line logs.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  test.each(logs.slice(0, 10))('log %# has required fields', (log) => {
    expect(typeof log.sync_timestamp).toBe('string');
    expect(typeof log.group_name).toBe('string');
    expect(typeof log.notes).toBe('string');
  });

  test.each(logs.slice(0, 10))('log %# sync_timestamp is ISO-like string', (log) => {
    expect(new Date(log.sync_timestamp).toString()).not.toBe('Invalid Date');
  });

  test.each(logs.slice(0, 10))('log %# accounts_added and accounts_removed are arrays', (log) => {
    expect(Array.isArray(log.accounts_added)).toBe(true);
    expect(Array.isArray(log.accounts_removed)).toBe(true);
  });
});
