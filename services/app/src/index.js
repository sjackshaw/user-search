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

const SEARCH_SQL = `
WITH candidates AS (
  (SELECT 'active_directory'   AS source,
          first_name, last_name, email, type, NULL::jsonb AS contacts,
          enabled, locked, passwordlastreset,
          NULL::timestamptz AS last_login, NULL::text AS sponsor,
          NULL::text AS group_name, NULL::text AS group_alias,
          created_at,
          NULL::timestamptz AS sync_timestamp,
          NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
          NULL::text AS notes,
          embedding <=> $1::vector AS distance
   FROM   active_directory
   ORDER  BY embedding <=> $1::vector
   LIMIT  $2)

  UNION ALL

  (SELECT 'netforum_members'   AS source,
          first_name, last_name, email, type, NULL::jsonb AS contacts,
          enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
          last_login, NULL::text AS sponsor,
          NULL::text AS group_name, NULL::text AS group_alias,
          created_at,
          NULL::timestamptz AS sync_timestamp,
          NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
          NULL::text AS notes,
          embedding <=> $1::vector AS distance
   FROM   netforum_members
   ORDER  BY embedding <=> $1::vector
   LIMIT  $2)

  UNION ALL

  (SELECT 'external_users'     AS source,
          first_name, last_name, email, type, NULL::jsonb AS contacts,
          enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
          NULL::timestamptz AS last_login, sponsor,
          NULL::text AS group_name, NULL::text AS group_alias,
          created_at,
          NULL::timestamptz AS sync_timestamp,
          NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
          NULL::text AS notes,
          embedding <=> $1::vector AS distance
   FROM   external_users
   ORDER  BY embedding <=> $1::vector
   LIMIT  $2)

  UNION ALL

  (SELECT 'distribution_groups' AS source,
          name AS first_name, alias AS last_name, email, 'group' AS type,
          contacts,
          NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
          NULL::timestamptz AS last_login, NULL::text AS sponsor,
          name AS group_name, alias AS group_alias,
          created_at,
          NULL::timestamptz AS sync_timestamp,
          NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
          NULL::text AS notes,
          embedding <=> $1::vector AS distance
   FROM   distribution_groups
   ORDER  BY embedding <=> $1::vector
   LIMIT  $2)

  UNION ALL

  (SELECT 'distribution_group_sync_logs' AS source,
          group_name AS first_name, NULL AS last_name, NULL AS email, 'sync-log' AS type,
          NULL::jsonb AS contacts,
          NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
          NULL::timestamptz AS last_login, NULL::text AS sponsor,
          group_name AS group_name, NULL AS group_alias,
          created_at,
          sync_timestamp,
          accounts_added, accounts_removed,
          notes,
          embedding <=> $1::vector AS distance
   FROM   distribution_group_sync_logs
   ORDER  BY embedding <=> $1::vector
   LIMIT  $2)

  UNION ALL

  (SELECT 'active_directory_activity_logs' AS source,
          first_name, last_name, email, 'activity-log' AS type, NULL::jsonb AS contacts,
          NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
          NULL::timestamptz AS last_login, changed_by AS sponsor,
          NULL::text AS group_name, NULL::text AS group_alias,
          created_at,
          log_timestamp AS sync_timestamp,
          NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
          notes,
          embedding <=> $1::vector AS distance
   FROM   active_directory_activity_logs
   ORDER  BY embedding <=> $1::vector
   LIMIT  $2)

  UNION ALL

  (SELECT 'external_user_activity_logs' AS source,
          first_name, last_name, email, 'activity-log' AS type, NULL::jsonb AS contacts,
          NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
          NULL::timestamptz AS last_login, changed_by AS sponsor,
          NULL::text AS group_name, NULL::text AS group_alias,
          created_at,
          log_timestamp AS sync_timestamp,
          NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
          notes,
          embedding <=> $1::vector AS distance
   FROM   external_user_activity_logs
   ORDER  BY embedding <=> $1::vector
   LIMIT  $2)

  UNION ALL

  (SELECT 'netforum_activity_logs' AS source,
          first_name, last_name, email, 'activity-log' AS type, NULL::jsonb AS contacts,
          NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
          NULL::timestamptz AS last_login, changed_by AS sponsor,
          NULL::text AS group_name, NULL::text AS group_alias,
          created_at,
          log_timestamp AS sync_timestamp,
          NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
          notes,
          embedding <=> $1::vector AS distance
   FROM   netforum_activity_logs
   ORDER  BY embedding <=> $1::vector
   LIMIT  $2)
)
SELECT * FROM candidates
ORDER  BY distance
LIMIT  $2;
`;

