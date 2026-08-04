# GenAI Actions — Production Implementation Guide

## Overview

In the current proof of concept, all agent "actions" (provision account, disable account,
update attribute, lifecycle workflows, access request approvals, etc.) execute **directly
against the local Postgres database**. This is useful for demonstrating the concept but has
no real-world effect on upstream systems.

In production, each write action must translate into **authenticated API calls** to the
actual source systems: Azure AD (Entra ID), NetForum, Exchange/M365, SharePoint, and
Distribution Groups. Ticket and access request management should route to ServiceNow or
Jira rather than the local `agent_tickets` and `access_requests` Postgres tables.

---

## Current State vs Production State

| Action | PoC (now) | Production |
|---|---|---|
| `provision_account` | INSERT into local Postgres | POST to target system's user-creation API |
| `disable_account` | UPDATE local Postgres row | PATCH/PUT to target system's disable endpoint |
| `update_attribute` | UPDATE local Postgres column | PATCH to target system's attribute endpoint |
| `reset_password` | UPDATE local Postgres column | PATCH to Entra ID Graph API (`/users/{id}/resetPassword`) |
| `add_to_group` / `add_to_m365_group` | INSERT into local memberships table | POST to Graph API group membership endpoint |
| `reset_mfa` / `assign_license` / M365 actions | Simulated via Graph mock client | Graph API calls via `services/genai/graph-client.js` (already wired; needs real credentials) |
| `onboard_user` | Orchestrates multiple local Postgres inserts | Orchestrates real API calls: provision AD + NetForum, assign license, add to groups — in sequence |
| `offboard_user` | Orchestrates multiple local Postgres updates | Orchestrates real API calls: disable all accounts, remove groups, revoke SharePoint, reclaim license |
| `deprovision_cascade` | Multiple local Postgres updates | Remove from all groups + revoke SharePoint via Graph API; reclaim license |
| `bulk_action` | Loop of local Postgres operations | Loop of real API calls per target user; batch where Graph API supports it |
| `submit_access_request` | INSERT into local `access_requests` table | POST to ITSM (ServiceNow/Jira) to create approval request |
| `approve_access_request` | UPDATE `access_requests` + execute Postgres action | ITSM approval callback → execute provisioning API call |
| `create_ticket` | INSERT into `agent_tickets` | POST to ticketing system API (ServiceNow, Jira, etc.) |
| `compare_sources` | SELECT from local tables | No change (read-only, local data is fine) |
| `lookup_user` | SELECT from local tables | No change (read-only, local data is fine) |
| Governance reads (e.g. `list_inactive_licenses`, `get_device_compliance`) | SELECT from local Postgres + Graph mock | Graph API calls for live data (already wired via `graph-client.js`) |

> **Read actions** (search, lookup, compare) can remain as-is — they query the ETL-synced
> local data which is the whole point of the search platform. Only **write actions** need
> to call upstream APIs.

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│   Agent      │────▶│  Action Router    │────▶│  Action Executors  │
│  (Bedrock /  │     │  (validates +     │     │  (per-system API   │
│   Ollama)    │     │   authorises)     │     │   clients)         │
└─────────────┘     └──────────────────┘     └────────┬───────────┘
                                                       │
                    ┌──────────────────────────────────┤
                    │              │            │       │
                    ▼              ▼            ▼       ▼
              ┌──────────┐ ┌───────────┐ ┌─────────┐ ┌──────────┐
              │ Entra ID │ │ NetForum  │ │  M365 / │ │ Service  │
              │ Graph API│ │   REST    │ │ Exchange│ │  Now     │
              └──────────┘ └───────────┘ └─────────┘ └──────────┘
