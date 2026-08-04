# Next Steps: SAML-Based Access Management

**Date:** February 25, 2026
**Updated:** August 3, 2026

---

## 1. Objective

Implement a **SAML 2.0 Single Sign-On (SSO)** integration to authenticate users and enforce role-based access control (RBAC) across the User Search application and GenAI assistant.

**Scope:** The application is internal-only. Access is restricted to users with an **Active Directory account** — the corporate Active Directory (via Entra ID / Azure AD) is the SAML Identity Provider. No external users are in scope.

**Constraint:** No roles currently exist in the IdP or any other system that map users to application-level permissions. The IdP SAML assertion will carry authentication claims only (identity, email, name) — **no role attribute will be present**. A separate role management capability must be built to assign and store application roles; this is described in Phase 3 below.

---

## 2. Current State

| Area | Status |
|---|---|
| Authentication | **None** — the application is unauthenticated; all endpoints are open |
| Authorisation | **None** — all users have equal access to search, lookup, chat, ETL status, and all 37 agent tools |
| User identity | Not tracked — GenAI chat sessions use client-generated UUIDs with no user binding |
| Agent tickets | `agent_tickets` table records write actions but without a `performed_by` user column |
| Access requests | `access_requests` table records self-service requests with a `requested_by` column (nullable, not authenticated) |
| Role definitions | **Not implemented and not available from IdP** — no role attributes exist in Active Directory or Entra ID for this application; a role management system must be built to assign roles to AD users |

---

## 3. Role Definitions

> **Important:** Roles are **not** delivered by the SAML IdP. The AD/Entra ID assertion will only contain identity claims (email, first name, last name, UPN). Application roles are stored in the local database and managed via the role management system described in Phase 3. Until a role is explicitly assigned, all authenticated AD users receive the `viewer` role by default.

| Role | Permissions | Description | Default |
|---|---|---|---|
| `viewer` | Search, lookup, view change history | Read-only access to all data | **Yes — all AD users** |
| `analyst` | All `viewer` permissions + ETL status, GenAI agent (read-only queries: inactive licenses, stale guests, app consents, device compliance, MFA status, out-of-office, Conditional Access, access templates, ticket/request listing) | Can use the assistant for analytical questions | No — must be assigned |
| `operator` | All `analyst` permissions + GenAI agentic write actions (provision, reset password, update attribute, group management, M365 service desk actions, onboarding, access request approval, access templates) | Can instruct the AI to make changes; cannot disable/offboard or access sensitive governance tools | No — must be assigned |
| `admin` | All `operator` permissions + destructive actions (disable, offboard, deprovision cascade, bulk operations, governance write actions, BitLocker key retrieval, risky user dismissal) + role assignment, system configuration | Full access including assigning roles to other users | No — must be assigned |

### 3.1 Role Hierarchy

```
admin ⊃ operator ⊃ analyst ⊃ viewer
```

Each higher role inherits all permissions of the roles below it.

### 3.2 Role Assignment Source of Truth