// ── Natural-language query parser ─────────────────────────────────────────────
// Detects queries like:
//   "users in active directory and netforum"
//   "show me people in ad and distribution groups"
//   "john smith in active directory and external users"
//   "in ad and netforum"
//   "users in netforum but not in active directory" (NOT support)
//
// Returns: { sources: string[], exclude: string[], searchTerm: string|null }

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
  'sync log':        'distribution_group_sync_logs',
  'sync logs':       'distribution_group_sync_logs',
  'sync-logs':       'distribution_group_sync_logs',
  'dg sync':         'distribution_group_sync_logs',
  'dg sync logs':    'distribution_group_sync_logs',

  // Activity logs
  'active directory activity logs': 'active_directory_activity_logs',
  'active directory activity log':  'active_directory_activity_logs',
  'active directory activity':      'active_directory_activity_logs',
  'ad activity logs':               'active_directory_activity_logs',
  'ad activity log':                'active_directory_activity_logs',
  'ad activity':                    'active_directory_activity_logs',
  'ad logs':                        'active_directory_activity_logs',

  'external user activity logs':    'external_user_activity_logs',
  'external user activity log':     'external_user_activity_logs',
  'external activity logs':         'external_user_activity_logs',
  'external activity log':          'external_user_activity_logs',
  'external activity':              'external_user_activity_logs',
  'ext logs':                       'external_user_activity_logs',

  'netforum activity logs':         'netforum_activity_logs',
  'netforum activity log':          'netforum_activity_logs',
  'netforum activity':              'netforum_activity_logs',
  'nf activity logs':               'netforum_activity_logs',
  'nf activity log':                'netforum_activity_logs',
  'nf activity':                    'netforum_activity_logs',
  'nf logs':                        'netforum_activity_logs',
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

// ── Source-intersection SQL builder ───────────────────────────────────────────
// Finds users whose email appears in ALL of the required sources.
// For distribution_groups, a user "is in" the source if their email appears
// in any group's contacts JSONB array.

function buildPersonSource(table) {
  return `SELECT email, first_name, last_name, type FROM ${table}`;
}

const DG_MEMBER_SQL = `
  SELECT c->>'email' AS email,
         c->>'first_name' AS first_name,
         c->>'last_name'  AS last_name,
         'group-member'   AS type
  FROM   distribution_groups, jsonb_array_elements(contacts) c
`;

function sourceSubquery(source) {
  if (source === 'distribution_groups') return DG_MEMBER_SQL;
  if (source === 'active_directory_activity_logs')
    return `SELECT email, first_name, last_name, 'activity-log' AS type FROM active_directory_activity_logs`;
  if (source === 'external_user_activity_logs')
    return `SELECT email, first_name, last_name, 'activity-log' AS type FROM external_user_activity_logs`;
  if (source === 'netforum_activity_logs')
    return `SELECT email, first_name, last_name, 'activity-log' AS type FROM netforum_activity_logs`;
  return buildPersonSource(source);
}

function buildIntersectionSQL(sources, exclude, hasSearchTerm) {
  // Each required source contributes a CTE of distinct emails
  const ctes = [];

  for (let i = 0; i < sources.length; i++) {
    ctes.push(`src_${i} AS (${sourceSubquery(sources[i])})`);
  }
  for (let i = 0; i < exclude.length; i++) {
    ctes.push(`exc_${i} AS (${sourceSubquery(exclude[i])})`);
  }

  // Intersect: start with src_0, INNER JOIN on email for src_1..N
  const fromClause = `src_0`;
  let joinClauses = '';
  for (let i = 1; i < sources.length; i++) {
    joinClauses += `\n  JOIN src_${i} ON src_${i}.email = src_0.email`;
  }

  // Exclude: LEFT JOIN + WHERE IS NULL
  let excludeJoins = '';
  let excludeWheres = '';
  for (let i = 0; i < exclude.length; i++) {
    excludeJoins += `\n  LEFT JOIN exc_${i} ON exc_${i}.email = src_0.email`;
    excludeWheres += `${excludeWheres ? ' AND ' : ' WHERE '}exc_${i}.email IS NULL`;
  }

  // hasSearchTerm: ANN re-ranking is applied post-query in the route handler;
  // the SQL here returns the full intersected set for JS-side ranking.
  void hasSearchTerm;

  const sql = `
    WITH ${ctes.join(',\n         ')}
    SELECT DISTINCT src_0.email, src_0.first_name, src_0.last_name, src_0.type
    FROM   ${fromClause}${joinClauses}${excludeJoins}${excludeWheres}
    ORDER  BY src_0.last_name, src_0.first_name
    LIMIT  200;
  `;

  return sql;
}