```

> **Note:** Microsoft Graph integration is already centralised in
> `services/genai/graph-client.js`. When `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`,
> and `ENTRA_CLIENT_SECRET` are set, the service switches from the safe mock client
> to the real Graph SDK automatically. The remaining work is replacing the Postgres
> write operations with real API calls for account lifecycle actions.

---

## 1. Credential Management

### 1.1 Credential Types per System

| System | Auth Method | Credentials Required |
|---|---|---|
| **Azure AD / Entra ID** | OAuth 2.0 Client Credentials | `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` |
| **Microsoft Graph (M365)** | OAuth 2.0 Client Credentials | Same as Entra (shared app registration) or separate |
| **Exchange Online** | OAuth 2.0 + EWS / Graph | `EXCHANGE_TENANT_ID`, `EXCHANGE_CLIENT_ID`, `EXCHANGE_CLIENT_SECRET` |
| **SharePoint Online** | OAuth 2.0 + Graph / REST | `SP_TENANT_ID`, `SP_CLIENT_ID`, `SP_CLIENT_SECRET`, `SP_SITE_URL` |
| **NetForum** | API Key or OAuth | `NETFORUM_BASE_URL`, `NETFORUM_API_KEY` or client credentials |
| **Distribution Groups** | Graph API (same tenant) | Shared with Entra credentials |
| **Ticketing (ServiceNow)** | OAuth 2.0 or Basic Auth | `SNOW_INSTANCE_URL`, `SNOW_CLIENT_ID`, `SNOW_CLIENT_SECRET` |

### 1.2 Storage Strategy

**Never store credentials in code, environment variables on disk, or Docker Compose files.**

```
Production credential flow:

  AWS Secrets Manager 
      │
      ▼
  Application startup → fetch secrets → cache in memory (with TTL)
      │
      ▼
  Action executor uses cached credential → refresh on 401/expiry
```

#### Recommended Implementation

```javascript
// filepath: services/genai/credentials/secretsManager.js
'use strict';

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
const cache = new Map();
const TTL_MS = 15 * 60 * 1000; // 15 minutes

async function getSecret(secretName) {
  const cached = cache.get(secretName);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return cached.value;
  }

  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: secretName }),
  );
  const value = JSON.parse(SecretString);
  cache.set(secretName, { value, ts: Date.now() });
  return value;
}

module.exports = { getSecret };
```

### 1.3 Token Management

Each OAuth system needs a token manager that handles acquisition and refresh:

```javascript
// filepath: services/genai/credentials/tokenManager.js
'use strict';

const tokens = new Map();

class TokenManager {
  constructor(name, fetchTokenFn) {
    this.name = name;
    this.fetchToken = fetchTokenFn;
  }

  async getToken() {
    const cached = tokens.get(this.name);
    if (cached && Date.now() < cached.expiresAt - 60_000) {
      return cached.accessToken;
    }

    const result = await this.fetchToken();
    tokens.set(this.name, {
      accessToken: result.access_token,
      expiresAt: Date.now() + (result.expires_in * 1000),
    });
    return result.access_token;
  }
}

module.exports = { TokenManager };
```

---

## 2. Action Executor Refactoring

### 2.1 Current Structure (PoC)

```
services/genai/
  agent/
    toolExecutor.js    ← All 6 executors in one file, all hit Postgres
```

### 2.2 Production Structure

```
services/genai/
  agent/
    toolExecutor.js          ← Router: delegates to correct system executor
  actions/
    index.js                 ← Action registry
    entra/
      client.js              ← Microsoft Graph client with token management
      provisionAccount.js    ← POST /users
      disableAccount.js      ← PATCH /users/{id} { accountEnabled: false }
      updateAttribute.js     ← PATCH /users/{id} { [field]: value }
    netforum/
      client.js              ← NetForum REST client
      provisionAccount.js
      disableAccount.js
      updateAttribute.js
    m365/
      client.js              ← Graph client scoped to M365 group operations
      provisionAccount.js    ← POST /groups/{id}/members/$ref
      disableAccount.js      ← DELETE /groups/{id}/members/{userId}/$ref
    sharepoint/
      client.js              ← SharePoint REST / Graph client
      updatePermissions.js
    exchange/
      client.js              ← EWS or Graph client
      provisionMailbox.js
      disableMailbox.js
    ticketing/
      client.js              ← ServiceNow / Jira client
      createTicket.js
  credentials/
    secretsManager.js        ← Vault / Secrets Manager integration
    tokenManager.js          ← OAuth token cache + refresh
```

### 2.3 Action Registry

```javascript
// filepath: services/genai/actions/index.js
'use strict';

const entraProvision   = require('./entra/provisionAccount');
const entraDisable     = require('./entra/disableAccount');
const entraUpdate      = require('./entra/updateAttribute');
const nfProvision      = require('./netforum/provisionAccount');
const nfDisable        = require('./netforum/disableAccount');
const nfUpdate         = require('./netforum/updateAttribute');
const m365Provision    = require('./m365/provisionAccount');
const m365Disable      = require('./m365/disableAccount');
const spUpdate         = require('./sharepoint/updatePermissions');
const ticketCreate     = require('./ticketing/createTicket');

