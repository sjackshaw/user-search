'use strict';

const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const TOP_K = parseInt(process.env.TOP_K || '20', 10);

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



// ── Natural-language query parser ─────────────────────────────────────────────
// Detects queries like:
//   "users in active directory and netforum"
//   "show me people in ad and distribution groups"
//   "john smith in active directory and external users"
//   "in ad and netforum"
//   "users in netforum but not in active directory" (NOT support)
//
// Returns: { sources: string[], exclude: string[], searchTerm: string|null }

// ── Query preprocessing ──────────────────────────────────────────────────────
// Strips conversational noise words and phrases from the query before embedding
// so the vector search focuses on meaningful signal (names, concepts, attributes)
// rather than filler words that dilute cosine similarity.

const NOISE_PREFIX_RE = /^(?:can\s+you\s+|could\s+you\s+|please\s+|i\s+(?:want|need|would\s+like)\s+(?:to\s+)?(?:see|find|know|get|look\s+up)?\s*)?(?:show\s+me\s+|find\s+(?:me\s+)?|search\s+(?:for\s+)?|look\s*up\s+|tell\s+me\s+(?:about\s+)?|get\s+(?:me\s+)?(?:all\s+)?|list\s+(?:all\s+)?|give\s+me\s+(?:all\s+)?)/i;
const NOISE_WORDS_RE  = /\b(the|a|an|that|those|these|their|some|any|of|for|on|in|about|with|me|my|who|is|are|was|were|has|have|all(?=\s|$))\b/gi;

/**
 * Strip conversational preamble and common noise words, returning a clean
 * string safe to pass to the SBERT embedding model.
 * Short queries (≤3 words) are left unchanged to avoid over-stripping.
 */
function preprocessQuery(raw) {
  let q = raw.trim();
  // Don't strip very short queries — risk of losing all signal
  if (q.split(/\s+/).length <= 3) return q;

  q = q.replace(NOISE_PREFIX_RE, '');       // remove leading conversational phrases
  q = q.replace(NOISE_WORDS_RE, ' ');       // remove standalone noise words
  q = q.replace(/\s+/g, ' ').trim();

  // If stripping gutted the query (< 2 chars), fall back to the original
  return q.length >= 2 ? q : raw.trim();
}

// ── Attribute filter detection ────────────────────────────────────────────────
// Detects queries like "disabled users", "locked accounts", "external users",
// "users with type contact", etc. and extracts SQL-level attribute filters so
// the ANN search is pre-filtered rather than relying on embeddings alone.

const ATTRIBUTE_PATTERNS = [
  // enabled / disabled
  { re: /\b(disabled|inactive)\b/i,                filter: { enabled: false } },
  { re: /\b(enabled|active)\b(?!\s+directory)/i,   filter: { enabled: true } },
  // locked / unlocked
  { re: /\b(locked|locked\s+out)\b/i,              filter: { locked: true } },
  { re: /\b(unlocked|not\s+locked)\b/i,            filter: { locked: false } },
  // type filters
  { re: /\btype\s*[=:]\s*(user|contact|member|external[- ]?user)\b/i, filter: (_m) => ({ type: _m[1].toLowerCase().replace(/\s+/, '-') }) },
  { re: /\b(contacts?)\b(?!\s*@)/i,                filter: { type: 'contact' } },
  // source type as implicit filter (not the "in <source>" syntax)
  { re: /\bexternal\s+users?\b/i,                  filter: { sourceType: 'external_users' } },
];

/**
 * Extract attribute filters from a query string.
 * Returns { filters: { enabled?, locked?, type?, sourceType? }, cleanedQuery: string }
 */
