# Code Quality Review — Final Audit

**Date:** February 28, 2026
**Branch:** `ai-hackathon-learning`
**Scope:** Full proof-of-concept — ETL services, app, GenAI, Docker, CI, testing

---

## Executive Summary

The proof of concept demonstrates a well-architected ETL + semantic search + GenAI platform with 6 data pipelines, 15 database tables, and an LLM-powered agent. The core functionality is sound, SQL injection is properly mitigated via parameterised queries, and Docker USER directives are consistently used.

The primary areas for improvement before production readiness are: **missing tests** (only data-shape validation exists), **no graceful shutdown** in any service, **Docker image optimisation** (full `node:22` images used everywhere), and **configuration inconsistencies** across compose fragments.

### Finding Count by Severity

| Severity | Count |
|---|---|
| Critical | 6 |
| High | 14 |
| Medium | 22 |
| Low | 12 |

---

## 1. Critical Findings

### 1.1 No `package-lock.json` at project root
**Services:** Root
`npm ci` (used in CI and referenced in Dockerfiles) requires a lock file. Without it, the CI pipeline and reproducible builds will fail.

**Fix:** Run `npm install` at the root and commit the generated `package-lock.json`.

---

### 1.2 SQL identifier interpolation in GenAI tool executors
**Service:** GenAI — `services/genai/index.js`

Table and column names are interpolated directly into SQL strings:

```javascript
// Line ~278
const { rowCount } = await pool.query(
  `UPDATE ${target_system} SET ${field} = $1 WHERE email = $2`,
  [new_value, email]
);
```

While `target_system` and `field` are validated against allow-lists, the pattern is fragile. A future developer adding a value containing SQL metacharacters to the allow-list would create an injection vulnerability.

**Fix:** Use a map of allowed identifiers to pre-quoted literals, or use `pg-format` with `%I` identifier escaping.

---

### 1.3 No tests for the app or GenAI services
**Services:** App, GenAI

Neither service has any test files. The app's complex query parser (`parseQuery`, `extractAttributeFilters`, `preprocessQuery`) has zero test coverage despite being regex-heavy with many edge cases. The GenAI service's 9 tool executors and prompt construction are entirely untested.

---

### 1.4 CI build matrix is incomplete
**Service:** CI — `.github/workflows/ci.yml`

The `build-and-push` job matrix includes only `app`, `etl-ad-line`, `etl-netforum-line`, `etl-eu-line`, `etl-dg-line`. Missing: **`genai`**, **`etl-m365-line`**, **`etl-sp-line`**.

---

### 1.5 CI database port mismatch
**Service:** CI — `.github/workflows/ci.yml`

The test step sets `DATABASE_URL` with port **5432**, but `docker-compose.postgres.yml` maps host port **5433** → container 5432. Tests running on the CI host need port 5433.

---

### 1.6 `dev:up` npm script is missing two ETL fragments
**Service:** Root `package.json`

The `dev:up` script includes only 4 of 6 ETL compose files — `docker-compose.etl-m365-line.yml` and `docker-compose.etl-sp-line.yml` are missing. The `startup/setup.sh` correctly includes all 9 fragments.

---

## 2. High Findings

### 2.1 No graceful shutdown in any service
**Services:** All (app, genai, 6× ETL)

No service registers `SIGTERM`/`SIGINT` handlers. When Docker sends a stop signal:
- HTTP servers keep accepting connections
- Postgres pool connections are abandoned (never `pool.end()`)
- In-flight requests and ETL batches are aborted mid-transaction

```javascript
// Recommended pattern for all services:
const server = app.listen(PORT, () => { ... });
process.on('SIGTERM', async () => {
  server.close();
  await pool.end();
  process.exit(0);
});
```

---

### 2.2 No timeout on Ollama HTTP call
**Service:** GenAI — `services/genai/index.js`

The `fetch()` call to Ollama has no `AbortController` timeout. A hung Ollama instance blocks requests indefinitely. The endpoint makes **two** sequential LLM calls per tool-calling turn.

