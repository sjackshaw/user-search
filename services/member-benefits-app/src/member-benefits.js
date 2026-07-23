'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PLAN_DETAILS = {
  medical: {
    name: 'Core Medical PPO',
    deductible: 1800,
    outOfPocketMax: 6500,
    coverage: 'Primary and specialist visits, inpatient care, emergency care, and preventive services.',
  },
  dental: {
    name: 'Dental Plus',
    deductible: 75,
    outOfPocketMax: 1500,
    coverage: 'Preventive cleanings, basic restorative care, oral surgery, and major dental services.',
  },
  vision: {
    name: 'Vision Select',
    deductible: 0,
    outOfPocketMax: 450,
    coverage: 'Annual eye exam, lenses, frames or contact lens allowance, and medical eye care discounts.',
  },
  rx: {
    name: 'Prescription Advantage',
    deductible: 250,
    outOfPocketMax: 2200,
    coverage: 'Retail and mail-order prescriptions across generic, preferred, and specialty tiers.',
  },
  mental_health: {
    name: 'Behavioral Health Support',
    deductible: 300,
    outOfPocketMax: 2500,
    coverage: 'Therapy, psychiatry, virtual visits, crisis support, and outpatient programs.',
  },
};

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function dollars(value) {
  return Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mapClaim(row) {
  return {
    memberId: row.member_id,
    memberEmail: row.member_email,
    claimId: row.claim_id,
    claimType: row.claim_type,
    serviceDate: row.service_date ? new Date(row.service_date).toISOString().slice(0, 10) : null,
    provider: row.provider,
    amountBilled: Number(row.amount_billed || 0),
    amountPaid: Number(row.amount_paid || 0),
    planYear: row.plan_year,
    status: row.status,
  };
}

async function resolveMember(pool, requestedEmail) {
  const email = normaliseEmail(requestedEmail);
  if (email) {
    const { rows } = await pool.query(
      `SELECT member_id, member_email
       FROM claims
       WHERE lower(member_email) = $1
       ORDER BY member_id
       LIMIT 1`,
      [email],
    );
    if (rows[0]) return { memberId: rows[0].member_id, memberEmail: rows[0].member_email };
    return null;
  }

  const { rows } = await pool.query(
    `SELECT member_id, member_email
     FROM claims
     ORDER BY member_email
     LIMIT 1`,
  );
  if (!rows[0]) return null;
  return { memberId: rows[0].member_id, memberEmail: rows[0].member_email };
}

async function listMembers(pool, limit = 25) {
  const { rows } = await pool.query(
    `SELECT member_id, member_email, count(*)::int AS claim_count
     FROM claims
     GROUP BY member_id, member_email
     ORDER BY member_email
     LIMIT $1`,
    [limit],
  );
  return rows.map(row => ({
    memberId: row.member_id,
    memberEmail: row.member_email,
    claimCount: row.claim_count,
  }));
}

async function getOpenClaims(pool, member) {
  const { rows } = await pool.query(
    `SELECT *
     FROM claims
     WHERE member_id = $1
       AND status IN ('pending', 'appealed')
     ORDER BY service_date DESC, claim_id
     LIMIT 100`,
    [member.memberId],
  );
  return rows.map(mapClaim);
}

async function getClaimsSummary(pool, member, planYear) {
  const params = [member.memberId];
  let yearClause = '';
  if (planYear) {
    params.push(planYear);
    yearClause = 'AND plan_year = $2';
  }

  const { rows } = await pool.query(
    `SELECT plan_year,
            claim_type,
            count(*)::int AS claim_count,
            sum(amount_billed)::numeric(12,2) AS billed,
            sum(amount_paid)::numeric(12,2) AS paid,
            sum(amount_billed - amount_paid)::numeric(12,2) AS member_responsibility
     FROM claims
     WHERE member_id = $1 ${yearClause}
     GROUP BY plan_year, claim_type
     ORDER BY plan_year DESC, claim_type`,
    params,
  );

  return rows.map(row => ({
    planYear: row.plan_year,
    claimType: row.claim_type,
    claimCount: row.claim_count,
    billed: Number(row.billed || 0),
    paid: Number(row.paid || 0),
    memberResponsibility: Number(row.member_responsibility || 0),
  }));
}

async function searchClaims(pool, member, query) {
  const q = String(query || '').trim();
  const params = [member.memberId];
  let filter = '';
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    filter = `AND (
      lower(claim_type) LIKE $2 OR
      lower(provider) LIKE $2 OR
      lower(status) LIKE $2 OR
      lower(claim_id) LIKE $2
    )`;
  }

  const { rows } = await pool.query(
    `SELECT *
     FROM claims
     WHERE member_id = $1 ${filter}
     ORDER BY service_date DESC, claim_id
     LIMIT 100`,
    params,
  );
  return rows.map(mapClaim);
}

