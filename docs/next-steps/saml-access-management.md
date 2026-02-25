# Next Steps: SAML-Based Access Management

**Date:** February 25, 2026

---

## 1. Objective

Implement a **SAML 2.0 Single Sign-On (SSO)** integration to authenticate users and enforce role-based access control (RBAC) across the User Search application and GenAI assistant. User roles will be defined in the Identity Provider (IdP) and delivered as SAML attributes, with role metadata included in the ETL pipeline for auditability.

---

## 2. Current State

| Area | Status |
|---|---|
| Authentication | **None** — the application is unauthenticated; all endpoints are open |
| Authorisation | **None** — all users have equal access to search, lookup, chat, and ETL status |
| User identity | Not tracked — GenAI chat sessions use client-generated UUIDs with no user binding |
| Role definitions | Not yet implemented — roles to be sourced from IdP and ETL metadata |

---

## 3. Role Definitions

Roles are defined in the SAML IdP and will be included as a SAML attribute in the assertion. The ETL pipeline will also ingest role metadata to enable role-aware queries and audit logging.

| Role | Permissions | Description |
|---|---|---|
| `viewer` | Search, lookup, view change history | Read-only access to all data |
| `analyst` | All `viewer` permissions + ETL status, GenAI chat (read-only queries) | Can use the assistant for analytical questions |
| `operator` | All `analyst` permissions + GenAI agentic actions (add/remove group members) | Can instruct the AI to make changes |
| `admin` | All `operator` permissions + user management, system configuration | Full access including role assignment visibility |

### 3.1 Role Hierarchy

```
admin ⊃ operator ⊃ analyst ⊃ viewer
```

Each higher role inherits all permissions of the roles below it.

---

## 4. Architecture

### 4.1 SAML Flow

```
┌──────────┐        ┌─────────────────┐        ┌──────────────┐
│  Browser  │──(1)──▶│  App Service    │──(2)──▶│  SAML IdP    │
│           │◀─(6)───│  (SP)           │◀─(5)───│  (e.g. Entra │
│           │──(3)──▶│  :3000          │        │   ID, Okta)  │
│           │        └─────────────────┘        └──────────────┘
│           │──(4)──▶  IdP Login Page
```

1. User navigates to `http://localhost:3000`
2. App detects no session → generates SAML AuthnRequest → redirects to IdP
3. Browser follows redirect to IdP login page
4. User authenticates at IdP
5. IdP POSTs SAML Response (signed assertion) back to App's ACS endpoint
6. App validates assertion, extracts attributes (email, role, name), creates session

### 4.2 Service Changes

| Service | Change |
|---|---|
| `services/app` | Add SAML SP middleware, session management, ACS endpoint, role-aware route guards |
| `services/genai` | Accept authenticated user context (email, role) from app proxy; enforce tool-level permissions |
| ETL services | Ingest role metadata from IdP-synced data source; include role in `active_directory` records |
| Postgres | New `user_sessions` table; `role` column added to relevant tables |

---

## 5. Implementation Plan

### Phase 1 — SAML Integration on App Service (Estimated: 3–4 days)

#### Step 1: Install SAML Dependencies

Add `@node-saml/passport-saml` and `express-session` to `services/app/package.json`:

```json
{
  "dependencies": {
    "@node-saml/passport-saml": "^5.0.0",
    "passport": "^0.7.0",
    "express-session": "^1.18.0",
    "connect-pg-simple": "^10.0.0"
  }
}
```

#### Step 2: SAML Configuration

Create `services/app/src/config/saml.js`:

```js
module.exports = {
  // Service Provider (this app)
  callbackUrl: process.env.SAML_CALLBACK_URL || 'http://localhost:3000/auth/saml/callback',
  issuer: process.env.SAML_ISSUER || 'user-search-app',
  
  // Identity Provider
  entryPoint: process.env.SAML_ENTRY_POINT,        // IdP SSO URL
  cert: process.env.SAML_IDP_CERT,                  // IdP signing certificate (PEM)
  
  // Attribute mapping
  attributes: {
    email:     'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    lastName:  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    role:      'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
  },
};
```

#### Step 3: Add Auth Routes

