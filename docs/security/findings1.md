# Security Findings — user-search

**Version:** 1  
**Date:** 2026-02-22  
**Analyst:** security-specialist (read-only review)  
**Scope:** Full codebase — Express API backend, frontend, ETL services, Dockerfiles, container orchestration

---

## Finding 1 — Hardcoded Credentials in Source Files and Compose Configs

**Category:** Credential Management / Secrets Exposure  
**Severity:** High

**Locations:**
- `docker-compose.postgres.yml` — `POSTGRES_PASSWORD: postgres`
- `docker-compose.app.yml` — `DATABASE_URL=postgresql://postgres:postgres@postgres:5432/appdb`
- `services/app/src/index.js` (line 13) — hardcoded fallback connection string
- `services/*/vectorize.js` — `password: process.env.PGPASSWORD || 'postgres'` (all ETL services)

**Description:** The Postgres password `postgres` is committed in plaintext to version-controlled compose files and used as a hardcoded fallback in every service. Any developer or CI system with repository read access obtains valid database credentials. If this repository is ever public, or CI logs are exposed, the credentials are immediately compromised.

**Remediation:**
- Move all secrets to a secrets manager (e.g., Docker Secrets, AWS Secrets Manager, HashiCorp Vault) or at minimum to a `.env` file that is `.gitignore`d.
- Remove all hardcoded fallback values from application code — force explicit configuration and fail fast at startup if credentials are absent.
- Rotate the Postgres password immediately if this repository has any external exposure.

---

## Finding 2 — Postgres Port Exposed on All Host Interfaces

**Category:** Network Exposure / Unnecessary Attack Surface  
**Severity:** High

**Location:** `docker-compose.postgres.yml` — `ports: - "5433:5432"`

**Description:** Port 5433 on the Docker host is bound to all network interfaces (`0.0.0.0`). Any host-level network access to port 5433 reaches the Postgres instance directly, bypassing the Docker internal network. Combined with the weak default password (`postgres`), this creates a direct path for an unauthenticated attacker on the same network to compromise the database.

**Remediation:**
- Remove the `ports` mapping entirely from `docker-compose.postgres.yml`. Services within Docker Compose communicate via the internal network; host exposure is not required.
- If host access is genuinely needed for development tooling, bind only to loopback: `"127.0.0.1:5433:5432"`.

---

## Finding 3 — No Authentication on Any API Endpoint

**Category:** Authentication / Missing Access Control  
**Severity:** High

**Location:** `services/app/src/index.js` — `/api/search` and `/api/lookup` route definitions

**Description:** Both API endpoints are completely unauthenticated. Any client that can reach port 3000 can query the full contents of the database, which contains PII (names, email addresses, account state, sponsor information, activity history) across Active Directory, netForum, External Users, Distribution Groups, and activity logs. There is no API key, session token, JWT, or IP allowlist protecting this data.

**Remediation:**
- Introduce an authentication middleware (e.g., `express-jwt`, `passport`, or a custom API-key check) before all `/api/*` routes.
- For an internal tool, a shared API key passed via a header (`Authorization: Bearer <key>`) is a practical minimum.
- Consider network-level controls (VPN, internal DNS) as a secondary layer, not a replacement for application-level auth.

---

## Finding 4 — No Rate Limiting on Expensive Endpoints

**Category:** Denial of Service / Resource Exhaustion  
**Severity:** Medium

**Location:** `services/app/src/index.js` — `/api/search` handler

**Description:** Each call to `/api/search` performs an SBERT embedding (CPU-intensive transformer inference) followed by a 9-table `UNION ALL` vector similarity query against Postgres. There is no rate limiting, request queuing, or per-client throttle. An attacker or misconfigured client can send a high volume of requests, saturating the CPU with embedding work and exhausting the Postgres connection pool.