```javascript
// Current — no timeout:
const res = await fetch(`${OLLAMA_URL}/api/chat`, { ... });

// Recommended:
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
const res = await fetch(url, { signal: controller.signal, ... });
clearTimeout(timeout);
```

---

### 2.3 No retry logic on Ollama calls
**Service:** GenAI — `services/genai/index.js`

Both LLM calls (initial + follow-up) are fire-once. A transient Ollama 503 during model loading fails the entire request with no retry.

---

### 2.4 `failJob()` can swallow the original error
**Services:** All 6 ETL services

In every `runPrimary()` and `runLogs()` catch block, `failJob()` is called without its own try/catch. If the database is unreachable (the likely failure scenario), `failJob()` throws and the original error is lost.

```javascript
// Current:
} catch (err) {
  await failJob(jobId, err);   // throws if DB down → original err lost
  throw err;
}

// Recommended:
} catch (err) {
  try { await failJob(jobId, err); } catch (e) { console.error('failJob failed:', e); }
  throw err;
}
```

---

### 2.5 Sequential awaits in batch loops (N+1 pattern)
**Services:** All 6 ETL services

Every `upsertPrimaryBatch()` issues individual `await client.query()` calls inside a loop — 64+ sequential round-trips per batch. Change detection adds additional calls per changed field. Deletion is also one-at-a-time.

**Impact:** For 6,000 AD records in batches of 64, that's ~94 batches × ~64 queries = ~6,000 sequential queries plus change-log inserts.

**Fix:** Use multi-row `INSERT ... ON CONFLICT` with `unnest()` arrays or `VALUES` lists.

---

### 2.6 ETL model-cache volume mounted at wrong path
**Services:** All 6 ETL compose files

The compose files mount the model cache at `/root/.cache/huggingface/hub`, but the Dockerfiles set `USER node`. The `node` user's home is `/home/node`, so the process may not find the cached model, triggering a re-download on every container start.

**Fix:** Change mount to `/home/node/.cache/huggingface/hub` (matching the app service).

---

### 2.7 Express 4 does not catch async route rejections
**Services:** App, GenAI

Both services use `async` route handlers with Express 4, which does **not** catch rejected promises. If a throw occurs outside the explicit `try/catch`, it becomes an unhandled rejection.

**Fix:** Add a wrapper function or upgrade to Express 5:
```javascript
const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);
app.get('/api/search', asyncHandler(async (req, res) => { ... }));
```

---

### 2.8 No Express global error-handling middleware
**Services:** App, GenAI

Neither service has a centralized error handler. Express's default sends raw HTML stack traces to clients.

```javascript
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
```

---

### 2.9 API key exposed in client-side HTML
**Service:** App — `services/app/src/index.js`

The server-side `API_KEY` is injected into every HTML response via `window.APP_API_KEY`. Anyone with browser access has the key, defeating the purpose of API key authentication.

---

### 2.10 No Helmet or security headers
**Service:** App — `services/app/src/index.js`

