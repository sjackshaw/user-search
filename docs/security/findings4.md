# Security Review: Agentic AI — Tool-Calling Agent

**Review date:** 2026-02-27
**Reviewer:** security-specialist (automated)
**Scope:** Agentic AI additions — `services/genai/index.js` (agent tools, action executors, PATCH endpoint), `services/app/src/public/index.html` (agent UI, `renderMarkdown`), `services/app/src/index.js` (agent/tickets proxy routes).
**Mode:** Read-only — no code changes made in this review.

---

## Executive Summary

The agentic AI feature introduces LLM-driven tool-calling that executes **real database mutations** (INSERT, UPDATE) based on tool arguments supplied by the LLM. This significantly raises the attack surface compared to the previous read-only chat assistant. Six new findings are identified — **two medium**, **four low**. A positive note: the removal of SSE streaming (chat assistant) eliminates three prior findings (F3-N1, F3-N2, F3-N3).

---

## New Findings

### F4-N1 — SQL interpolation of `target_system` table name without server-side allowlist · Severity: **Medium**

**Affected file:** `services/genai/index.js` — `executeProvisionAccount()` (line 245), `executeUpdateAttribute()` (line 337)

**Description:**
Several action executors interpolate `target_system` directly into SQL:

```js
`SELECT id FROM ${target_system} WHERE email = $1`
`UPDATE ${target_system} SET ${field} = $1 WHERE email = $2`
```

The `target_system` value originates from LLM tool-call arguments. While the Ollama tool definition constrains it to an `enum` of `['active_directory', 'netforum_members', 'external_users']`, this is a **client-side-only** constraint — the LLM may hallucinate or be prompt-injected into returning an arbitrary value. There is no server-side validation against an allowlist before the value reaches the SQL template.

`executeProvisionAccount()` does have per-system `if/else` branches that guard the INSERT path (falling through to `throw new Error` for unknown systems), but the earlier `SELECT id FROM ${target_system}` on line 245 executes **before** those guards.

`executeUpdateAttribute()` validates `field` against `ALLOWED_FIELDS` but does **not** validate `target_system`.

**Impact:** A crafted or hallucinated `target_system` value could query or mutate an unintended table.

**Recommendation:**
Add a server-side allowlist check at the top of every executor that receives `target_system`:

```js
const VALID_SYSTEMS = ['active_directory', 'netforum_members', 'external_users'];
if (!VALID_SYSTEMS.includes(target_system)) {
  throw new Error(`Invalid target system: ${target_system}`);
}
```

---

### F4-N2 — LIKE wildcard injection in group name search · Severity: **Low**

**Affected files:** `services/genai/index.js` — `executeAddToGroup()` (line 360), `executeAddToM365Group()` (line 405)

**Description:**
Group name searches use an unescaped LIKE pattern:

```js
`SELECT ... WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`
[`%${group_name}%`]
```

While `group_name` is parameterised (safe from SQL injection), the `%` and `_` LIKE wildcard characters within the value itself are **not** escaped. A `group_name` containing `%` would match all groups; `_` matches any single character. Since the query uses `LIMIT 1`, this could silently return an unintended group.

**Impact:** Low — the LLM supplies the group name from user intent, and unintended matches would still be visible in the agent reply. No data is mutated without the user seeing which group was matched.

**Recommendation:**
Escape LIKE metacharacters before interpolation:

```js
const safeName = group_name.replace(/[%_]/g, '\\$&');
[`%${safeName}%`]
```

---

### F4-N3 — PATCH /api/tickets/:id has no ownership check · Severity: **Medium**

**Affected file:** `services/genai/index.js` — lines 741–768

**Description:**
The `PATCH /api/tickets/:id` endpoint accepts any ticket ID and updates its status without verifying that the requesting user owns the ticket. Any authenticated user (or any caller with a valid API key) can close any other user's ticket by ID.

```js
app.patch('/api/tickets/:id', async (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  // ... no ownership check ...
  await pool.query(`UPDATE agent_tickets SET status = $1 ... WHERE id = $2`, [status, ticketId]);
});
```

**Impact:** Ticket IDs are sequential integers, making enumeration trivial.

**Recommendation:**
Require the caller to supply the `email` (or extract it from session context) and add a `WHERE email = $3` clause:

```js
`UPDATE agent_tickets SET status = $1, updated_at = now() WHERE id = $2 AND email = $3 RETURNING *`
```

---

### F4-N4 — No rate limiting on POST /api/agent · Severity: **Low**

**Affected file:** `services/genai/index.js` — `POST /api/agent` handler

**Description:**
Each agent request triggers at least one (sometimes two) Ollama LLM calls plus database queries and mutations. There is no request rate limit. An attacker or misbehaving client could flood the endpoint, exhausting Ollama inference capacity and Postgres connection pool slots.

**Impact:** Denial of service against the LLM inference backend. In the current single-user dev environment this is low risk; it becomes higher risk in any shared or production deployment.

**Recommendation:**
Add a per-session or per-IP rate limiter (e.g. `express-rate-limit`):

```js
const rateLimit = require('express-rate-limit');
app.use('/api/agent', rateLimit({ windowMs: 60_000, max: 10 }));
```

---

### F4-N5 — renderMarkdown re-introduces HTML from LLM output · Severity: **Low**

**Affected file:** `services/app/src/public/index.html` — `renderMarkdown()` function (line 746)