**Remediation:**
- Add `express-rate-limit` middleware scoped to the `/api/search` route.
- Set a per-IP request limit appropriate to expected usage (e.g., 30 requests/minute).
- Optionally add a request queue or concurrency limiter around the SBERT pipeline.

---

## Finding 5 — No Input Length Validation on Query Parameter

**Category:** Input Validation / Resource Exhaustion  
**Severity:** Medium

**Location:** `services/app/src/index.js` — `q` query parameter passed directly to SBERT pipeline

**Description:** The `q` query parameter is passed to the SBERT model without any length check. An attacker can submit arbitrarily long strings (e.g., several megabytes of text), causing the transformer model to spend disproportionate time and memory on a single request. There is also no upper-bound validation on `TOP_K`, though this is a deployment-time concern.

**Remediation:**
- Enforce a maximum query length before invoking the embedding pipeline (e.g., 500 characters):
  ```js
  if (q.length > 500) return res.status(400).json({ error: 'Query too long' });
  ```
- Validate that `TOP_K` is within a sensible bounded range at startup.

---

## Finding 6 — Reflected XSS via Unescaped Server Data in Card View

**Category:** Cross-Site Scripting (XSS)  
**Severity:** Medium

**Location:** `services/app/src/public/index.html` — search results card rendering block

**Description:** The `esc()` helper (DOM-based, using `textContent`) is correctly implemented and applied consistently in the detail panel via `field()`. However, several locations in the search results card construct raw HTML from API response values without calling `esc()`:

- `extraMeta += ' · Sponsor: ' + r.sponsor` — `r.sponsor` inserted unescaped
- `r.accountsAdded.map(a => \`${a.first_name} ${a.last_name}\`)` — member names unescaped
- Distribution group contact list built without escaping `first_name`/`last_name`

If any of these fields in the database contain a payload such as `<img src=x onerror=alert(1)>`, it will execute in the victim's browser.

**Remediation:**
- Apply `esc()` to every value interpolated into an HTML string: `r.sponsor`, `a.first_name`, `a.last_name`, account list values, and any `r.notes` rendered outside `field()`.
- Prefer constructing DOM nodes programmatically (`createElement`, `textContent`) rather than via `innerHTML` template literals for any user-controlled data.

---

## Finding 7 — Containers Running as Root

**Category:** Privilege Escalation / Container Security  
**Severity:** Medium

**Location:** `services/app/Dockerfile`, `services/active-directory/Dockerfile` (all ETL Dockerfiles share the same pattern — no `USER` directive)

**Description:** All Dockerfiles use the `node:18` base image without a `USER` directive. Processes inside all containers run as root (UID 0). If an attacker achieves Remote Code Execution through any vulnerability in the application or its dependencies, they immediately have root access within the container, which can facilitate container escape and host compromise depending on the Docker configuration.

**Remediation:**
Add a non-root user to every Dockerfile. The `node:18` base image includes a built-in `node` user:
```dockerfile
USER node
```
Or create a dedicated user:
```dockerfile
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser
```

---

## Finding 8 — No HTTP Security Headers

**Category:** Security Misconfiguration / Missing Defense-in-Depth  
**Severity:** Medium

**Location:** `services/app/src/index.js` — Express app setup (no `helmet` or manual headers)

**Description:** The application sets no security-relevant HTTP response headers. The following are absent:

| Header | Risk Without It |
|---|---|
| `Content-Security-Policy` | Inline scripts; resources from any origin |
| `X-Frame-Options` / `frame-ancestors` | Clickjacking via iframe embedding |
| `X-Content-Type-Options: nosniff` | MIME-type sniffing attacks |
| `Strict-Transport-Security` | No HSTS enforcement |
| `Referrer-Policy` | Full URL leaked in `Referer` header |

**Remediation:**
- Add `helmet` middleware: `app.use(require('helmet')())` — sets sensible defaults for all of the above in a single call.
- Define a `Content-Security-Policy` restricting scripts to `'self'` and removing `'unsafe-inline'` (which also requires moving inline event handlers to `addEventListener` calls).

