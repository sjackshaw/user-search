# Agentic AI — User Card Agent: Production Hardening

**Date:** June 16, 2026
**Status:** 🔧 Phase 6 — Production Path (in progress)

---

## 1. Context

Phases 1–5 are complete. The agent is operational with 9 tools, 6 action executors, cross-system provisioning, M365 group support, and an embedded UI. The items below are the **remaining work** required to move the agent toward a production-ready state.

Current implementation reference:
- GenAI service: `services/genai/index.js`
- Agent tickets DB init: `infra/db/init/15_agent_tickets.sql`
- UI: `services/app/src/public/index.html`

---

## 2. Remaining Work

### 2.2 ServiceNow / Jira Ticket Integration

**File:** `services/genai/index.js` — `createAndCloseTicket()` function and all 6 executor callers

The `agent_tickets` Postgres table is a local stand-in for an ITSM system. In production, ticket creation and closure should route to ServiceNow or Jira instead.

**Implementation approach:**

The `createAndCloseTicket()` helper is the single integration point. Replace the two Postgres queries inside it (INSERT + UPDATE) with API calls to the target ITSM:

```js
async function createAndCloseTicket(pool, email, title, description, sessionId, actionFn) {
  // 1. Create ticket via ITSM API (replace Postgres INSERT)
  const ticketId = await itsmClient.createTicket({ email, title, description, sessionId });

  // 2. Execute the action
  let actionResult;
  try {
    actionResult = await actionFn();
  } catch (err) {
    await itsmClient.addComment(ticketId, `⚠️ Action failed: ${err.message}`);
    return { ticket: { id: ticketId }, actionResult: { success: false, error: err.message } };
  }

  // 3. Close ticket on success
  await itsmClient.closeTicket(ticketId, '✅ Action completed automatically by agent.');
  return { ticket: { id: ticketId, status: 'closed' }, actionResult };
}
```

The existing `GET /api/tickets` and `PATCH /api/tickets/:id` endpoints will also need to delegate to the ITSM API (or be replaced by a redirect to the ITSM portal).

**Steps:**
| Step | Task |
|---|---|
| 1 | Create `services/genai/itsm-client.js` with `createTicket()`, `closeTicket()`, `addComment()`, `listOpenTickets()` methods |
| 2 | Add environment variables: `ITSM_TYPE` (`servicenow`/`jira`), `ITSM_BASE_URL`, `ITSM_API_KEY` |
| 3 | Replace Postgres ticket INSERT/UPDATE in `createAndCloseTicket()` with `itsmClient` calls |
| 4 | Update `GET /api/tickets` to query ITSM for open tickets by email |
| 5 | Update `PATCH /api/tickets/:id` to proxy close/reopen to ITSM API |
| 6 | Keep `agent_tickets` table as audit log (write-only mirror) or remove if ITSM provides full audit trail |

---

### 2.3 SAML-Gated Permissions

**Files:** `services/genai/index.js`, `services/app/src/`

Currently the only auth guard is an API key (`x-api-key` header). Role-based access control must be enforced so that only authorised roles can invoke destructive agent actions (disable account, provision account).

**Role mapping** (from `docs/next-steps/saml-access-management.md`):

| Role | Permitted agent actions |
|---|---|
| `viewer` | None — no agent access |
| `analyst` | `list_open_tickets`, `describe_capabilities` |
| `operator` | All tools except user management (`provision_account`, `disable_account`, `reset_password`, `update_attribute`, `add_to_group`, `add_to_m365_group`) |
| `admin` | All tools |

**Implementation steps:**

| Step | Task |
|---|---|
| 1 | Complete SAML SSO integration (see `docs/next-steps/saml-access-management.md`) — this is a prerequisite |
| 2 | Decode the SAML assertion server-side and attach `req.user.role` in middleware |
| 3 | In `POST /api/agent`, after the API key guard, read `req.user.role` and compare the resolved `fnName` against a per-role allowlist |
| 4 | Return `HTTP 403` with `{ error: 'Insufficient permissions for action: <tool>' }` if the role is not authorised |
| 5 | Add `role` to `agent_tickets` (or ITSM ticket) for audit trail |
| 6 | Expose the user's role to the UI so action buttons / prompt placeholder can be adapted accordingly |