function getPlanDetails(planType = 'medical') {
  const key = PLAN_DETAILS[planType] ? planType : 'medical';
  return { planType: key, ...PLAN_DETAILS[key] };
}

async function getDeductibleStatus(pool, member, planYear = new Date().getFullYear()) {
  const { rows } = await pool.query(
    `SELECT claim_type,
            sum(amount_billed - amount_paid)::numeric(12,2) AS member_spend
     FROM claims
     WHERE member_id = $1
       AND plan_year = $2
     GROUP BY claim_type
     ORDER BY claim_type`,
    [member.memberId, planYear],
  );

  return rows.map(row => {
    const plan = PLAN_DETAILS[row.claim_type] || PLAN_DETAILS.medical;
    const memberSpend = Number(row.member_spend || 0);
    return {
      planYear,
      claimType: row.claim_type,
      planName: plan.name,
      deductible: plan.deductible,
      memberSpend,
      deductibleRemaining: Math.max(plan.deductible - memberSpend, 0),
      deductibleMet: memberSpend >= plan.deductible,
    };
  });
}

async function getClaimById(pool, member, claimId) {
  const { rows } = await pool.query(
    `SELECT *
     FROM claims
     WHERE member_id = $1
       AND claim_id = $2
     LIMIT 1`,
    [member.memberId, claimId],
  );
  return rows[0] ? mapClaim(rows[0]) : null;
}

function renderDocumentHtml(type, member, payload) {
  const title = {
    annual_spending: 'Annual Spending Summary',
    tax_document: 'Healthcare Expense Tax Summary',
    spd: 'Summary Plan Description',
    eob: 'Explanation of Benefits',
    enrollment_form: 'Enrollment Form',
    beneficiary_form: 'Beneficiary Designation Form',
  }[type] || 'Member Benefits Document';

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const rowHtml = rows.map(row => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td>${escapeHtml(row.value)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Georgia, serif; color: #1e293b; margin: 40px; line-height: 1.5; }
    h1 { color: #0f766e; margin-bottom: 0; }
    .meta { color: #64748b; margin: 4px 0 24px; }
    table { border-collapse: collapse; width: 100%; margin-top: 24px; }
    td { border-bottom: 1px solid #cbd5e1; padding: 10px 8px; vertical-align: top; }
    td:first-child { width: 34%; font-weight: 700; color: #334155; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Member ${escapeHtml(member.memberId)} · ${escapeHtml(member.memberEmail)} · Generated ${escapeHtml(new Date().toISOString())}</p>
  <p>${escapeHtml(payload.summary)}</p>
  <table>${rowHtml}</table>
</body>
</html>`;
}

function writeDocument(documentDir, member, type, html) {
  fs.mkdirSync(documentDir, { recursive: true });
  const safeType = type.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${member.memberId}-${safeType}-${id}.html`;
  fs.writeFileSync(path.join(documentDir, filename), html);
  return filename;
}

module.exports = {
  PLAN_DETAILS,
  dollars,
  escapeHtml,
  getClaimById,
  getClaimsSummary,
  getDeductibleStatus,
  getOpenClaims,
  getPlanDetails,
  listMembers,
  normaliseEmail,
  renderDocumentHtml,
  resolveMember,
  searchClaims,
  writeDocument,
};