**Description:**
`renderMarkdown()` first escapes text via `esc()` (HTML entity encoding), then applies regex replacements that re-introduce raw HTML tags (`<strong>`, `<em>`, `<code>`, `<li>`, `<ul>`, `<br>`). The content originates from Ollama's LLM response — not direct user input — but a prompt injection attack could cause the LLM to emit markdown that, after transformation, produces unexpected HTML.

Currently the regex patterns are restrictive (e.g. `\*\*(.+?)\*\*` → `<strong>`) and the initial `esc()` call strips angle brackets, so the practical XSS risk is minimal. However, future regex additions (e.g. link or image support) could open an injection path.

**Impact:** Low — the `esc()` pass neutralises direct `<script>` injection. Risk is primarily from future regex expansion.

**Recommendation:**
Document the security constraint (no link/image/HTML-passthrough support) and consider using a battle-tested markdown library (e.g. `marked` with `sanitize: true`) if richer formatting is needed in future.

---

### F4-N6 — Agent system prompt leaks internal schema details · Severity: **Low**

**Affected file:** `services/genai/index.js` — `AGENT_SYSTEM_PROMPT` (line 444)

**Description:**
The system prompt includes internal table and column names (`active_directory`, `netforum_members`, `external_users`, field names like `sponsor`, `type`), tool names, and system architecture details. While necessary for the LLM to function, this information is included in every Ollama request and persisted in `chat_messages`. If an attacker gains access to conversation logs or can extract the system prompt via prompt injection ("repeat your instructions"), they obtain a detailed map of the database schema and available actions.

**Impact:** Low for the current PoC. Higher if deployed with external users or if conversation logs are not adequately protected.

**Recommendation:**
For production: (a) redact or abstract table/column names in the prompt, mapping them back server-side; (b) add prompt-injection guardrails (e.g. refuse requests to repeat system instructions).

---

## Positive Changes

### F4-P1 — Chat assistant and SSE streaming fully removed ✅

The removal of the chat assistant eliminates the following prior findings:

| Prior Finding | Status |
|---|---|
| F3-N1 — No timeout on long-lived SSE connections | **Eliminated** — SSE code removed |
| F3-N2 — Upstream content-type accepted without strict validation | **Eliminated** — SSE proxy removed |
| F3-N3 — `?stream=true` query parameter | **Eliminated** — streaming code removed |

### F4-P2 — Field allowlist in executeUpdateAttribute ✅

`executeUpdateAttribute()` validates the `field` parameter against `ALLOWED_FIELDS = ['email', 'first_name', 'last_name', 'type', 'sponsor']` before interpolating it into SQL. This is a good practice that mitigates arbitrary column access for that executor.

### F4-P3 — Duplicate-entry guards in all action executors ✅

All executors check for pre-existing state before mutating (e.g. account already exists, user already a group member), preventing accidental duplicate operations.

---

## Persistent Findings (from findings1–3 — still open)

| ID | Description | Severity | Status |
|---|---|---|---|
| F1-P1 | Hardcoded `\|\| 'postgres'` password fallback in all `vectorize.js` files | **High** | ❌ Open |
| F1-F6 | Reflected XSS — unescaped server data in search card rendering | **Medium** | ❌ Open |
| F1-F8 | No HTTP security headers (`helmet` not installed) | **Medium** | ❌ Open |
| F2-N3 | Template-literal table name in `truncate()` — no whitelist guard | **Low** | ❌ Open |
| F1-F3 | No authentication on any API endpoint | **High** | ✅ Remediated (API key guard) |
| F1-P7 / F2-P7 | Containers running as root | **Medium** | ✅ Remediated (`USER node`) |
| F3-N1 | SSE timeout | **Medium** | ✅ Eliminated (code removed) |
| F3-N2 | Upstream content-type validation | **Low** | ✅ Eliminated (code removed) |
| F3-N3 | Stream query param trigger | **Low** | ✅ Eliminated (code removed) |

---

## Risk Summary

| Area | Risk Level | Notes |
|---|---|---|
| SQL interpolation of LLM-supplied table names | **Medium** | F4-N1 — no server-side allowlist; mitigate with constant validation |
| Ticket ownership | **Medium** | F4-N3 — any caller can close any ticket |
| LIKE wildcard injection | **Low** | F4-N2 — could match unintended group; visible in reply |
| Rate limiting | **Low** | F4-N4 — no throttle on expensive LLM calls |
| Client-side markdown rendering | **Low** | F4-N5 — esc() mitigates; risk from future regex expansion |
| Prompt information leakage | **Low** | F4-N6 — schema details in system prompt |

---

## Recommended Remediation Priority

| Priority | Finding | Effort |
|---|---|---|
| 1 | F4-N1 — Add server-side `target_system` allowlist | Low (add 3-line guard to each executor) |
| 2 | F4-N3 — Add email ownership check to PATCH /api/tickets/:id | Low (add WHERE clause) |
| 3 | F4-N4 — Add rate limiter to POST /api/agent | Low (`express-rate-limit`) |
| 4 | F4-N2 — Escape LIKE wildcards in group search | Low (one-line fix × 2) |
| 5 | F4-N5 — Document renderMarkdown security constraints | Low (comment only) |
| 6 | F4-N6 — Add prompt-injection guardrails for production | Medium (requires testing) |
| — | F1-P1 — Remove hardcoded password fallback (persistent) | Low (× 4 files) |
| — | F1-F8 — Add `helmet` security headers (persistent) | Low |
