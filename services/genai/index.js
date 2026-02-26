'use strict';

const express = require('express');
const { Pool }  = require('pg');

const app     = express();
const PORT    = parseInt(process.env.PORT || '3001', 10);
const API_KEY = process.env.API_KEY || '';

app.use(express.json());

// ── Auth guard ────────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorised' });
});

// ── Postgres ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@postgres:5432/appdb',
});

// ── Ollama config ─────────────────────────────────────────────────────────────
const OLLAMA_URL   = process.env.OLLAMA_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const APP_URL      = process.env.APP_URL || 'http://app:3000';

// ── Intent classification ─────────────────────────────────────────────────────
// Simple keyword/regex classifier — runs entirely in-process, no LLM round-trip.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function classifyIntent(message) {
  const m = message.toLowerCase();

  // Change history — explicit keywords
  if (/\b(change|changed|changes|change.?log|history|diff|modified|updated|created|deleted|removed|added)\b/.test(m)) {
    const emailMatch = message.match(EMAIL_RE);
    if (emailMatch) return { intent: 'change_history', email: emailMatch[0].toLowerCase() };
    // May still be a broad change query (e.g. "show recent changes")
    return { intent: 'change_history', email: null };
  }

  // ETL status
  if (/\b(etl|job|jobs|pipeline|run|runs|failed|failure|failures|status|ingestion)\b/.test(m)) {
    return { intent: 'etl_status' };
  }

  // User lookup — email present
  const emailMatch = message.match(EMAIL_RE);
  if (emailMatch) return { intent: 'user_lookup', email: emailMatch[0].toLowerCase() };

  // User lookup — name-like pattern (two+ capitalised words or "who is/are")
  if (/\b(who\s+is|who\s+are|look\s*up|find|search|tell\s+me\s+about|info\s+on|details?\s+(for|on|about))\b/.test(m)) {
    return { intent: 'user_lookup', email: null };
  }

  // Distribution group query
  if (/\b(group|distribution|members?\s+of|dist\s*group|mailing\s+list)\b/.test(m)) {
    return { intent: 'group_lookup' };
  }

  return { intent: 'general' };
}

// ── Stored-procedure SQL calls ────────────────────────────────────────────────
const SP_USER_BY_EMAIL    = 'SELECT * FROM sp_get_user_by_email($1)';
const SP_USER_BY_NAME     = 'SELECT * FROM sp_get_user_by_name($1, $2)';
const SP_CHANGE_LOGS      = 'SELECT * FROM sp_get_change_logs($1, $2)';
const SP_ETL_JOBS         = 'SELECT * FROM sp_get_etl_jobs($1)';
const SP_FAILED_ETL_JOBS  = 'SELECT * FROM sp_get_failed_etl_jobs($1)';
const SP_GROUPS_BY_NAME   = 'SELECT * FROM sp_get_groups_by_name($1, $2)';
const SP_SAMPLE_GROUPS    = 'SELECT * FROM sp_get_sample_groups($1)';
const SP_CHAT_HISTORY     = 'SELECT * FROM sp_get_chat_history($1, $2)';
const SP_SAVE_CHAT        = 'CALL sp_save_chat_message($1, $2, $3)';

// ── Context retrieval ─────────────────────────────────────────────────────────