---

## Finding 9 — No HTTPS / Transport Encryption

**Category:** Cryptography / Data in Transit  
**Severity:** Medium

**Location:** `docker-compose.app.yml` — port `3000:3000`, HTTP only

**Description:** The application serves all traffic over plain HTTP. All data transmitted between the client and server — including search queries containing PII, full user records returned from lookup, and any future authentication tokens — is sent in cleartext. A network-adjacent attacker can passively capture all queries and results.

**Remediation:**
- Terminate TLS at a reverse proxy or load balancer (e.g., nginx with Let's Encrypt, or an AWS ALB) in front of the Node.js application.
- Redirect HTTP to HTTPS at the proxy layer.
- For Docker Compose, add an nginx container with SSL termination.

---

## Finding 10 — No Explicit Request Body Size Limit

**Category:** Denial of Service / Input Validation  
**Severity:** Low

**Location:** `services/app/src/index.js` — `app.use(express.json())`

**Description:** `express.json()` is configured with no `limit` option. Express's built-in default is 100 KB, which is reasonable, but it is not explicitly declared. A future configuration change could silently raise this limit, and the absence of an explicit declaration leaves intent undocumented.

**Remediation:**
```js
app.use(express.json({ limit: '10kb' }));
```

---

## Finding 11 — Internal Error Detail Exposure via Console Logging

**Category:** Information Disclosure  
**Severity:** Low

**Location:** `services/app/src/index.js` — `console.error('Search error:', err)`

**Description:** Full `Error` objects including stack traces and potentially connection string details (surfaced by the `pg` library on connection failures) are logged to `stdout`/`stderr`. If logs are forwarded to a shared or externally-accessible aggregation system without scrubbing, this leaks internal topology, file paths, and connection parameters. Client-facing error responses are correctly generic (`{ error: 'Search failed' }`).

**Remediation:**
- Use a structured logger (e.g., `pino`) that sanitizes sensitive fields.
- Log error codes and messages in production; reserve full stack traces for `NODE_ENV=development`.
- Ensure log aggregation pipelines enforce access controls.

---

## Finding 12 — Unverified ML Model Weights from External Source

**Category:** Supply Chain Security  
**Severity:** Low

**Location:** `docker-compose.app.yml` — `data-output/model-cache` bind-mount volume; `@xenova/transformers` downloads `all-MiniLM-L6-v2` from Hugging Face at runtime

**Description:** SBERT model weights are downloaded at runtime from `huggingface.co` and cached in a host bind-mount directory. There is no checksum or signature verification on the downloaded weights. A compromised Hugging Face repository, a CDN-level MITM, or direct tampering with the host-mounted cache directory could substitute malicious model weights, causing silent data integrity failures or exfiltration through embedding-level side-channels.

**Remediation:**
- Pin the model version and verify file hashes after download.
- In production, pre-download and bundle the model weights into the Docker image build (air-gap the runtime from external network calls).
- Restrict write access to the `model-cache` host directory.

---

## Summary

| # | Category | Severity |
|---|---|---|
| 1 | Hardcoded Credentials | **High** |
| 2 | Postgres Port Exposed | **High** |
| 3 | Missing Authentication | **High** |
| 4 | Missing Rate Limiting | **Medium** |
| 5 | Missing Input Length Validation | **Medium** |
| 6 | XSS — Unescaped Data in Card View | **Medium** |
| 7 | Containers Running as Root | **Medium** |
| 8 | Missing Security Headers | **Medium** |
| 9 | Missing HTTPS | **Medium** |
| 10 | No Explicit Body Size Limit | **Low** |
| 11 | Error Detail Exposure via Logs | **Low** |
| 12 | Unverified ML Model Weights | **Low** |

**High:** 3 · **Medium:** 6 · **Low:** 3
