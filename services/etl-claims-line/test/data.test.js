'use strict';

const primary = require('../data/primary.json');
const logs = require('../data/logs.json');

describe('etl-claims-line primary.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(primary)).toBe(true);
    expect(primary.length).toBeGreaterThan(0);
  });

  test.each(primary.slice(0, 10))('record %# has required claim fields', (record) => {
    expect(typeof record.memberId).toBe('string');
    expect(typeof record.memberEmail).toBe('string');
    expect(typeof record.claimId).toBe('string');
    expect(typeof record.claimType).toBe('string');
    expect(typeof record.serviceDate).toBe('string');
    expect(typeof record.provider).toBe('string');
    expect(typeof record.status).toBe('string');
    expect(typeof record.planYear).toBe('number');
  });

  test.each(primary.slice(0, 10))('record %# has valid email and amounts', (record) => {
    expect(record.memberEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(typeof record.amountBilled).toBe('number');
    expect(typeof record.amountPaid).toBe('number');
    expect(record.amountBilled).toBeGreaterThanOrEqual(record.amountPaid);
  });
});


describe('etl-claims-line logs.json', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  test.each(logs.slice(0, 10))('log %# has required fields', (log) => {
    expect(typeof log.logTimestamp).toBe('string');
    expect(typeof log.memberId).toBe('string');
    expect(typeof log.memberEmail).toBe('string');
    expect(typeof log.claimId).toBe('string');
    expect(typeof log.eventType).toBe('string');
    expect(typeof log.notes).toBe('string');
  });

  test.each(logs.slice(0, 10))('log %# timestamp is valid', (log) => {
    expect(new Date(log.logTimestamp).toString()).not.toBe('Invalid Date');
  });
});