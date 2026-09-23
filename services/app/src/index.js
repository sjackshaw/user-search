'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT    = parseInt(process.env.PORT || '3000', 10);
const TOP_K   = parseInt(process.env.TOP_K || '20', 10);
const API_KEY = process.env.API_KEY || '';

const { preprocessQuery, extractAttributeFilters, parseQuery } = require('./queryParser');

// ── Postgres ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@postgres:5432/appdb',
});

// ── SBERT model (loaded once at startup) ──────────────────────────────────────
let extractor = null;

async function embed(text) {
  const output = await extractor([text], { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ── ANN search across all four tables ─────────────────────────────────────────
// pgvector's HNSW index is used automatically when we ORDER BY <=> (cosine).
// We UNION results from every source and pick the closest overall.

// ── Stored-procedure SQL calls ────────────────────────────────────────────────
// All query logic lives in PostgreSQL stored procedures (see 12_stored_procedures.sql).
// App code calls them with parameterised arguments via pool.query().

const SP_SEARCH_ALL   = 'SELECT * FROM sp_search_all_sources($1, $2)';
const SP_FILTERED     = 'SELECT * FROM sp_search_filtered($1, $2, $3, $4, $5, $6)';
const SP_LOOKUP       = 'SELECT * FROM sp_lookup_by_email($1)';
const SP_CHANGE_LOGS  = 'SELECT * FROM sp_get_change_logs($1, $2)';
const SP_ETL_JOBS     = 'SELECT * FROM sp_get_etl_jobs($1)';
const SP_MULTI_LOOKUP = 'SELECT * FROM sp_multi_lookup_emails($1)';
const SP_ANN_RERANK   = 'SELECT * FROM sp_ann_rerank($1, $2)';
const SP_INTERSECTION = 'SELECT * FROM sp_intersection_search($1, $2, $3)';



// ── Source-intersection ───────────────────────────────────────────────────────
// Intersection logic now lives in sp_intersection_search() stored procedure.
// App just passes source/exclude arrays and limit.

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.json());

// Serve index.html with the API key injected so the browser client can authenticate
app.get('/', (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const injected = html.replace(
    '</head>',
    `<script>window.APP_API_KEY=${JSON.stringify(API_KEY)};</script>\n</head>`,
  );
  res.type('html').send(injected);
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth guard for all /api routes ───────────────────────────────────────────
// Skipped if API_KEY is not configured (local dev without the env var set).
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorised' });
});

app.get('/api/lookup', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ records: [], changeLogs: [] });

  try {
    const [lookupResult, changeResult] = await Promise.all([
      pool.query(SP_LOOKUP, [email]),
      pool.query(SP_CHANGE_LOGS, [email, 100]),
    ]);

    const records = lookupResult.rows.map(r => ({
      source:            r.source,
      id:                r.id,
      firstName:         r.first_name,
      lastName:          r.last_name,
      email:             r.email,
      type:              r.type,
      name:              r.name,
      alias:             r.alias,
      contacts:          r.contacts,
      enabled:           r.enabled,
      locked:            r.locked,
      passwordLastReset: r.passwordlastreset,
      lastLogin:         r.last_login,
      sponsor:           r.sponsor,
      createdAt:         r.created_at,
      syncTimestamp:     r.sync_timestamp,
      accountsAdded:     r.accounts_added,
      accountsRemoved:   r.accounts_removed,
      notes:             r.notes,
    }));

    const changeLogs = changeResult.rows.map(r => ({
      id:          r.id,
      sourceTable: r.source_table,
      email:       r.email,
      changeType:  r.change_type,
      fieldName:   r.field_name,
      oldValue:    r.old_value,
      newValue:    r.new_value,
      detectedAt:  r.detected_at,
      etlJobId:    r.etl_job_id,
    }));

    res.json({ records, changeLogs });
  } catch (err) {
    console.error('Lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.get('/api/etl-jobs', async (req, res) => {
  try {
    const { rows } = await pool.query(SP_ETL_JOBS, [50]);
    const jobs = rows.map(r => ({
      id:               r.id,
      service:          r.service,
      phase:            r.phase,
      targetTable:      r.target_table,
      status:           r.status,
      recordsProcessed: r.records_processed,
      recordsCreated:   r.records_created,
      recordsUpdated:   r.records_updated,
      recordsDeleted:   r.records_deleted,
      errorMessage:     r.error_message,
      startedAt:        r.started_at,
      finishedAt:       r.finished_at,
    }));
    res.json({ jobs });
  } catch (err) {
    console.error('ETL jobs error:', err);
    res.status(500).json({ error: 'ETL jobs query failed' });
  }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [], parsed: null });

  try {
    const parsed = parseQuery(q);

    // ── Intersection / source-filter query ──────────────────────────────
    if (parsed.type === 'intersection') {
      const { rows: intersectedRows } = await pool.query(
        SP_INTERSECTION,
        [parsed.sources, parsed.exclude.length > 0 ? parsed.exclude : null, 200],
      );

      if (intersectedRows.length === 0) {
        return res.json({ results: [], parsed });
      }

      const emails = intersectedRows.map(r => r.email);

      // Gather which sources each email appears in
      const { rows: sourceLookup } = await pool.query(SP_MULTI_LOOKUP, [emails]);
      const emailSources = {};
      for (const r of sourceLookup) {
        if (!emailSources[r.email]) emailSources[r.email] = new Set();
        emailSources[r.email].add(r.source);
      }

      // If there's also a search term, rank by ANN distance
      let ranked;
      if (parsed.searchTerm) {
        const vector = await embed(preprocessQuery(parsed.searchTerm));
        const vectorLiteral = `[${vector.join(',')}]`;
        // ANN search against active_directory filtered to our email set
        const { rows: annRows } = await pool.query(SP_ANN_RERANK, [vectorLiteral, emails]);
        const distMap = {};
        for (const r of annRows) distMap[r.email] = parseFloat(r.distance);

        ranked = intersectedRows.map(r => ({
          ...r,
          distance: distMap[r.email] ?? 1.0,
        }));
        ranked.sort((a, b) => a.distance - b.distance);
      } else {
        ranked = intersectedRows.map(r => ({ ...r, distance: null }));
      }

      const results = ranked.slice(0, TOP_K).map(r => ({
        source:    'intersection',
        firstName: r.first_name,
        lastName:  r.last_name,
        email:     r.email,
        type:      r.type,
        contacts:  null,
        distance:  r.distance,
        presentIn: emailSources[r.email] ? [...emailSources[r.email]] : [],
      }));

      return res.json({ results, parsed });
    }

    // ── Standard ANN semantic search (with optional attribute filters) ────
    const preprocessed = preprocessQuery(q);
    const { filters, cleanedQuery } = extractAttributeFilters(preprocessed);
    const hasFilters = Object.keys(filters).length > 0;

    // Embed the cleaned query (preprocessed + filter-stripped, or fallback to preprocessed)
    const embeddingInput = cleanedQuery || preprocessed || q;
    const vector       = await embed(embeddingInput);
    const vectorLiteral = `[${vector.join(',')}]`;

    let rows;
    if (hasFilters) {
      // Use attribute-filtered ANN search
      const result = await pool.query(SP_FILTERED, [
        vectorLiteral,
        TOP_K,
        filters.enabled  !== undefined ? filters.enabled  : null,
        filters.locked   !== undefined ? filters.locked   : null,
        filters.type     || null,
        filters.sourceType || null,
      ]);
      rows = result.rows;
    } else {
      // No filters — standard unfiltered ANN search
      const result = await pool.query(SP_SEARCH_ALL, [vectorLiteral, TOP_K]);
      rows = result.rows;
    }

    const results = rows.map(r => ({
      source:            r.source,
      firstName:         r.first_name,
      lastName:          r.last_name,
      email:             r.email,
      type:              r.type,
      contacts:          r.contacts,
      enabled:           r.enabled,
      locked:            r.locked,
      passwordLastReset: r.passwordlastreset,
      lastLogin:         r.last_login,
      sponsor:           r.sponsor,
      groupName:         r.group_name,
      groupAlias:        r.group_alias,
      createdAt:         r.created_at,
      distance:          parseFloat(r.distance),
    }));

    res.json({ results, parsed: { ...parsed, filters: hasFilters ? filters : undefined } });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Agent proxy ───────────────────────────────────────────────────────────────
// Forwards POST /api/agent → genai service.
const GENAI_URL = process.env.GENAI_URL || 'http://genai:3001';

app.post('/api/agent', express.json(), async (req, res) => {
  try {
    const upstream = await fetch(`${GENAI_URL}/api/agent`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Agent proxy error:', err);
    res.status(502).json({ error: 'Agent service unavailable.' });
  }
});

// ── Tickets proxy ─────────────────────────────────────────────────────────────
// Forwards GET /api/tickets → genai service.

app.get('/api/tickets', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const upstream = await fetch(`${GENAI_URL}/api/tickets?${qs}`, {
      headers: {
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Tickets proxy error:', err);
    res.status(502).json({ error: 'Tickets service unavailable.' });
  }
});

// ── Ticket close proxy ────────────────────────────────────────────────────────
// Forwards PATCH /api/tickets/:id → genai service.

app.patch('/api/tickets/:id', express.json(), async (req, res) => {
  try {
    const upstream = await fetch(`${GENAI_URL}/api/tickets/${req.params.id}`, {
      method:  'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Ticket close proxy error:', err);
    res.status(502).json({ error: 'Ticket service unavailable.' });
  }
});

// ── Violations proxy ──────────────────────────────────────────────────────────
// Forwards GET /api/violations → genai service.

app.get('/api/violations', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const upstream = await fetch(`${GENAI_URL}/api/violations?${qs}`, {
      headers: {
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Violations proxy error:', err);
    res.status(502).json({ error: 'Violations service unavailable.' });
  }
});

// ── Compliance score proxy ────────────────────────────────────────────────────
// Forwards GET /api/compliance-score → genai service.

app.get('/api/compliance-score', async (_req, res) => {
  try {
    const upstream = await fetch(`${GENAI_URL}/api/compliance-score`, {
      headers: {
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Compliance score proxy error:', err);
    res.status(502).json({ error: 'Compliance score service unavailable.' });
  }
});

// ── Trends proxy ──────────────────────────────────────────────────────────────
// Forwards GET /api/trends → genai service.

app.get('/api/trends', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const upstream = await fetch(`${GENAI_URL}/api/trends?${qs}`, {
      headers: {
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Trends proxy error:', err);
    res.status(502).json({ error: 'Trends service unavailable.' });
  }
});

// ── Reports proxy ──────────────────────────────────────────────────────────────
// Forwards GET /api/reports, /api/reports/:id/download, /api/reports/:type.csv → genai service.

app.get('/api/reports', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const upstream = await fetch(`${GENAI_URL}/api/reports?${qs}`, {
      headers: {
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Reports proxy error:', err);
    res.status(502).json({ error: 'Reports service unavailable.' });
  }
});

async function proxyReportDownload(upstreamPath, res) {
  const upstream = await fetch(`${GENAI_URL}${upstreamPath}`, {
    headers: {
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    },
  });
  if (!upstream.ok) {
    const data = await upstream.json().catch(() => ({ error: 'Report download failed.' }));
    return res.status(upstream.status).json(data);
  }
  res.set('Content-Type', upstream.headers.get('content-type') || 'text/csv');
  const disposition = upstream.headers.get('content-disposition');
  if (disposition) res.set('Content-Disposition', disposition);
  res.send(await upstream.text());
}

app.get('/api/reports/:id/download', async (req, res) => {
  try {
    await proxyReportDownload(`/api/reports/${req.params.id}/download`, res);
  } catch (err) {
    console.error('Report download proxy error:', err);
    res.status(502).json({ error: 'Report service unavailable.' });
  }
});

app.get('/api/reports/:type.csv', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    await proxyReportDownload(`/api/reports/${req.params.type}.csv?${qs}`, res);
  } catch (err) {
    console.error('Report CSV proxy error:', err);
    res.status(502).json({ error: 'Report service unavailable.' });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('Loading SBERT model (Xenova/all-MiniLM-L6-v2)…');
  const { pipeline } = await import('@xenova/transformers');
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  console.log('SBERT model loaded.');

  app.listen(PORT, () => {
    console.log(`User Search app listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
