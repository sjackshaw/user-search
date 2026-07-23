'use strict';

const benefits = require('../src/member-benefits');

describe('member benefits helpers', () => {
  test('normaliseEmail trims and lowercases member emails', () => {
    expect(benefits.normaliseEmail('  Ada.Member@Example.COM ')).toBe('ada.member@example.com');
  });

  test('getPlanDetails falls back to medical for unknown plans', () => {
    const plan = benefits.getPlanDetails('unknown');
    expect(plan.planType).toBe('medical');
    expect(plan.name).toBe('Core Medical PPO');
  });

  test('renderDocumentHtml escapes member and document values', () => {
    const html = benefits.renderDocumentHtml(
      'spd',
      { memberId: 'NF-000001', memberEmail: 'member@example.com' },
      { summary: '<script>alert(1)</script>', rows: [{ label: 'Plan', value: 'Medical & Dental' }] },
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Medical &amp; Dental');
  });
});
