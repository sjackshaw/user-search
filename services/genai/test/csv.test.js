'use strict';

const { toCsv, csvEscape } = require('../csv');

// ── csvEscape ──────────────────────────────────────────────────────────────────

describe('csvEscape', () => {
  it('returns an empty string for null/undefined', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('leaves plain values unchanged', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape(42)).toBe('42');
  });

  it('quotes values containing a comma', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
  });

  it('quotes values containing a newline', () => {
    expect(csvEscape('a\nb')).toBe('"a\nb"');
  });

  it('escapes embedded double quotes', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('serialises objects as JSON before escaping', () => {
    expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
  });
});

// ── toCsv ──────────────────────────────────────────────────────────────────────

describe('toCsv', () => {
  it('returns an empty string for no rows', () => {
    expect(toCsv([])).toBe('');
    expect(toCsv(null)).toBe('');
  });

  it('produces a header row from the first object\'s keys', () => {
    const csv = toCsv([{ id: 1, name: 'Alice' }]);
    expect(csv.split('\n')[0]).toBe('id,name');
  });

  it('produces one data row per input object', () => {
    const csv = toCsv([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('1,Alice');
    expect(lines[2]).toBe('2,Bob');
  });

  it('quotes fields that need it', () => {
    const csv = toCsv([{ note: 'hello, world' }]);
    expect(csv.split('\n')[1]).toBe('"hello, world"');
  });
});