Since no role system exists in the IdP, roles are managed in a dedicated `user_roles` table in Postgres. An `admin`-role user assigns roles to other AD users via the role management UI (see Phase 3). The SAML assertion is used only to verify identity — role is always read from the local database after authentication.

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
| `services/app` | Add SAML SP middleware, session management, ACS endpoint, role-aware route guards, role management API (`/api/admin/roles`), and role management UI panel |
| `services/genai` | Accept authenticated user context (email, role) from app proxy; enforce tool-level permissions |
| ETL services | No changes required for SAML — role management is handled independently of the ETL pipeline |
| Postgres | New `user_sessions` table; new `user_roles` table (replaces ETL-driven `app_role` column) |

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
  
  // Attribute mapping — identity claims only; no role attribute is available from the IdP.
  // Application role is resolved from the local user_roles table after authentication.
  attributes: {
    email:     'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    lastName:  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    // NOTE: 'role' is intentionally absent — Entra ID does not carry application role claims.
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

After the SAML assertion is validated, the app looks up the user's role from the `user_roles` table (defaulting to `viewer` if no record exists):

```js
// In the SAML callback handler, after assertion validation:
const { rows } = await pool.query(
  `SELECT role FROM user_roles WHERE email = $1`,
  [samlUser.email]
);
const role = rows[0]?.role || 'viewer'; // default: viewer for all AD users
req.session.user = { ...samlUser, role };
```

Session payload will contain:

```json
{
  "user": {
    "email": "jane.doe@corp.com",
    "firstName": "Jane",
    "lastName": "Doe",
    "role": "viewer"
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
| GenAI read-only agent queries | `analyst` |
| GenAI write actions (provision, reset, update, group, M365, onboard, access request) | `operator` |
| GenAI destructive actions (disable, offboard, deprovision, bulk disable, governance writes) | `admin` |

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

In the GenAI service, gate tool execution on the user's role. Use the full `ROLE_TOOL_ALLOWLIST` defined in `docs/next-steps/agentic-ai-expansion.md` (Section 2.2) as the authoritative server-side permission map across all 37 tools:

```js
const ROLE_HIERARCHY = { admin: 4, operator: 3, analyst: 2, viewer: 1 };

function canExecuteTool(toolName, userRole) {
  const allowlist = ROLE_TOOL_ALLOWLIST[userRole];
  if (allowlist === null) return true;           // admin: unrestricted
  if (!allowlist) return false;                  // viewer: no agent access
  return allowlist.includes(toolName);
}
```

If a `viewer` or `analyst` asks to perform a write action, the assistant responds:

> *"You don't have permission to perform this action. This requires the **operator** role. Please contact your administrator."*

#### Step 8: Audit User Identity in Logs

Extend `agent_tickets`, `access_requests`, and `chat_messages` to include the authenticated user:

```sql
ALTER TABLE agent_tickets    ADD COLUMN IF NOT EXISTS performed_by TEXT;
ALTER TABLE access_requests  ADD COLUMN IF NOT EXISTS performed_by TEXT;
ALTER TABLE chat_messages    ADD COLUMN IF NOT EXISTS user_email    TEXT;
```

All agent-executed changes record `performed_by` = the authenticated user's email for full traceability. The `access_requests` table already has a nullable `requested_by` column which maps to `performed_by` once authentication is in place.

---

### Phase 3 — Role Management System (Estimated: 3–4 days)

Since no role source exists in the IdP or any upstream system, a role management capability must be built into the application. An `admin`-role user must be able to view all AD accounts and assign application roles to them.

> **Note:** The `access_requests` table (`infra/db/init/16_access_requests.sql`) is already implemented as part of the agent's self-service access request capability. This is a separate concern from RBAC — it tracks requests for resources (groups, licenses, SharePoint sites) rather than application-level role assignments. The `user_roles` table described below is still required and has not yet been created.

#### Step 9: Role Storage — `user_roles` Table

Create a dedicated table to store application role assignments. This is separate from `active_directory` so that role changes do not require an ETL re-run and the audit trail is independent:

```sql
-- Add to infra/db/init/17_user_roles.sql
CREATE TABLE IF NOT EXISTS user_roles (
  email       TEXT        PRIMARY KEY,
  role        TEXT        NOT NULL DEFAULT 'viewer'
                          CHECK (role IN ('viewer', 'analyst', 'operator', 'admin')),
  assigned_by TEXT,                          -- email of the admin who made the assignment
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

All authenticated AD users not in this table are implicitly `viewer`. An explicit `viewer` row is written on first login for auditability.

#### Step 10: Role Management API Endpoints

| Method | Path | Role Required | Purpose |
|---|---|---|---|
| `GET` | `/api/admin/roles` | `admin` | List all users with assigned roles |
| `PUT` | `/api/admin/roles/:email` | `admin` | Assign or update a user's role |
| `DELETE` | `/api/admin/roles/:email` | `admin` | Remove explicit role assignment (reverts user to `viewer`) |
| `GET` | `/api/admin/roles/:email` | `admin` | Get a specific user's current role |

```js
// PUT /api/admin/roles/:email
app.put('/api/admin/roles/:email', requireRole('admin'), async (req, res) => {
  const { email } = req.params;
  const { role } = req.body;
  const VALID_ROLES = ['viewer', 'analyst', 'operator', 'admin'];
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }
  await pool.query(
    `INSERT INTO user_roles (email, role, assigned_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE
       SET role = $2, assigned_by = $3, updated_at = now()`,
    [email, role, req.session.user.email]
  );
  res.json({ email, role, assigned_by: req.session.user.email });
});
```

#### Step 11: Role Management UI

A role management panel must be added to the application, accessible only to `admin` users. Minimum requirements:

| Feature | Detail |
|---|---|
| User list | Displays all users from `active_directory` with their current role (join with `user_roles`, default `viewer`) |
| Role assignment | Dropdown or button-set to assign `viewer` / `analyst` / `operator` / `admin` |
| Audit trail | Shows `assigned_by` and `assigned_at` / `updated_at` for each assignment |
| Search/filter | Filter by email, name, or current role |
| Constraint | Only `admin` users can access this panel — all other roles receive `HTTP 403` |

> **Bootstrapping:** The first `admin` user must be seeded directly into the `user_roles` table (e.g. via an init script or a one-time CLI command) before the UI can be used. Subsequent admins are assigned via the UI.

#### Step 12: Role-Aware GenAI Context

The GenAI system prompt and context retrieval can reference role data via the `user_roles` table:

- *"What role does jane.doe@corp.com have?"* → queries `user_roles WHERE email = ...`
- *"Who are all the operators?"* → queries `user_roles WHERE role = 'operator'`
- *"When was John Smith's role last changed?"* → queries `user_roles.updated_at`

---

### Phase 4 — Hardening & Production Readiness (Estimated: 2–3 days)

| Step | Task |
|---|---|
| 13 | SAML assertion signature validation with certificate rotation support |
| 14 | Session expiry and re-authentication flow (configurable TTL, default 8 hours) |
| 15 | CSRF protection on SAML callback and state-changing endpoints |
| 16 | HTTPS enforcement (TLS termination at load balancer in AWS; local dev via reverse proxy) |
| 17 | IdP metadata auto-refresh (periodic fetch of IdP metadata XML) |
| 18 | Fallback for local development (optional bypass with `SAML_ENABLED=false` env var, auto-assigns `admin` role for dev convenience only) |
| 19 | Seed script for initial `admin` user (`infra/db/init/seed_admin_role.sql` or CLI command) |

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
| Privilege escalation | Identity derived from signed SAML assertion — cannot be modified client-side; role always re-read from `user_roles` table after authentication, never trusted from session alone |
| Role stale-ness | Session TTL forces periodic re-authentication; on each re-auth, role is re-fetched from `user_roles` to pick up changes made by an admin |
| Unauthorised role assignment | `PUT /api/admin/roles/:email` is guarded by `requireRole('admin')`; `assigned_by` is set from the server-side session, not from the request body |
| Admin bootstrap risk | Initial admin seed is a one-time manual operation; document and restrict who can run it |
| Local dev security | `SAML_ENABLED=false` only available when `NODE_ENV !== 'production'` |
| Audit completeness | All agent actions tagged with `performed_by` from session; role assignments record `assigned_by` and `updated_at`; change log is append-only |

---

## 9. Success Criteria

- [ ] Only users with a valid Active Directory account (via Entra ID SAML) can access the application
- [ ] Non-AD users (external, unauthenticated) receive a redirect to the IdP login and cannot access any endpoint
- [ ] SAML assertion is validated (signature, `NotOnOrAfter`, audience); no role attribute is expected or consumed from the assertion
- [ ] After authentication, the user's role is resolved from the `user_roles` table; unenrolled AD users receive `viewer` by default
- [ ] Route guards enforce minimum role requirements on all API endpoints
- [ ] GenAI agentic tools (provision, disable, reset password, update attributes, group management) are restricted to `operator` and above
- [ ] `viewer` and `analyst` roles cannot trigger write actions via the assistant
- [ ] All agent actions and change logs record the authenticated user's email (`performed_by`)
- [ ] `admin` users can assign and remove roles via the role management UI and API
- [ ] Role assignments are stored in `user_roles` with `assigned_by` and `updated_at` for audit purposes
- [ ] Initial `admin` user can be bootstrapped via a seed script before the UI is available
- [ ] Role changes take effect on the user's next login (session re-authentication re-fetches role)
- [ ] Local development works without an IdP via `SAML_ENABLED=false` bypass