No `helmet` middleware is used. The app serves HTML without `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, or `Strict-Transport-Security` headers.

---

### 2.11 No rate limiting on CPU/GPU-heavy endpoints
**Services:** App (`/api/search`), GenAI (`/api/agent`)

Search runs SBERT inference (~200ms per query); the agent triggers LLM inference (~5–15s). Neither has rate limiting.

---

### 2.12 `genai` service has no `depends_on: postgres`
**Service:** GenAI compose — `docker-compose.genai.yml`

The `genai` service uses `DATABASE_URL` pointing to `postgres` but declares no dependency. It may attempt to connect before Postgres is healthy.

---

### 2.13 No base `docker-compose.yml` file
**Service:** Root

`npm run up` and `npm run down` run `docker compose` without `-f` flags, which will fail because no `docker-compose.yml` or `compose.yml` exists.

---

### 2.14 GenAI monolithic 801-line single file
**Service:** GenAI — `services/genai/index.js`

All routes, middleware, 9 tool definitions, 8 executor functions, the system prompt, and LLM client live in one file.

---

## 3. Medium Findings

### 3.1 Cron job has no concurrency guard
**Services:** All 6 ETL

If a cron tick fires while a previous `run()` is still executing, a second run starts concurrently, doubling DB connections and memory.

```javascript
let running = false;
cron.schedule(CRON_SCHEDULE, async () => {
  if (running) return console.log('Skipping — previous run still active');
  running = true;
  try { await run(extractor); } finally { running = false; }
});
```

---

### 3.2 Synchronous file read on every `GET /` request
**Service:** App — `services/app/src/index.js` line 187

`fs.readFileSync()` is called on every request to serve `index.html`. Should be cached at startup.

---

### 3.3 No `unhandledRejection` handler
**Services:** All (app, genai, 6× ETL)

No global handler for unhandled promise rejections. Node 22 terminates on unhandled rejections by default.

---

### 3.4 Prompt injection surface
**Service:** GenAI

User records from the database are serialised directly into the system prompt. Adversarial content in DB fields (e.g. a `first_name` containing LLM directives) can subvert agent behaviour.

---

### 3.5 Auth silently disabled when API key is empty
**Services:** App, GenAI

If `API_KEY` is unset, the auth middleware calls `next()` without warning — all endpoints are unauthenticated.

---

### 3.6 `startJob()` unsafe destructuring
**Services:** All 6 ETL

```javascript
return rows[0].sp_etl_start_job; // crashes if rows is empty
```

No guard against the stored procedure returning zero rows.

---

### 3.7 No input validation on query parameters
**Service:** App

`req.query.email` and `req.query.q` have no length limits, format validation, or sanitisation.

---

### 3.8 Docker images use `node:22` instead of `node:22-slim`
**Services:** All 8 Dockerfiles

The full `node:22` image is ~1.1 GB (includes gcc, make, python3). `node:22-slim` is ~200 MB. For services that only run JavaScript, the build tools are unnecessary.

---

### 3.9 No multi-stage Docker builds
**Services:** All 8 Dockerfiles

A multi-stage build could pre-download SBERT model weights and produce a smaller final image with reduced cold-start time.

---

### 3.10 Inconsistent `npm ci` flags
**Services:** Dockerfiles

4 older ETL Dockerfiles use `npm ci --only=production` (deprecated in npm 7+). 2 newer ones correctly use `--omit=dev`.

---

### 3.11 `app` service has no restart policy or health check
**Service:** App compose — `docker-compose.app.yml`

The `app` is the only service with no `restart:` policy — it stays down after a crash.

---

### 3.12 Unused `pgdata` named volume
**Service:** Postgres compose — `docker-compose.postgres.yml`

A top-level `pgdata:` volume is declared but never referenced. The service uses a bind-mount instead.

---

### 3.13 Node version mismatch: CI vs Docker
**Service:** CI pipeline

CI tests run on Node **20** (`node-version: '20'`). All Dockerfiles build on Node **22**. This could mask compatibility issues.

---

### 3.14 LLM tool call arguments not validated against schema
**Service:** GenAI

The LLM's `fnArgs` are passed directly to executor functions. If the LLM omits a required parameter, it's inserted as `NULL` into the database.

---

### 3.15 Only the first LLM tool call is processed
**Service:** GenAI — `services/genai/index.js` line 555

If the LLM returns multiple tool calls, all but the first are silently dropped.

---

### 3.16 No pool error listener
**Services:** All (app, genai, 6× ETL)

`pg.Pool` can emit `error` events from idle clients. Without `pool.on('error', ...)`, these become unhandled exceptions.

---

### 3.17 Potential XSS via unescaped `extraMeta` in innerHTML
**Service:** App — `services/app/src/public/index.html`

The `extraMeta` string is built with template literals and injected via `innerHTML`. While input comes from the API, a stored XSS attack in the database would propagate through.

---

### 3.18 Empty existing JSON file loaded synchronously into memory
**Services:** All 6 ETL

`fs.readFileSync()` loads complete JSON data files into memory at once, blocking the event loop.

---

### 3.19 Full table loaded into Map for change detection
**Services:** All 6 ETL

`SELECT * FROM sp_get_existing_*()` loads all rows into a JS `Map`. For large tables this doubles memory usage.

---

### 3.20 Massive code duplication across ETL services
**Services:** All 6 ETL

~340 lines of identical code (pool creation, job logging, vectorisation, cron bootstrap) duplicated across 6 services. Should be extracted to a shared `etl-shared` module.

---

### 3.21 GenAI `stream: false` adds latency
**Service:** GenAI

LLM output is fully buffered before responding. SSE streaming would improve perceived performance.

---

### 3.22 No embedding cache for repeated search queries
**Service:** App

Identical search queries re-run SBERT inference. An LRU cache on the embedding function would eliminate redundant ~200ms inference calls.

---

## 4. Low Findings

| # | Finding | Service(s) |
|---|---|---|
| 4.1 | No `engines` field in any `package.json` | All |
| 4.2 | Magic number `384` (HIDDEN_SIZE) without explanatory comment | All ETL |
| 4.3 | Inconsistent env var style — map vs list in compose | Postgres vs others |
| 4.4 | Inconsistent image naming — `user-search_*:dev` vs `etl-*:latest` | Compose files |
| 4.5 | Inconsistent WORKDIR — `/usr/src/app` vs `/app` | Dockerfiles |
| 4.6 | Inconsistent DB config — `DATABASE_URL` vs individual `PG*` vars | App/GenAI vs ETL |
| 4.7 | Redundant `express.json()` applied globally and per-route | App |
| 4.8 | 2 ETL services redundantly declare Jest as devDependency | M365, SP |
| 4.9 | Empty query returns 200 instead of 400 | App |
| 4.10 | No pagination on search or change-log endpoints | App |
| 4.11 | API key comparison not timing-safe | GenAI |
| 4.12 | `genai` service has no `.dockerignore` file | GenAI |

---

## 5. Recommended Tests

### 5.1 Unit Tests — High Priority

| Test | Service | Why |
|---|---|---|
| `parseQuery()` — source aliases, multi-source, edge cases | App | Complex regex with 20+ patterns |
| `extractAttributeFilters()` — enabled/disabled/locked/type | App | Regex-based filter extraction |
| `preprocessQuery()` — noise stripping, stopwords | App | NLP preprocessing |
| `normaliseValue()` — null, Date, object, string | ETL (shared) | Used in every change-detection comparison |
| `vectorizeBatch()` — empty, single, boundary sizes | ETL (shared) | Core embedding logic |
| Auth middleware — missing key, valid key, invalid key, empty env | App, GenAI | Security-critical |
| Tool executor validation — missing params, invalid target_system | GenAI | Guards against LLM hallucination |
| `createAndCloseTicket` — success and DB failure paths | GenAI | Transaction reliability |

### 5.2 Unit Tests — Medium Priority

| Test | Service | Why |
|---|---|---|
| `esc()` function — XSS edge cases (single quotes, backticks) | App (client) | Security-critical |
| Ollama response parsing — valid tool call, no tool call, malformed JSON | GenAI | LLM output is unpredictable |
| Config validation — NaN port, missing env vars | App, GenAI | Fail-fast on misconfiguration |
| Batch boundary conditions — 0, 1, BATCH_SIZE, BATCH_SIZE+1 records | ETL | Edge cases in batching logic |
| Error response shape — consistent JSON format across all routes | App, GenAI | API contract |

### 5.3 Integration Tests

| Test | Scope | Why |
|---|---|---|
| Postgres → ETL round-trip: run `upsertPrimaryBatch` against test DB | ETL + Postgres | Validates stored procedures + JS logic together |
| Search API → SBERT → Postgres: query returns ranked results | App + Postgres | End-to-end search correctness |
| Lookup API → all 10 sources returned | App + Postgres | Validates `sp_lookup_by_email` completeness |
| Agent tool call → ticket created → action executed → ticket closed | GenAI + Postgres | Full agent lifecycle |
| Health check endpoints return 200 with correct shape | GenAI | Operational readiness |

### 5.4 Regression Tests

| Test | Trigger | Why |
|---|---|---|
| Change detection: update 1 field → exactly 1 change log + correct old/new values | ETL | Prevents double-logging or missed changes |
| Change detection: delete a record → creates "deleted" change log entry | ETL | Deletion tracking integrity |
| Intersection search: "users in AD and netforum" returns only email overlap | App | Complex query logic |
| Multi-source lookup: email in DG contacts array is found | App | JSONB membership detection |
| Cron concurrency: two ticks fire, only one run executes | ETL | Prevents data corruption from overlapping runs |

### 5.5 Suggested Test Setup

```javascript
// Example: services/app/test/parseQuery.test.js
const { parseQuery } = require('../src/queryParser');