const EXECUTORS = {
  provision_account: {
    ad:        entraProvision,
    netforum:  nfProvision,
    m365:      m365Provision,
  },
  disable_account: {
    ad:        entraDisable,
    netforum:  nfDisable,
    m365:      m365Disable,
  },
  update_attribute: {
    ad:        entraUpdate,
    netforum:  nfUpdate,
    sharepoint: spUpdate,
  },
  create_ticket: {
    _default:  ticketCreate,
  },
};

function getExecutor(action, targetSystem) {
  const actionMap = EXECUTORS[action];
  if (!actionMap) throw new Error(`Unknown action: ${action}`);

  const executor = actionMap[targetSystem] || actionMap._default;
  if (!executor) throw new Error(`No executor for ${action} on ${targetSystem}`);

  return executor;
}

module.exports = { getExecutor };
```

### 2.4 Example: Entra ID (Azure AD) Executor

```javascript
// filepath: services/genai/actions/entra/client.js
'use strict';

const { getSecret } = require('../../credentials/secretsManager');
const { TokenManager } = require('../../credentials/tokenManager');

const tokenManager = new TokenManager('entra', async () => {
  const creds = await getSecret('prod/genai/entra-credentials');
  const params = new URLSearchParams({
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
    scope:         'https://graph.microsoft.com/.default',
    grant_type:    'client_credentials',
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', body: params },
  );

  if (!res.ok) throw new Error(`Entra token error: ${res.status}`);
  return res.json();
});

async function graphRequest(method, path, body) {
  const token = await tokenManager.getToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Graph API ${method} ${path} failed (${res.status}): ${error}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

module.exports = { graphRequest };
```

```javascript
// filepath: services/genai/actions/entra/provisionAccount.js
'use strict';

const { graphRequest } = require('./client');

async function execute({ email, display_name, department, job_title }) {
  const mailNickname = email.split('@')[0];

  const user = await graphRequest('POST', '/users', {
    accountEnabled:    true,
    displayName:       display_name,
    mailNickname,
    userPrincipalName: email,
    department:        department || null,
    jobTitle:          job_title || null,
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password: generateTempPassword(),
    },
  });

  return {
    success: true,
    userId:  user.id,
    email:   user.userPrincipalName,
    message: `Account provisioned in Entra ID for ${email}`,
  };
}

function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let pw = '';
  for (let i = 0; i < 16; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

module.exports = { execute };
```

```javascript
// filepath: services/genai/actions/entra/disableAccount.js
'use strict';

const { graphRequest } = require('./client');

async function execute({ email }) {
  // Look up user by UPN
  const user = await graphRequest('GET', `/users/${encodeURIComponent(email)}`);

  await graphRequest('PATCH', `/users/${user.id}`, {
    accountEnabled: false,
  });

  return {
    success: true,
    userId:  user.id,
    email,
    message: `Account disabled in Entra ID for ${email}`,
  };
}

module.exports = { execute };
```

```javascript
// filepath: services/genai/actions/entra/updateAttribute.js
'use strict';

const { graphRequest } = require('./client');

// Map our internal field names to Graph API property names
const FIELD_MAP = {
  display_name: 'displayName',
  first_name:   'givenName',
  last_name:    'surname',
  job_title:    'jobTitle',
  department:   'department',
  office:       'officeLocation',
  phone:        'businessPhones',
  city:         'city',
  state:        'state',
  country:      'country',
};

async function execute({ email, field, new_value }) {
  const graphField = FIELD_MAP[field];
  if (!graphField) {
    throw new Error(`Field "${field}" is not mapped to a Graph API property`);
  }

  const user = await graphRequest('GET', `/users/${encodeURIComponent(email)}`);

  const body = {};
  if (graphField === 'businessPhones') {
    body[graphField] = [new_value]; // Graph expects an array
  } else {
    body[graphField] = new_value;
  }

  await graphRequest('PATCH', `/users/${user.id}`, body);

  return {
    success: true,
    email,
    field,
    new_value,
    message: `Updated ${field} to "${new_value}" in Entra ID for ${email}`,
  };
}

module.exports = { execute };
```

---

## 3. Approval Workflow

In production, the agent should **not execute write actions immediately**. An approval
workflow is essential.

### 3.1 Two-Phase Execution

```
Agent decides action → Create pending ticket → Human approves → Execute API call
```

```javascript
// filepath: services/genai/agent/toolExecutor.js (production version)
'use strict';

const { getExecutor } = require('../actions');

// Actions that require human approval before execution
const APPROVAL_REQUIRED = new Set([
  'provision_account',
  'disable_account',
  'update_attribute',
]);

async function executeAction(action, params, pool, requestedBy) {
  if (APPROVAL_REQUIRED.has(action)) {
    // Don't execute — create an approval request
    const ticketId = await createApprovalRequest(pool, {
      action,
      params,
      requestedBy,
      targetSystem: params.target_system,
    });

    return {
      status:  'pending_approval',
      ticketId,
      message: `Action "${action}" requires approval. Ticket ${ticketId} created.`,
    };
  }

  // Read-only actions execute immediately
  const executor = getExecutor(action, params.target_system);
  return executor.execute(params);
}

async function createApprovalRequest(pool, { action, params, requestedBy, targetSystem }) {
  const { rows } = await pool.query(
    `INSERT INTO agent_tickets
       (action, target_system, payload, requested_by, status)
     VALUES ($1, $2, $3, $4, 'pending_approval')
     RETURNING ticket_id`,
    [action, targetSystem, JSON.stringify(params), requestedBy],
  );
  return rows[0].ticket_id;
}

module.exports = { executeAction };
```

### 3.2 Approval Callback Endpoint

```javascript
// filepath: services/genai/routes/approvals.js
'use strict';

const express = require('express');
const router  = express.Router();
const { getExecutor } = require('../actions');

// POST /api/approvals/:ticketId/approve
router.post('/:ticketId/approve', async (req, res) => {
  const { ticketId } = req.params;
  const { approvedBy } = req.body;
  const pool = req.app.locals.pool;

  const { rows } = await pool.query(
    `UPDATE agent_tickets
     SET status = 'approved', approved_by = $2, approved_at = NOW()
     WHERE ticket_id = $1 AND status = 'pending_approval'
     RETURNING *`,
    [ticketId, approvedBy],
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Ticket not found or already processed' });
  }

  const ticket = rows[0];
  const params = JSON.parse(ticket.payload);

  try {
    const executor = getExecutor(ticket.action, ticket.target_system);
    const result = await executor.execute(params);

    await pool.query(
      `UPDATE agent_tickets SET status = 'completed', result = $2 WHERE ticket_id = $1`,
      [ticketId, JSON.stringify(result)],
    );

    res.json({ status: 'completed', result });
  } catch (err) {
    await pool.query(
      `UPDATE agent_tickets SET status = 'failed', result = $2 WHERE ticket_id = $1`,
      [ticketId, JSON.stringify({ error: err.message })],
    );
    res.status(500).json({ error: err.message });
  }
});

// POST /api/approvals/:ticketId/reject
router.post('/:ticketId/reject', async (req, res) => {
  const { ticketId } = req.params;
  const { rejectedBy, reason } = req.body;
  const pool = req.app.locals.pool;

  const { rows } = await pool.query(
    `UPDATE agent_tickets
     SET status = 'rejected', approved_by = $2, result = $3
     WHERE ticket_id = $1 AND status = 'pending_approval'
     RETURNING *`,
    [ticketId, rejectedBy, JSON.stringify({ reason })],
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Ticket not found or already processed' });
  }

  res.json({ status: 'rejected', reason });
});

module.exports = router;
```

---

## 4. Audit Logging

Every action execution must be logged for compliance:

```javascript
// filepath: services/genai/audit/logger.js
'use strict';

async function logAuditEvent(pool, {
  action,
  targetSystem,
  targetEmail,
  requestedBy,
  status,        // 'success' | 'failure' | 'pending_approval'
  ticketId,
  request,       // sanitised request payload (no secrets)
  response,      // API response summary
  errorMessage,
}) {
  await pool.query(
    `INSERT INTO agent_audit_log
       (action, target_system, target_email, requested_by,
        status, ticket_id, request_payload, response_payload, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      action, targetSystem, targetEmail, requestedBy,
      status, ticketId,
      JSON.stringify(request),
      response ? JSON.stringify(response) : null,
      errorMessage || null,
    ],
  );
}

module.exports = { logAuditEvent };
```

```sql
-- Migration: create audit log table
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id               BIGSERIAL PRIMARY KEY,
  action           TEXT        NOT NULL,
  target_system    TEXT        NOT NULL,
  target_email     TEXT,
  requested_by     TEXT        NOT NULL,
  status           TEXT        NOT NULL,
  ticket_id        INTEGER     REFERENCES agent_tickets(ticket_id),
  request_payload  JSONB,
  response_payload JSONB,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_email ON agent_audit_log (target_email);
CREATE INDEX idx_audit_log_action ON agent_audit_log (action, created_at);
```

---

## 5. Error Handling & Retry

Production API calls fail. Each executor should use a retry wrapper:

```javascript
// filepath: services/genai/actions/retry.js
'use strict';

const RETRY_DELAYS = [1000, 3000, 10000]; // ms

async function withRetry(fn, context = '') {
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode;

      // Don't retry client errors (except 429 rate limit)
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }

      if (attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.warn(
          `[retry] ${context} attempt ${attempt + 1} failed (${err.message}), ` +
          `retrying in ${delay}ms...`,
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

module.exports = { withRetry };
```

---

## 6. Required Configuration (per environment)

### Environment Variables / Secrets

```
# ── Entra ID / Azure AD ──────────────────────────
ENTRA_TENANT_ID=<uuid>
ENTRA_CLIENT_ID=<uuid>
ENTRA_CLIENT_SECRET=<secret>          # → Secrets Manager in prod

# ── NetForum ──────────────────────────────────────
NETFORUM_BASE_URL=https://netforum.example.com/api
NETFORUM_API_KEY=<key>                # → Secrets Manager in prod

# ── SharePoint ────────────────────────────────────
SP_TENANT_ID=<uuid>
SP_CLIENT_ID=<uuid>
SP_CLIENT_SECRET=<secret>             # → Secrets Manager in prod
SP_SITE_URL=https://example.sharepoint.com/sites/main

# ── Ticketing (ServiceNow) ────────────────────────
SNOW_INSTANCE_URL=https://example.service-now.com
SNOW_CLIENT_ID=<uuid>
SNOW_CLIENT_SECRET=<secret>           # → Secrets Manager in prod

# ── Feature Flags ─────────────────────────────────
APPROVAL_REQUIRED=true                # Enforce approval workflow
DRY_RUN=false                         # Log actions without executing
```

### Azure App Registration Permissions (Graph API)

| Permission | Type | Used For |
|---|---|---|
| `User.ReadWrite.All` | Application | Provision, disable, update users |
| `Group.ReadWrite.All` | Application | M365 group membership changes |
| `Sites.FullControl.All` | Application | SharePoint permission changes |
| `Directory.ReadWrite.All` | Application | Distribution group management |

---

## 7. Migration Checklist

- [ ] Create Azure App Registration with required Graph API permissions
- [ ] Store credentials in AWS Secrets Manager / Azure Key Vault
- [ ] Implement `credentials/secretsManager.js` for your vault provider
- [ ] Build per-system API clients (`actions/entra/client.js`, etc.)
- [ ] Refactor each account/lifecycle action executor to call real APIs (Graph, NetForum, Exchange)
- [ ] Confirm Microsoft Graph tools (`reset_mfa`, `assign_license`, M365 group, governance) already use `graph-client.js` — validate with live credentials
- [ ] Add approval workflow for `submit_access_request` / `approve_access_request` via ITSM API
- [ ] Replace `agent_tickets` Postgres table with ServiceNow/Jira ticket API in `createAndCloseTicket()`
- [ ] Add `agent_audit_log` table migration for full compliance trail
- [ ] Implement retry + circuit breaker for each external API
- [ ] Add rate limiting per target system (Graph API: 10,000 req/10min)
- [ ] Add dry-run mode for `bulk_action` and destructive lifecycle tools
- [ ] Write integration tests with mocked API responses
- [ ] Load test with realistic concurrent agent sessions
- [ ] Security review of all credential flows
- [ ] Set up monitoring/alerting for failed actions