// Build a lookup for all sources a given set of emails appears in
const MULTI_LOOKUP_SQL = `
  SELECT 'active_directory' AS source, email FROM active_directory WHERE email = ANY($1)
  UNION ALL
  SELECT 'netforum_members', email FROM netforum_members WHERE email = ANY($1)
  UNION ALL
  SELECT 'external_users', email FROM external_users WHERE email = ANY($1)
  UNION ALL
  SELECT 'distribution_groups', c->>'email'
  FROM   distribution_groups, jsonb_array_elements(contacts) c
  WHERE  c->>'email' = ANY($1)
  UNION ALL
  SELECT 'active_directory_activity_logs', email FROM active_directory_activity_logs WHERE email = ANY($1)
  UNION ALL
  SELECT 'external_user_activity_logs', email FROM external_user_activity_logs WHERE email = ANY($1)
  UNION ALL
  SELECT 'netforum_activity_logs', email FROM netforum_activity_logs WHERE email = ANY($1)
`;

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lookup every row associated with a given email across all sources.
// For person tables: direct email match.
// For distribution_groups: email matches OR email appears inside contacts JSONB.
const LOOKUP_SQL = `
  SELECT 'active_directory' AS source,
         id, first_name, last_name, email, type,
         NULL::jsonb AS contacts, NULL::text AS name, NULL::text AS alias,
         enabled, locked, passwordlastreset,
         NULL::timestamptz AS last_login, NULL::text AS sponsor,
         created_at,
         NULL::timestamptz AS sync_timestamp,
         NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
         NULL::text AS notes
  FROM   active_directory
  WHERE  email = $1

  UNION ALL

  SELECT 'netforum_members' AS source,
         id, first_name, last_name, email, type,
         NULL::jsonb AS contacts, NULL::text AS name, NULL::text AS alias,
         enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
         last_login, NULL::text AS sponsor,
         created_at,
         NULL::timestamptz AS sync_timestamp,
         NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
         NULL::text AS notes
  FROM   netforum_members
  WHERE  email = $1

  UNION ALL

  SELECT 'external_users' AS source,
         id, first_name, last_name, email, type,
         NULL::jsonb AS contacts, NULL::text AS name, NULL::text AS alias,
         enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
         NULL::timestamptz AS last_login, sponsor,
         created_at,
         NULL::timestamptz AS sync_timestamp,
         NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
         NULL::text AS notes
  FROM   external_users
  WHERE  email = $1

  UNION ALL

  SELECT 'distribution_groups' AS source,
         id, NULL AS first_name, NULL AS last_name, email, 'group' AS type,
         contacts, name, alias,
         NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
         NULL::timestamptz AS last_login, NULL::text AS sponsor,
         created_at,
         NULL::timestamptz AS sync_timestamp,
         NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
         NULL::text AS notes
  FROM   distribution_groups
  WHERE  email = $1
     OR  EXISTS (
           SELECT 1 FROM jsonb_array_elements(contacts) c
           WHERE  c->>'email' = $1
         )

  UNION ALL

  SELECT 'distribution_group_sync_logs' AS source,
         id, NULL AS first_name, NULL AS last_name, NULL AS email, 'sync-log' AS type,
         NULL::jsonb AS contacts, group_name AS name, NULL AS alias,
         NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
         NULL::timestamptz AS last_login, NULL::text AS sponsor,
         created_at,
         sync_timestamp,
         accounts_added, accounts_removed,
         notes
  FROM   distribution_group_sync_logs
  WHERE  LOWER(group_name) = $1
     OR  group_name = (SELECT name FROM distribution_groups WHERE email = $1 LIMIT 1)
     OR  EXISTS (
           SELECT 1 FROM jsonb_array_elements(accounts_added) a
           WHERE  LOWER(a->>'email') = $1
         )
     OR  EXISTS (
           SELECT 1 FROM jsonb_array_elements(accounts_removed) a
           WHERE  LOWER(a->>'email') = $1
         )

  UNION ALL

  SELECT 'active_directory_activity_logs' AS source,
         id, first_name, last_name, email, 'activity-log' AS type,
         NULL::jsonb AS contacts, NULL::text AS name, NULL::text AS alias,
         NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
         NULL::timestamptz AS last_login, changed_by AS sponsor,
         created_at,
         log_timestamp AS sync_timestamp,
         NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
         notes
  FROM   active_directory_activity_logs
  WHERE  email = $1

  UNION ALL

  SELECT 'external_user_activity_logs' AS source,
         id, first_name, last_name, email, 'activity-log' AS type,
         NULL::jsonb AS contacts, NULL::text AS name, NULL::text AS alias,
         NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
         NULL::timestamptz AS last_login, changed_by AS sponsor,
         created_at,
         log_timestamp AS sync_timestamp,
         NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
         notes
  FROM   external_user_activity_logs
  WHERE  email = $1

  UNION ALL

  SELECT 'netforum_activity_logs' AS source,
         id, first_name, last_name, email, 'activity-log' AS type,
         NULL::jsonb AS contacts, NULL::text AS name, NULL::text AS alias,
         NULL::boolean AS enabled, NULL::boolean AS locked, NULL::timestamptz AS passwordlastreset,
         NULL::timestamptz AS last_login, changed_by AS sponsor,
         created_at,
         log_timestamp AS sync_timestamp,
         NULL::jsonb AS accounts_added, NULL::jsonb AS accounts_removed,
         notes
  FROM   netforum_activity_logs
  WHERE  email = $1

  ORDER BY source, created_at;
`;