**Permitted tools per role (server-side allowlist):**
```js
const ROLE_TOOL_ALLOWLIST = {
  viewer:   [],
  analyst:  ['list_open_tickets', 'describe_capabilities'],
  operator: ['provision_account', 'disable_account', 'reset_password',
             'update_attribute', 'add_to_group', 'add_to_m365_group',
             'create_ticket', 'list_open_tickets', 'describe_capabilities'],
  admin:    null, // null = unrestricted
};
```

---

## 4. Extended M365 Tenant Capabilities

The following tools extend the agent beyond the current six-action set. Each maps to a Graph API call and is grouped by audience. All actions follow the same `createAndCloseTicket()` pattern — ticket opened, Graph call executed, ticket auto-closed on success.

### 4.1 Service Desk Tools (Tier-1 Ticket Elimination)

| Tool name | User prompt example | Graph API call | Ticket auto-closes? |
|---|---|---|---|
| `reset_mfa` | *"Reset Jane's MFA so she can re-register"* | `DELETE /users/{id}/authentication/methods/{methodId}` | Yes |
| `get_mfa_status` | *"Does John have MFA enabled?"* | `GET /users/{id}/authentication/methods` | Read-only — no ticket |
| `assign_license` | *"Assign an E3 license to this user"* | `POST /users/{id}/assignLicense` | Yes |
| `remove_license` | *"Remove the Visio license from this user"* | `POST /users/{id}/assignLicense` (removeLicenses) | Yes |
| `grant_mailbox_access` | *"Give Sarah delegate access to Tom's mailbox"* | `POST /users/{id}/mailFolders/inbox/messageRules` / EWS | Yes |
| `add_email_alias` | *"Add j.smith@corp.com as an alias for Jane"* | `PATCH /users/{id}` (proxyAddresses) | Yes |
| `get_out_of_office` | *"Is John's out-of-office on?"* | `GET /users/{id}/mailboxSettings` | Read-only — no ticket |
| `set_out_of_office` | *"Set Jane's OOF message to 'Back 23 June'"* | `PATCH /users/{id}/mailboxSettings` | Yes |
| `add_to_teams_channel` | *"Add Jane to the #project-alpha channel"* | `POST /teams/{teamId}/channels/{channelId}/members` | Yes |
| `grant_onedrive_access` | *"Give Sarah read access to Tom's OneDrive"* | `POST /drives/{id}/root/permissions` | Yes |

### 4.2 Governance Tools

| Tool name | User prompt example | Graph API call | Ticket auto-closes? |
|---|---|---|---|
| `list_inactive_licenses` | *"Which users have unused E3 licenses?"* | `GET /reports/getOffice365ActiveUserDetail` | Read-only — no ticket |
| `list_stale_guests` | *"Show guest accounts with no sign-in for 90 days"* | `GET /users?$filter=userType eq 'Guest'` + `signInActivity` | Read-only — no ticket |
| `revoke_guest_access` | *"Revoke access for the Contoso guest account"* | `DELETE /users/{id}` or disable | Yes |
| `dismiss_risky_user` | *"Dismiss the risk flag on Jane — it's a false positive"* | `POST /identityProtection/riskyUsers/dismiss` | Yes |
| `list_app_consents` | *"What apps has John granted access to?"* | `GET /oauth2PermissionGrants?$filter=principalId eq '{id}'` | Read-only — no ticket |
| `revoke_app_consent` | *"Revoke access for the 'Grammarly' app for John"* | `DELETE /oauth2PermissionGrants/{id}` | Yes |
| `explain_ca_block` | *"Why is Jane blocked from Salesforce?"* | `GET /identity/conditionalAccess/policies` (evaluate) | Read-only — no ticket |
| `get_device_compliance` | *"Why is John's laptop non-compliant?"* | `GET /deviceManagement/managedDevices?$filter=userPrincipalName eq '...'` | Read-only — no ticket |
| `get_bitlocker_key` | *"Retrieve the BitLocker key for John's laptop"* | `GET /informationProtection/bitlockerRecoveryKeys` | Yes (audit trail) |