| Route | Method | Purpose |
|---|---|---|
| `/auth/saml/login` | GET | Generates SAML AuthnRequest, redirects to IdP |
| `/auth/saml/callback` | POST | Assertion Consumer Service (ACS) — validates SAML response, creates session |
| `/auth/saml/logout` | GET | Destroys local session, optionally sends SAML LogoutRequest |
| `/auth/saml/metadata` | GET | Returns SP metadata XML for IdP configuration |
| `/auth/me` | GET | Returns current user session (email, role, name) |

#### Step 4: Session Management

Store sessions in Postgres using `connect-pg-simple`:

```sql
-- Add to infra/db/init/13_session_table.sql
CREATE TABLE IF NOT EXISTS user_sessions (
  sid     VARCHAR NOT NULL PRIMARY KEY,
  sess    JSONB NOT NULL,
  expire  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_user_sessions_expire ON user_sessions (expire);
```

Session payload will contain:

```json
{
  "user": {
    "email": "jane.doe@corp.com",
    "firstName": "Jane",
    "lastName": "Doe",
    "role": "operator"
  },
  "authenticatedAt": "2026-02-25T10:00:00Z"
}
```

#### Step 5: Route Guards Middleware

```js
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.redirect('/auth/saml/login');
  }
  next();
}

function requireRole(...roles) {
  const HIERARCHY = { admin: 4, operator: 3, analyst: 2, viewer: 1 };
  return (req, res, next) => {
    const userLevel = HIERARCHY[req.session.user.role] || 0;
    const minLevel = Math.min(...roles.map(r => HIERARCHY[r] || 99));
    if (userLevel < minLevel) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
```

Apply to existing routes:

| Route | Minimum Role |
|---|---|
| `GET /api/search` | `viewer` |
| `GET /api/lookup` | `viewer` |
| `GET /api/etl-jobs` | `analyst` |
| `POST /api/chat` (proxy to genai) | `analyst` |
| GenAI agentic actions (add/remove) | `operator` |

---

### Phase 2 — Role-Aware GenAI (Estimated: 2–3 days)

#### Step 6: Pass User Context to GenAI

The app service's chat proxy (`POST /api/chat`) will forward the authenticated user's identity:

```js
// In app service chat proxy
const payload = {
  sessionId: req.body.sessionId,
  message: req.body.message,
  user: {
    email: req.session.user.email,
    role: req.session.user.role,
    name: `${req.session.user.firstName} ${req.session.user.lastName}`,
  },
};
```

#### Step 7: Enforce Permissions in GenAI Tool Execution

In the GenAI service, gate tool execution on the user's role:

```js
const TOOL_PERMISSIONS = {
  add_user_to_group:      'operator',
  remove_user_from_group: 'operator',
};

function canExecuteTool(toolName, userRole) {
  const HIERARCHY = { admin: 4, operator: 3, analyst: 2, viewer: 1 };
  const required = TOOL_PERMISSIONS[toolName] || 'admin';
  return (HIERARCHY[userRole] || 0) >= (HIERARCHY[required] || 99);
}
```

If a `viewer` or `analyst` asks to add a user to a group, the assistant responds:

> *"You don't have permission to modify distribution groups. This action requires the **operator** role. Please contact your administrator."*

#### Step 8: Audit User Identity in Logs

Extend `source_change_logs` and `chat_messages` to include the authenticated user:

```sql
ALTER TABLE source_change_logs ADD COLUMN IF NOT EXISTS performed_by TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS user_email TEXT;
```

All agent-executed changes record `performed_by` = the authenticated user's email for full traceability.

---

### Phase 3 — ETL Role Metadata Ingestion (Estimated: 2–3 days)

#### Step 9: Extend Active Directory Schema

Add a `role` column to `active_directory` to store the user's application role as synced from the IdP:

```sql
ALTER TABLE active_directory ADD COLUMN IF NOT EXISTS app_role TEXT DEFAULT 'viewer';
```

#### Step 10: ETL Role Sync

The `etl-ad-line` service will read role assignments from the source data (exported from the IdP or an HR system) and include them in the primary data:

```json
{
  "first_name": "Jane",
  "last_name": "Doe",
  "email": "jane.doe@corp.com",
  "type": "user",
  "enabled": true,
  "locked": false,
  "passwordlastreset": "2026-01-15T00:00:00Z",
  "app_role": "operator"
}
```

Changes to `app_role` will be tracked in `source_change_logs` like any other field, providing a full audit trail of role assignments:

```
[active_directory] jane.doe@corp.com — updated at 2026-02-25T10:00:00Z
  field: app_role  "analyst" → "operator"
```

#### Step 11: Role-Aware GenAI Context

The GenAI system prompt and context retrieval can reference role data:

- *"What role does jane.doe@corp.com have?"* → queries `active_directory.app_role`
- *"Who are all the operators?"* → filters `active_directory WHERE app_role = 'operator'`
- *"When was John Smith's role last changed?"* → queries `source_change_logs WHERE field_name = 'app_role'`

---

### Phase 4 — Hardening & Production Readiness (Estimated: 2–3 days)

| Step | Task |
|---|---|
| 12 | SAML assertion signature validation with certificate rotation support |
| 13 | Session expiry and re-authentication flow (configurable TTL, default 8 hours) |
| 14 | CSRF protection on SAML callback and state-changing endpoints |
| 15 | HTTPS enforcement (TLS termination at load balancer in AWS; local dev via reverse proxy) |
| 16 | IdP metadata auto-refresh (periodic fetch of IdP metadata XML) |
| 17 | Fallback for local development (optional bypass with `SAML_ENABLED=false` env var, auto-assigns `admin` role) |

---

## 6. Environment Variables

| Variable | Description | Example |
|---|---|---|
| `SAML_ENABLED` | Enable/disable SAML auth (`true`/`false`) | `true` |
| `SAML_ENTRY_POINT` | IdP SSO URL | `https://login.microsoftonline.com/.../saml2` |
| `SAML_IDP_CERT` | IdP signing certificate (base64 PEM) | `MIIC8D...` |
| `SAML_CALLBACK_URL` | ACS URL for this app | `https://user-search.corp.com/auth/saml/callback` |
| `SAML_ISSUER` | SP entity ID | `user-search-app` |
| `SESSION_SECRET` | Express session signing secret | `<random 64-char string>` |
| `SESSION_MAX_AGE` | Session TTL in milliseconds | `28800000` (8 hours) |

Add to `docker-compose.app.yml`:

```yaml
environment:
  - SAML_ENABLED=${SAML_ENABLED:-false}
  - SAML_ENTRY_POINT=${SAML_ENTRY_POINT}
  - SAML_IDP_CERT=${SAML_IDP_CERT}
  - SAML_CALLBACK_URL=${SAML_CALLBACK_URL:-http://localhost:3000/auth/saml/callback}
  - SAML_ISSUER=${SAML_ISSUER:-user-search-app}
  - SESSION_SECRET=${SESSION_SECRET:-dev-secret-change-in-prod}
```

---

## 7. Docker Compose Changes

No new containers required. Changes are confined to the existing `app` and `genai` services:

| File | Change |
|---|---|
| `docker-compose.app.yml` | Add SAML and session environment variables |
| `docker-compose.genai.yml` | No changes — receives user context via request body from app proxy |
| `infra/db/init/13_session_table.sql` | New init script for `user_sessions` table |

---

## 8. Security Considerations

| Concern | Mitigation |
|---|---|
| SAML assertion replay | Validate `NotOnOrAfter` and `InResponseTo` conditions; reject assertions older than 5 minutes |
| Session hijacking | `HttpOnly`, `Secure`, `SameSite=Strict` cookie flags; session stored server-side in Postgres |
| Privilege escalation | Role derived exclusively from signed SAML assertion — cannot be modified client-side |
| Role stale-ness | Session TTL forces periodic re-authentication; ETL syncs role changes from IdP source |
| Local dev security | `SAML_ENABLED=false` only available when `NODE_ENV !== 'production'` |
| Audit completeness | All agent actions tagged with `performed_by` from session; change log is append-only |

---

## 9. Success Criteria

- [ ] Users authenticate via SAML SSO before accessing the application
- [ ] SAML assertions include the user's role as an attribute
- [ ] Route guards enforce minimum role requirements on all API endpoints
- [ ] GenAI agentic tools (add/remove group members) are restricted to `operator` and above
- [ ] `viewer` and `analyst` roles cannot trigger write actions via the assistant
- [ ] All chat messages and change logs record the authenticated user's email
- [ ] ETL pipeline syncs `app_role` from source data and tracks changes
- [ ] Role changes appear in the change history UI
- [ ] Local development works without an IdP via `SAML_ENABLED=false` bypass
- [ ] Session expiry forces re-authentication after configured TTL
