'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const benefits = require('./member-benefits');

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);
const API_KEY = process.env.API_KEY || '';
const DOCUMENT_DIR = process.env.DOCUMENT_DIR || path.join(__dirname, '..', 'generated-docs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@postgres:5432/appdb',
});

app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const injected = html.replace(
    '</head>',
    `<script>window.APP_API_KEY=${JSON.stringify(API_KEY)};</script>\n</head>`,
  );
  res.type('html').send(injected);
});

app.use('/documents', express.static(DOCUMENT_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'member-benefits-app' });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ status: 'error' });
  }
});

app.use('/api', async (req, res, next) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const requestedEmail = req.headers['x-member-email'] || req.query.memberEmail || req.body?.memberEmail;
  try {
    const member = await benefits.resolveMember(pool, requestedEmail);
    if (!member) return res.status(404).json({ error: 'Member not found in claims data' });
    req.user = member;
    return next();
  } catch (err) {
    console.error('Member resolution failed:', err);
    return res.status(500).json({ error: 'Unable to resolve member' });
  }
});

app.get('/api/session', async (req, res) => {
  const members = await benefits.listMembers(pool, 40);
  res.json({ member: req.user, sampleMembers: members });
});

app.get('/api/claims/open', async (req, res) => {
  try {
    const claims = await benefits.getOpenClaims(pool, req.user);
    res.json({ member: req.user, claims });
  } catch (err) {
    console.error('Open claims failed:', err);
    res.status(500).json({ error: 'Unable to load open claims' });
  }
});

app.get('/api/claims/summary', async (req, res) => {
  try {
    const planYear = req.query.planYear ? parseInt(req.query.planYear, 10) : null;
    const summary = await benefits.getClaimsSummary(pool, req.user, planYear);
    res.json({ member: req.user, summary });
  } catch (err) {
    console.error('Claims summary failed:', err);
    res.status(500).json({ error: 'Unable to load claims summary' });
  }
});

app.get('/api/claims/search', async (req, res) => {
  try {
    const claims = await benefits.searchClaims(pool, req.user, req.query.q || '');
    res.json({ member: req.user, claims });
  } catch (err) {
    console.error('Claims search failed:', err);
    res.status(500).json({ error: 'Unable to search claims' });
  }
});

app.get('/api/plan', (req, res) => {
  const plan = benefits.getPlanDetails(req.query.type || 'medical');
  res.json({ member: req.user, plan });
});

app.get('/api/deductible', async (req, res) => {
  try {
    const planYear = req.query.planYear ? parseInt(req.query.planYear, 10) : new Date().getFullYear();
    const deductible = await benefits.getDeductibleStatus(pool, req.user, planYear);
    res.json({ member: req.user, deductible });
  } catch (err) {
    console.error('Deductible status failed:', err);
    res.status(500).json({ error: 'Unable to load deductible status' });
  }
});

app.post('/api/documents/:type', async (req, res) => {
  try {
    const type = req.params.type;
    const planYear = req.body.planYear || new Date().getFullYear();
    const summary = await benefits.getClaimsSummary(pool, req.user, planYear);
    const rows = [];

    if (type === 'eob') {
      const claim = await benefits.getClaimById(pool, req.user, req.body.claimId);
      if (!claim) return res.status(404).json({ error: 'Claim not found for this member' });
      rows.push(
        { label: 'Claim ID', value: claim.claimId },
        { label: 'Provider', value: claim.provider },
        { label: 'Service date', value: claim.serviceDate },
        { label: 'Status', value: claim.status },
        { label: 'Amount billed', value: benefits.dollars(claim.amountBilled) },
        { label: 'Amount paid', value: benefits.dollars(claim.amountPaid) },
        { label: 'Member responsibility', value: benefits.dollars(claim.amountBilled - claim.amountPaid) },
      );
    } else if (type === 'spd') {
      const plan = benefits.getPlanDetails(req.body.planType || 'medical');
      rows.push(
        { label: 'Plan', value: plan.name },
        { label: 'Coverage', value: plan.coverage },
        { label: 'Deductible', value: benefits.dollars(plan.deductible) },
        { label: 'Out-of-pocket maximum', value: benefits.dollars(plan.outOfPocketMax) },
      );
    } else if (type === 'enrollment_form' || type === 'beneficiary_form') {
      rows.push(
        { label: 'Member ID', value: req.user.memberId },
        { label: 'Member email', value: req.user.memberEmail },
        { label: 'Document status', value: 'Pre-filled for member review and signature' },
      );
    } else {
      for (const row of summary) {
        rows.push({
          label: `${row.planYear} ${row.claimType}`,
          value: `Billed ${benefits.dollars(row.billed)}, paid ${benefits.dollars(row.paid)}, member responsibility ${benefits.dollars(row.memberResponsibility)}`,
        });
      }
    }

    const html = benefits.renderDocumentHtml(type, req.user, {
      summary: `Generated ${type.replace(/_/g, ' ')} for plan year ${planYear}.`,
      rows,
    });
    const filename = benefits.writeDocument(DOCUMENT_DIR, req.user, type, html);
    res.json({
      member: req.user,
      document: {
        type,
        filename,
        url: `/documents/${filename}`,
      },
    });
  } catch (err) {
    console.error('Document generation failed:', err);
    res.status(500).json({ error: 'Unable to generate document' });
  }
});

app.post('/api/bot', async (req, res) => {
  const prompt = String(req.body.prompt || '').toLowerCase();
  try {
    if (prompt.includes('open') || prompt.includes('pending') || prompt.includes('appeal')) {
      const claims = await benefits.getOpenClaims(pool, req.user);
      return res.json({ tool: 'get_open_claims', message: `You have ${claims.length} open claims.`, data: claims });
    }
    if (prompt.includes('deductible')) {
      const deductible = await benefits.getDeductibleStatus(pool, req.user, new Date().getFullYear());
      return res.json({ tool: 'get_deductible_status', message: 'Here is your current deductible status.', data: deductible });
    }
    if (prompt.includes('dental') || prompt.includes('vision') || prompt.includes('medical') || prompt.includes('rx')) {
      const planType = ['dental', 'vision', 'medical', 'rx'].find(type => prompt.includes(type)) || 'medical';
      return res.json({ tool: 'get_plan_details', message: `Here are your ${planType} plan details.`, data: benefits.getPlanDetails(planType) });
    }
    const summary = await benefits.getClaimsSummary(pool, req.user, null);
    return res.json({ tool: 'get_claims_summary', message: 'Here is your claims summary.', data: summary });
  } catch (err) {
    console.error('Bot request failed:', err);
    return res.status(500).json({ error: 'Unable to answer benefits question' });
  }
});

app.listen(PORT, () => {
  console.log(`[member-benefits-app] listening on ${PORT}`);
});