function extractAttributeFilters(query) {
  const filters = {};
  let cleaned = query;

  for (const { re, filter } of ATTRIBUTE_PATTERNS) {
    const match = cleaned.match(re);
    if (match) {
      const resolved = typeof filter === 'function' ? filter(match) : filter;
      Object.assign(filters, resolved);
      // Remove the matched keyword from the query so it doesn't confuse the ANN search
      cleaned = cleaned.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Clean up residual noise words after filter extraction
  cleaned = cleaned
    .replace(/^(?:show\s+me\s+|find\s+|search\s+(?:for\s+)?|list\s+(?:all\s+)?|get\s+(?:all\s+)?)/i, '')
    .replace(/\b(?:all|the|users?|people|persons?|accounts?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { filters, cleanedQuery: cleaned };
}

const SOURCE_ALIASES = {
  'active directory': 'active_directory',
  'ad':              'active_directory',
  'netforum':        'netforum_members',
  'net forum':       'netforum_members',
  'nf':              'netforum_members',
  'members':         'netforum_members',
  'external user':   'external_users',
  'external users':  'external_users',
  'external':        'external_users',
  'distribution group':  'distribution_groups',
  'distribution groups': 'distribution_groups',
  'dist group':      'distribution_groups',
  'dist groups':     'distribution_groups',
  'groups':          'distribution_groups',
  'dg':              'distribution_groups',
};

// Sorted by length descending so longer aliases match first
const ALIAS_KEYS = Object.keys(SOURCE_ALIASES).sort((a, b) => b.length - a.length);

function resolveSource(text) {
  const t = text.trim().toLowerCase();
  for (const alias of ALIAS_KEYS) {
    if (t === alias || t.endsWith(alias)) return SOURCE_ALIASES[alias];
  }
  return null;
}

function parseQuery(rawQuery) {
  const q = rawQuery.trim();
  const lower = q.toLowerCase();

  // Detect "in <source> and <source>" pattern (with optional "not in")
  // This regex captures: optional prefix text ... "in <source>" ... "and [not] in <source>" ...
  const inPattern = /^(.*?)\b(?:who\s+are\s+|that\s+are\s+)?in\s+(.+)$/i;
  const inMatch = lower.match(inPattern);

  if (!inMatch) {
    return { type: 'semantic', searchTerm: q, sources: [], exclude: [] };
  }

  const prefixRaw = inMatch[1].trim();
  const sourcesPart = inMatch[2]; // everything after "in "

  const parsedSources = [];
  const parsedExclude = [];

  // Re-parse with markers for negation
  const parts = sourcesPart.split(/\s+(?:and|&)\s+/i);
  for (const part of parts) {
    const negMatch = part.match(/^(?:but\s+)?not\s+(?:in\s+)?(.+)$/i);
    if (negMatch) {
      const resolved = resolveSource(negMatch[1]);
      if (resolved) parsedExclude.push(resolved);
    } else {
      const resolved = resolveSource(part);
      if (resolved) parsedSources.push(resolved);
    }
  }

  // If we found at least one source filter, treat as an intersection query
  if (parsedSources.length > 0 || parsedExclude.length > 0) {
    // Strip common prefixes like "users", "people", "show me", etc.
    const searchTerm = prefixRaw
      .replace(/^(?:show\s+me\s+|find\s+|search\s+(?:for\s+)?|list\s+)?/i, '')
      .replace(/\b(?:users?|people|persons?|accounts?|contacts?)\b/gi, '')
      .trim();

    return {
      type: 'intersection',
      sources: [...new Set(parsedSources)],
      exclude: [...new Set(parsedExclude)],
      searchTerm: searchTerm || null,
    };
  }

  // Fallback: couldn't resolve any sources → regular semantic search
  return { type: 'semantic', searchTerm: q, sources: [], exclude: [] };
}

// ── Source-intersection ───────────────────────────────────────────────────────
// Intersection logic now lives in sp_intersection_search() stored procedure.
// App just passes source/exclude arrays and limit.

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ── GenAI chat proxy ──────────────────────────────────────────────────────────
// Forwards POST /api/chat → genai service so the browser never cross-origins.
const GENAI_URL = process.env.GENAI_URL || 'http://genai:3001';

app.post('/api/chat', express.json(), async (req, res) => {
  try {
    const upstream = await fetch(`${GENAI_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('GenAI proxy error:', err);
    res.status(502).json({ error: 'GenAI service unavailable.' });
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