describe('parseQuery', () => {
  it('detects source alias "AD"', () => {
    const result = parseQuery('john smith AD');
    expect(result.sources).toContain('active_directory');
    expect(result.searchTerms).toBe('john smith');
  });

  it('detects intersection "in AD and netforum"', () => {
    const result = parseQuery('users in AD and netforum');
    expect(result.intersection).toEqual(['active_directory', 'netforum_members']);
  });

  it('strips noise words', () => {
    const result = parseQuery('find me the user john');
    expect(result.searchTerms).toBe('john');
  });

  it('handles empty query', () => {
    const result = parseQuery('');
    expect(result.searchTerms).toBe('');
    expect(result.sources).toEqual([]);
  });
});
```

```javascript
// Example: services/etl-shared/test/normaliseValue.test.js
const { normaliseValue } = require('../index');

describe('normaliseValue', () => {
  it('returns null for null/undefined', () => {
    expect(normaliseValue(null)).toBeNull();
    expect(normaliseValue(undefined)).toBeNull();
  });

  it('converts Date to ISO string', () => {
    const d = new Date('2026-01-15T10:30:00Z');
    expect(normaliseValue(d)).toBe('2026-01-15T10:30:00.000Z');
  });

  it('JSON-stringifies objects', () => {
    expect(normaliseValue({ a: 1 })).toBe('{"a":1}');
  });

  it('converts numbers to string', () => {
    expect(normaliseValue(42)).toBe('42');
  });
});
```

---

## 6. Quick Wins (< 1 hour each)

| # | Fix | Impact |
|---|---|---|
| 1 | Generate and commit `package-lock.json` | Unblocks CI |
| 2 | Add M365 + SP compose fragments to `dev:up` script | 2 ETL pipelines missing from dev workflow |
| 3 | Fix ETL model-cache mount: `/root/.cache` → `/home/node/.cache` | Eliminates redundant model downloads |
| 4 | Add `restart: unless-stopped` to app compose | App stays up after crash |
| 5 | Add `depends_on: postgres: condition: service_healthy` to genai | Prevents startup race |
| 6 | Remove unused `pgdata:` volume from postgres compose | Dead code |
| 7 | Replace `node:22` with `node:22-slim` in all Dockerfiles | ~80% smaller images |
| 8 | Replace `--only=production` with `--omit=dev` in 4 ETL Dockerfiles | Fix deprecated npm flag |
| 9 | Add graceful shutdown handler to all services | Clean connection/pool closure |
| 10 | Add `pool.on('error', ...)` to all services | Prevents unhandled exceptions |
| 11 | Wrap `failJob()` in try/catch in all ETL catch blocks | Preserves original error on DB failure |
| 12 | Cache `index.html` read at app startup | Eliminates per-request disk I/O |