app.get('/api/lookup', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ records: [] });

  try {
    const { rows } = await pool.query(LOOKUP_SQL, [email]);

    const records = rows.map(r => ({
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

    res.json({ records });
  } catch (err) {
    console.error('Lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [], parsed: null });

  try {
    const parsed = parseQuery(q);

    // ── Intersection / source-filter query ──────────────────────────────
    if (parsed.type === 'intersection') {
      const sql = buildIntersectionSQL(parsed.sources, parsed.exclude, !!parsed.searchTerm);
      const { rows: intersectedRows } = await pool.query(sql);

      if (intersectedRows.length === 0) {
        return res.json({ results: [], parsed });
      }

      const emails = intersectedRows.map(r => r.email);

      // Gather which sources each email appears in
      const { rows: sourceLookup } = await pool.query(MULTI_LOOKUP_SQL, [emails]);
      const emailSources = {};
      for (const r of sourceLookup) {
        if (!emailSources[r.email]) emailSources[r.email] = new Set();
        emailSources[r.email].add(r.source);
      }

      // If there's also a search term, rank by ANN distance
      let ranked;
      if (parsed.searchTerm) {
        const vector = await embed(parsed.searchTerm);
        const vectorLiteral = `[${vector.join(',')}]`;
        // ANN search against active_directory (largest table) filtered to our email set
        const annSQL = `
          SELECT email, embedding <=> $1::vector AS distance
          FROM   active_directory
          WHERE  email = ANY($2)
          ORDER  BY embedding <=> $1::vector
        `;
        const { rows: annRows } = await pool.query(annSQL, [vectorLiteral, emails]);
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

    // ── Standard ANN semantic search ────────────────────────────────────
    const vector       = await embed(q);
    const vectorLiteral = `[${vector.join(',')}]`;
    const { rows }     = await pool.query(SEARCH_SQL, [vectorLiteral, TOP_K]);

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
      syncTimestamp:     r.sync_timestamp,
      accountsAdded:     r.accounts_added,
      accountsRemoved:   r.accounts_removed,
      notes:             r.notes,
      distance:          parseFloat(r.distance),
    }));

    res.json({ results, parsed });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
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
