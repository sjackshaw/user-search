'use strict';

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
  'sharepoint':          'sharepoint_permissions',
  'sharepoint on-prem':  'sharepoint_permissions',
  'sp':                  'sharepoint_permissions',
  'sp permissions':      'sharepoint_permissions',
  'm365':                'm365_group_memberships',
  'microsoft 365':       'm365_group_memberships',
  '365':                 'm365_group_memberships',
  'm365 groups':         'm365_group_memberships',
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

module.exports = {
  preprocessQuery,
  extractAttributeFilters,
  parseQuery,
  resolveSource,
  SOURCE_ALIASES,
};