async function getUserContext(message, email) {
  const rows = [];

  if (email) {
    // Exact lookup across all person tables via stored procedure
    const { rows: userRows } = await pool.query(SP_USER_BY_EMAIL, [email]);
    rows.push(...userRows);
  } else {
    // Try to extract a name and do a ILIKE search
    const nameTokens = message.replace(/[^a-zA-Z\s]/g, '').trim().split(/\s+/)
      .filter(t => t.length > 2 && !/^(who|is|are|the|find|look|search|show|tell|about|info|details|for|me|up|user|users|member|members|person|people|account)$/i.test(t));

    if (nameTokens.length > 0) {
      const pattern = `%${nameTokens.join('%')}%`;

      const { rows: nameRows } = await pool.query(SP_USER_BY_NAME, [pattern, 10]);
      rows.push(...nameRows);
    }
  }

  if (rows.length === 0) return null;

  return rows.map(r => {
    const parts = [`[${r.source}] ${r.first_name} ${r.last_name} <${r.email}>`];
    if (r.type)              parts.push(`type=${r.type}`);
    if (r.enabled !== undefined && r.enabled !== null) parts.push(`enabled=${r.enabled}`);
    if (r.locked !== undefined && r.locked !== null)   parts.push(`locked=${r.locked}`);
    if (r.passwordlastreset) parts.push(`passwordLastReset=${r.passwordlastreset}`);
    if (r.last_login)        parts.push(`lastLogin=${r.last_login}`);
    if (r.sponsor)           parts.push(`sponsor=${r.sponsor}`);
    return parts.join(', ');
  }).join('\n');
}

async function getChangeContext(email) {
  let result;
  if (email) {
    result = await pool.query(SP_CHANGE_LOGS, [email, 20]);
  } else {
    result = await pool.query(SP_CHANGE_LOGS, [null, 20]);
  }
  const { rows } = result;
  if (rows.length === 0) return null;

  return rows.map(r => {
    const parts = [`[${r.source_table}] ${r.email} — ${r.change_type} at ${r.detected_at}`];
    if (r.field_name) parts.push(`  field: ${r.field_name}  "${r.old_value}" → "${r.new_value}"`);
    return parts.join('\n');
  }).join('\n');
}

async function getEtlContext() {
  const { rows: recent } = await pool.query(SP_ETL_JOBS, [10]);

  const { rows: failures } = await pool.query(SP_FAILED_ETL_JOBS, [5]);

  let text = '=== Recent ETL Runs (newest first) ===\n';
  for (const r of recent) {
    const dur = r.finished_at && r.started_at
      ? `${Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000)}s`
      : 'n/a';
    text += `${r.started_at} | ${r.service} ${r.phase} → ${r.target_table} | status=${r.status} | `
          + `processed=${r.records_processed} created=${r.records_created} updated=${r.records_updated} deleted=${r.records_deleted} | ${dur}\n`;
    if (r.error_message) text += `  ERROR: ${r.error_message}\n`;
  }

  if (failures.length > 0) {
    text += '\n=== Failed Runs ===\n';
    for (const f of failures) {
      text += `${f.started_at} | ${f.service} ${f.phase} → ${f.target_table} | ${f.error_message}\n`;
    }
  }

  return text;
}

async function getGroupContext(message) {
  // Try to find a group name in the message
  const nameTokens = message.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/)
    .filter(t => t.length > 2 && !/^(who|is|are|the|in|of|find|look|search|show|tell|about|info|details|for|me|up|member|members|group|distribution|mailing|list|people)$/i.test(t));

  const rows = [];
  if (nameTokens.length > 0) {
    const pattern = `%${nameTokens.join('%')}%`;
    const { rows: groups } = await pool.query(SP_GROUPS_BY_NAME, [pattern, 5]);
    rows.push(...groups);
  }

  // Fallback: return a sample if nothing matched
  if (rows.length === 0) {
    const { rows: sample } = await pool.query(SP_SAMPLE_GROUPS, [5]);
    rows.push(...sample);
  }

  return rows.map(g => {
    const contacts = (g.contacts || []).map(c => `${c.first_name} ${c.last_name} <${c.email}>`).join(', ');
    return `Group: ${g.name} (alias: ${g.alias}, email: ${g.email})\n  Members: ${contacts || 'none'}`;
  }).join('\n\n');
}

// ── Vector / semantic search (via app service) ───────────────────────────────

