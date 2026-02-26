# Security Review: Post-Consolidation Findings
**Review date:** 2025-07-25  
**Reviewer:** security-specialist (automated)  
**Scope:** 4 line-container services (`etl-ad-line`, `etl-netforum-line`, `etl-eu-line`, `etl-dg-line`), CI pipeline, and Docker configuration following the 8→4 container consolidation.  
**Mode:** Read-only — no code changes made in this review.

---

## Executive Summary

The consolidation from 8 containers to 4 improved the overall security posture by halving the container count and removing the `docker-compose.base.yml` shared base, reducing the supply-chain exposure. However, **two high/medium findings from `findings1.md` persist unchanged** in all four new services, and **three new findings** were introduced or identified in the refactored code.

---

## Persistent Findings (carried forward from findings1.md)

### F1-P1 — Hardcoded credential fallback · Severity: **HIGH**
**Finding ID from previous review:** Finding 1  
**Still present in:** All 4 `vectorize.js` files (e.g., `services/etl-ad-line/vectorize.js` line 33)

```js
password: process.env.PGPASSWORD || 'postgres',
```

The `|| 'postgres'` fallback means any deployment that omits `PGPASSWORD` silently connects with a well-known default credential. This is unchanged from the prior architecture.

**Recommendation:** Remove the hardcoded fallback. Let `pg.Pool` throw at startup if the env var is absent. Use Docker secrets or a secrets manager (AWS Secrets Manager, Vault) to inject the credential at runtime.

---

### F1-P7 — Containers run as root · Severity: **MEDIUM** ✅ REMEDIATED 2026-02-25
**Finding ID from previous review:** Finding 7  
**Still present in:** ~~All 4 `Dockerfile`s~~  
All 6 Dockerfiles (`app`, `genai`, and 4 ETL line services) now include `COPY --chown=node:node . .` and `USER node` before `CMD`. The `app` compose volume mount was updated from `/root/.cache` to `/home/node/.cache` to preserve the SBERT model cache path.

```dockerfile
FROM node:18
WORKDIR /app
...
CMD ["node", "vectorize.js"]   # no USER directive — runs as UID 0
```

No `USER node` directive is present in any of the four Dockerfiles. If the Node process is compromised, the attacker has root-level access inside the container.

**Recommendation:** Add `USER node` before the `CMD` instruction in each Dockerfile:
```dockerfile
RUN chown -R node:node /app
USER node
CMD ["node", "vectorize.js"]
```

---

## New Findings

### F2-N1 — End-of-life base image · Severity: **HIGH** ✅ REMEDIATED 2026-02-22
**Affected files:** All 5 Dockerfiles (`etl-ad-line`, `etl-netforum-line`, `etl-eu-line`, `etl-dg-line`, `app`)  

Node.js 18 reached **end-of-life on 30 April 2025**. All Dockerfiles have been updated to `FROM node:22` (LTS, supported until April 2027).

**Remaining recommendation:** Pin to a specific image digest (`node:22-alpine3.20@sha256:...`) for fully reproducible builds.

---

### F2-N2 — Missing `.dockerignore` in all line services · Severity: **MEDIUM** ✅ REMEDIATED 2026-02-22
**Affected files:** `services/etl-*-line/` (all 4); `services/app/` updated to match

A `.dockerignore` has been added to all 4 ETL line services, and the existing `app/.dockerignore` was expanded to match. Each now excludes:
```
node_modules/
test/
coverage/
*.log
.env*
.DS_Store
*.md
```

---

### F2-N3 — Template-literal table name in `TRUNCATE` query · Severity: **LOW** (code pattern risk)
**Affected files:** All 4 `vectorize.js` files  
**Example location:** `services/etl-ad-line/vectorize.js` line 42

```js
async function truncate(table) {
  await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY`);
}
```

The `table` parameter is string-interpolated directly into a raw SQL statement. In the current codebase the callers pass hardcoded string literals (`'active_directory'`, `'ad_activity_logs'`, etc.), so there is **no current injection path**. However, the pattern is unsafe: if `truncate()` is ever called with a value derived from external input — e.g., a config file, env var, or API response — it becomes a SQL injection vulnerability.

**Recommendation:** Validate the table name against a whitelist of known table names before issuing the query:
```js
const ALLOWED_TABLES = new Set([
  'active_directory', 'active_directory_activity_logs',
  'netforum_members',  'netforum_activity_logs',
  'external_users',    'external_user_activity_logs',
  'distribution_groups', 'distribution_group_sync_logs',
]);

async function truncate(table) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Disallowed table: ${table}`);
  await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY`);
}
```

---

## Risk Delta vs. findings1.md

| Area | Before (8 containers) | After (4 line containers) | Delta |
|---|---|---|---|
| Container count | 8 ETL + 1 app + PG = 10 | 4 ETL + 1 app + PG = 6 | ✅ −4 containers |
| Base image | `node:18` | **`node:22`** (LTS) | ✅ upgraded |
| Shared base compose | docker-compose.base.yml | **Removed** | ✅ eliminated |
| Running as root | 8 services | 4 services | ✅ −4 exposed containers |
| Hardcoded PG password fallback | 8 vectorize.js | 4 vectorize.js | ✅ −4 occurrences |
| `.dockerignore` | Absent | **Present in all 5 services** | ✅ added |
| Template-literal SQL | Not present | Present in `truncate()` | ❌ new pattern risk |

---

## Recommended Remediation Priority

| Priority | Finding | Effort |
|---|---|---|
| 1 | ~~F2-N1 — Upgrade base image to `node:22`~~ | ✅ Done — all 5 Dockerfiles updated |
| 2 | F1-P1 — Remove hardcoded password fallback | Low (remove `\|\| 'postgres'` × 4) |
| 3 | ~~F2-N2 — Add `.dockerignore` to each service~~ | ✅ Done — 5 files added/updated |
| 4 | F1-P7 — Add `USER node` to each Dockerfile | Low (2-line change × 4) |
| 5 | F2-N3 — Whitelist table names in `truncate()` | Low (add 5-line guard × 4) |
