# Security Review: Post-Streaming Findings
**Review date:** 2026-02-25
**Reviewer:** security-specialist (automated)
**Scope:** Streaming (SSE) changes introduced on `ai-hackathon-learning` branch — `services/app/src/index.js` proxy update, `services/app/src/public/index.html` frontend update, `services/genai/index.js` streaming path.
**Mode:** Read-only — no code changes made in this review.

---

## Executive Summary

The addition of Server-Sent Events (SSE) streaming for the GenAI chat feature introduced no new **high** severity findings. Three **low/medium** observations are noted below — two related to resource exhaustion and one related to unvalidated upstream header forwarding.

No persistent findings from `findings2.md` have been remediated in this change set; they remain open.

---

## New Findings

### F3-N1 — No timeout on long-lived SSE connections · Severity: **Medium** ✅ REMEDIATED 2026-02-25

**Affected files:**
- `services/app/src/index.js` — chat proxy SSE pipe (lines 411–432)
- `services/genai/index.js` — `streamChatWithOllama()` + `/api/chat` handler

**Description:**
The SSE proxy in `app/src/index.js` holds an HTTP connection open for the full duration of LLM token generation. There is no `AbortController` timeout and no maximum stream duration. If Ollama stalls (e.g., model loading, OOM), the connection hangs indefinitely. A small number of concurrent stalled requests can exhaust the Node.js connection pool or the host's open file descriptor limit.

Similarly, the genai service's SSE handler has no server-side timeout wrapping `streamChatWithOllama()`.

**Recommendation:**
```js
// In app proxy — abort after 120 s
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 120_000);
const upstream = await fetch(`${GENAI_URL}/api/chat`, {
  signal: ac.signal,
  ...
});
clearTimeout(timer);
```
Apply the same pattern in `genai/index.js` around `streamChatWithOllama()`.

---

### F3-N2 — Upstream content-type accepted without strict validation · Severity: **Low**

**Affected file:** `services/app/src/index.js` lines 418–430

**Description:**
The proxy checks `upstream.headers.get('content-type')?.includes('text/event-stream')` before entering SSE pipe mode. However, a compromised or misbehaving genai service could return `content-type: text/event-stream` for a non-streaming body (e.g., a large JSON error payload), causing the proxy to stream it raw to the browser without any sanitization. In the current all-local deployment this is low risk, but would be higher risk if the genai service were ever replaced by an external endpoint.

**Recommendation:**
No immediate code change required for the current deployment. If the genai service is ever replaced by or proxied through an external service, add response body size limits and content validation before piping.

---

### F3-N3 — `?stream=true` query parameter accepted by genai service · Severity: **Low** ✅ REMEDIATED 2026-02-25

**Affected file:** `services/genai/index.js` line 437

**Description:**
```js
const wantsStream = req.headers.accept === 'text/event-stream'
  || req.query.stream === 'true';
```
The `?stream=true` query-string trigger allows SSE mode to be activated without the correct `Accept` header. This means any tool or script that hits `/api/chat?stream=true` — including browser navigations, logged URLs, or curl commands — will receive a raw SSE stream. URLs (including query parameters) are commonly stored in access logs, browser history, and referrer headers with less protection than request headers, slightly increasing the chance of an unintended long-lived connection being opened.

**Recommendation:**
Remove the `req.query.stream === 'true'` branch and require the `Accept: text/event-stream` header exclusively. The app proxy already sets this header correctly.

---

## Persistent Findings (from findings1.md / findings2.md — still open)

| ID | Description | Severity | Status |
|---|---|---|---|
| F1-P1 | Hardcoded `\|\| 'postgres'` password fallback in all `vectorize.js` files | **High** | ❌ Open |
| F1-F3 | No authentication on any API endpoint | **High** | ✅ Remediated 2026-02-25 |
| F1-P7 / F2-P7 | Containers running as root — no `USER node` in Dockerfiles | **Medium** | ✅ Remediated 2026-02-25 |
| F1-F6 | Reflected XSS — unescaped server data in search card rendering | **Medium** | ❌ Open |
| F1-F8 | No HTTP security headers (`helmet` not installed) | **Medium** | ❌ Open |
| F2-N3 | Template-literal table name in `truncate()` — no whitelist guard | **Low** | ❌ Open |

---

## Risk Delta vs. findings2.md

| Area | Before (pre-streaming) | After (streaming) | Delta |
|---|---|---|---|
| Chat response delivery | Blocking JSON response | Non-blocking SSE stream | ✅ Better UX, ≈ same risk |
| Connection lifetime | Short (one response) | Long (duration of generation) | ⚠️ New DoS surface if no timeout |
| Upstream header forwarding | N/A | Content-type soft-checked | ⚠️ Low risk — internal only |
| Stream trigger surface | N/A | Header + query param | ⚠️ Minor — query param is extra surface |
| New High findings | — | 0 | ✅ |
| New Medium findings | — | 1 (F3-N1 timeout) — ✅ remediated | ✅ |
| New Low findings | — | 2 (F3-N2, F3-N3) — F3-N3 ✅ remediated | ℹ️ |

---

## Recommended Remediation Priority

| Priority | Finding | Effort |
|---|---|---|
| 1 | ~~F3-N1 — Add `AbortController` timeout to SSE proxy and genai handler~~ | ✅ Done |
| 2 | ~~F3-N3 — Remove `?stream=true` query-param trigger~~ | ✅ Done |
| 3 | F1-P1 — Remove hardcoded password fallback | Low (× 4 files) |
| 4 | F1-F3 — Add authentication middleware | Medium |
| 5 | F1-P7 — Add `USER node` to Dockerfiles | Low (× 5 Dockerfiles) |