async function getVectorContext(query, maxResults = 10) {
  try {
    const url = `${APP_URL}/api/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: API_KEY ? { 'x-api-key': API_KEY } : {},
    });
    if (!res.ok) {
      console.warn(`[vectorSearch] app returned ${res.status}`);
      return null;
    }
    const { results } = await res.json();
    if (!results || results.length === 0) return null;

    const top = results.slice(0, maxResults);
    return top.map(r => {
      const parts = [];
      if (r.source === 'distribution_groups' || r.source === 'distribution_group_sync_logs') {
        parts.push(`[${r.source}] ${r.groupName || r.email}`);
        if (r.groupAlias) parts.push(`alias=${r.groupAlias}`);
        if (r.contacts && r.contacts.length > 0) {
          const members = r.contacts.slice(0, 5).map(c => `${c.first_name} ${c.last_name} <${c.email}>`).join(', ');
          parts.push(`members: ${members}`);
        }
      } else {
        parts.push(`[${r.source}] ${r.firstName} ${r.lastName} <${r.email}>`);
        if (r.type) parts.push(`type=${r.type}`);
        if (r.enabled !== undefined && r.enabled !== null) parts.push(`enabled=${r.enabled}`);
        if (r.locked !== undefined && r.locked !== null) parts.push(`locked=${r.locked}`);
        if (r.sponsor) parts.push(`sponsor=${r.sponsor}`);
        if (r.lastLogin) parts.push(`lastLogin=${r.lastLogin}`);
      }
      parts.push(`(similarity=${(1 - r.distance).toFixed(3)})`);
      return parts.join(', ');
    }).join('\n');
  } catch (err) {
    console.error('[vectorSearch] error:', err.message);
    return null;
  }
}

// ── Conversation history ──────────────────────────────────────────────────────

async function getHistory(sessionId) {
  const { rows } = await pool.query(SP_CHAT_HISTORY, [sessionId, 50]);
  return rows; // [{ role, content }, ...]
}

async function saveMessage(sessionId, role, content) {
  await pool.query(SP_SAVE_CHAT, [sessionId, role, content]);
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful assistant for an internal user-search platform. You have access to several data sources:

- **Active Directory**: Internal employee accounts (first_name, last_name, email, type, enabled, locked, passwordlastreset).
- **netForum Members**: Association membership records (first_name, last_name, email, type, enabled, last_login).
- **External Users**: External/vendor/contractor accounts (first_name, last_name, email, type, enabled, sponsor).
- **Distribution Groups**: Mailing lists with member contacts (name, alias, email, contacts[]).

You also have access to:
- **ETL Job Logs**: Records of every data pipeline run (service, phase, target_table, status, record counts, errors, timestamps).
- **Source Change Logs**: An immutable log of all detected changes (created/updated/deleted) across the primary data tables, with field-level diffs for updates.
- **Semantic Search**: SBERT-based vector search across all tables. Results include a similarity score — higher similarity means a stronger match.

When answering:
- Be concise and factual. Cite specific data from the context provided.
- If data is present, reference exact values (emails, dates, field changes).
- If the context doesn't contain enough information to answer, say so clearly.
- Format output using Markdown where helpful (tables, bold, lists).
- When showing changes, highlight the old → new values.
- For ETL status, summarise recent successes and any failures.
- When semantic search results are provided, use the similarity score to judge relevance — mention the most relevant matches first.`;

// ── Ollama chat ───────────────────────────────────────────────────────────────

async function chatWithOllama(messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      options: {
        temperature: 0.3,
        num_ctx: 4096,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.message?.content || '';
}

async function streamChatWithOllama(messages, onToken) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: true,
      options: {
        temperature: 0.3,
        num_ctx: 4096,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body}`);
  }

  let fullContent = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Ollama streams newline-delimited JSON
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        const token = chunk.message?.content || '';
        if (token) {
          fullContent += token;
          onToken(token);
        }
      } catch { /* skip malformed lines */ }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer);
      const token = chunk.message?.content || '';
      if (token) {
        fullContent += token;
        onToken(token);
      }
    } catch { /* skip */ }
  }

  return fullContent;
}

// ── POST /api/chat ────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required.' });
    }

    // 1. Classify intent
    const { intent, email } = classifyIntent(message);
    console.log(`[chat] session=${sessionId} intent=${intent} email=${email || '-'}`);

    // 2. Gather context from Postgres
    let context = '';
    switch (intent) {
      case 'user_lookup': {
        const userCtx = await getUserContext(message, email);
        if (userCtx) context += `=== User Records ===\n${userCtx}\n\n`;
        // Also fetch any change history for the user
        if (email) {
          const changeCtx = await getChangeContext(email);
          if (changeCtx) context += `=== Change History ===\n${changeCtx}\n\n`;
        }
        // Fallback/supplement: semantic vector search when ILIKE found nothing or no email given
        if (!userCtx) {
          const vecCtx = await getVectorContext(message);
          if (vecCtx) context += `=== Semantic Search Results ===\n${vecCtx}\n\n`;
        }
        break;
      }
      case 'change_history': {
        const changeCtx = await getChangeContext(email);
        if (changeCtx) context += `=== Change History ===\n${changeCtx}\n\n`;
        // Also include user info if email given
        if (email) {
          const userCtx = await getUserContext(message, email);
          if (userCtx) context += `=== User Records ===\n${userCtx}\n\n`;
        }
        break;
      }
      case 'etl_status': {
        const etlCtx = await getEtlContext();
        context += etlCtx + '\n\n';
        break;
      }
      case 'group_lookup': {
        const groupCtx = await getGroupContext(message);
        if (groupCtx) context += `=== Distribution Groups ===\n${groupCtx}\n\n`;
        // Supplement with semantic search for broader group/member queries
        const vecGroupCtx = await getVectorContext(message);
        if (vecGroupCtx) context += `=== Semantic Search Results ===\n${vecGroupCtx}\n\n`;
        break;
      }
      default: {
        // General: semantic vector search + light ETL summary
        const vecGenCtx = await getVectorContext(message);
        if (vecGenCtx) context += `=== Semantic Search Results ===\n${vecGenCtx}\n\n`;
        const etlCtx = await getEtlContext();
        context += etlCtx + '\n\n';
        break;
      }
    }

    // 3. Load conversation history
    const history = await getHistory(sessionId);

    // 4. Build messages array for Ollama
    const ollamaMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    // Inject prior conversation (capped to last 10 exchanges to fit context)
    const recentHistory = history.slice(-10);
    for (const h of recentHistory) {
      ollamaMessages.push({ role: h.role, content: h.content });
    }

    // Current user message with context prepended
    const userContent = context
      ? `[Retrieved context]\n${context}\n[User question]\n${message}`
      : message;
    ollamaMessages.push({ role: 'user', content: userContent });

    // 5. Check if client wants streaming (Accept: text/event-stream header required)
    const wantsStream = req.headers.accept === 'text/event-stream';

    if (wantsStream) {
      // SSE streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send intent as first event
      res.write(`data: ${JSON.stringify({ type: 'meta', sessionId, intent })}\n\n`);

      await saveMessage(sessionId, 'user', message);

      const assistantReply = await streamChatWithOllama(ollamaMessages, (token) => {
        res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
      });

      await saveMessage(sessionId, 'assistant', assistantReply);

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    } else {
      // Non-streaming (original behaviour)
      const assistantReply = await chatWithOllama(ollamaMessages);

      await saveMessage(sessionId, 'user', message);
      await saveMessage(sessionId, 'assistant', assistantReply);

      res.json({
        sessionId,
        intent,
        reply: assistantReply,
      });
    }
  } catch (err) {
    console.error('[chat] error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', model: OLLAMA_MODEL });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GenAI service listening on :${PORT}`);
  console.log(`  Ollama URL:   ${OLLAMA_URL}`);
  console.log(`  Ollama Model: ${OLLAMA_MODEL}`);
});