### 4.3 Tool Implementation Pattern

All new tools follow the same pattern as existing executors. Add each to `AGENT_TOOLS` in `services/genai/index.js` and create a corresponding `execute<ToolName>()` function. The only new dependency is a Graph API client:

```js
// services/genai/graph-client.js
const { ClientSecretCredential } = require('@azure/identity');
const { Client } = require('@microsoft/microsoft-graph-client');
const { TokenCredentialAuthenticationProvider } = require(
  '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials'
);

const credential = new ClientSecretCredential(
  process.env.ENTRA_TENANT_ID,
  process.env.ENTRA_CLIENT_ID,
  process.env.ENTRA_CLIENT_SECRET
);

const authProvider = new TokenCredentialAuthenticationProvider(credential, {
  scopes: ['https://graph.microsoft.com/.default'],
});

module.exports = Client.initWithMiddleware({ authProvider });
```

Each executor then uses `graphClient.api('/users/...').get()` / `.patch()` / `.post()` / `.delete()` instead of `pool.query()`.

### 4.4 Hackathon Priority Subset

For the initial presentation, the four highest-impact capabilities are:

| Capability | Why it lands |
|---|---|
| **MFA reset** (`reset_mfa`) | Universal pain point — everyone has filed or received this ticket. Resolving it from a Teams chat in under 10 seconds is immediately understood. |
| **Inactive license detection** (`list_inactive_licenses`) | Produces a concrete cost-savings number that can go on a slide: "X unused E3 licenses at $Y/month." |
| **Guest user lifecycle** (`list_stale_guests` + `revoke_guest_access`) | Compliance and access hygiene; guests with no sign-in for 90+ days are an easy win to quantify. |

---

## 5. Security Considerations for Remaining Work

| Item | Concern | Mitigation |
|---|---|---|
| ITSM integration | API key leakage, SSRF | Store ITSM credentials in environment variables only; validate `ITSM_BASE_URL` against a domain allowlist |
| SAML permissions | Privilege escalation via crafted prompts | Enforce tool allowlist server-side, never trust client-supplied role claims |
| Graph API credentials | Client secret exposure, over-permissioned app | Store in Secrets Manager / managed identity; grant only permissions needed for deployed tools; rotate secrets |
| Governance tool abuse | `revoke_app_consent`, `dismiss_risky_user`, `get_bitlocker_key` are high-risk | Gate all governance tools behind `admin` role in `ROLE_TOOL_ALLOWLIST`; log every invocation with user identity |
| BitLocker key access | Key retrieval is sensitive; must be auditable | Always create a ticket (even for read operations) so there is a ServiceNow audit record; restrict to `admin` role |

---

## 6. Success Criteria

- [ ] Agent tickets are created and closed via the ServiceNow API rather than the local `agent_tickets` table
- [ ] An `operator`-role user can invoke all action tools; a `viewer`-role user receives `HTTP 403`
- [ ] `list_inactive_licenses` returns a list of users with unactivated licenses, sourced live from Graph reporting API
- [ ] `list_app_consents` and `revoke_app_consent` read and modify OAuth2 permission grants for a specified user
- [ ] `list_stale_guests` and `revoke_guest_access` identify and remove guest accounts inactive for a configurable number of days
- [ ] All governance tools (`dismiss_risky_user`, `get_bitlocker_key`, `revoke_app_consent`) are restricted to `admin` role and generate a ServiceNow audit ticket regardless of outcome
