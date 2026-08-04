# Agentic AI — User Card Agent: Production Hardening

**Date:** August 3, 2026
**Status:** 🔧 Phase 7 — Production Path (in progress)

---

## 1. Context

Phases 1–6 are complete. The agent is operational with **37 tools** spanning 7 capability groups: account operations, Microsoft 365 service desk workflows, governance checks, lifecycle management (onboard/offboard), bulk operations, self-service access requests, and department access templates. The items below are the **remaining work** required to move the agent toward a production-ready state.

### 1.1 Implemented Tool Groups

| Group | Count | Tools |
|---|---|---|
| Account Operations | 6 | `provision_account`, `disable_account`, `reset_password`, `update_attribute`, `add_to_group`, `add_to_m365_group` |
| Microsoft 365 Service Desk | 10 | `reset_mfa`, `get_mfa_status`, `assign_license`, `remove_license`, `grant_mailbox_access`, `add_email_alias`, `get_out_of_office`, `set_out_of_office`, `add_to_teams_channel`, `grant_onedrive_access` |
| Governance | 9 | `list_inactive_licenses`, `list_stale_guests`, `revoke_guest_access`, `dismiss_risky_user`, `list_app_consents`, `revoke_app_consent`, `explain_ca_block`, `get_device_compliance`, `get_bitlocker_key` |
| General / Ticketing | 3 | `create_ticket`, `list_open_tickets`, `describe_capabilities` |
| Lifecycle Management | 4 | `onboard_user`, `offboard_user`, `deprovision_cascade`, `bulk_action` |
| Access Requests | 3 | `submit_access_request`, `list_access_requests`, `approve_access_request` |
| Department Access Templates | 2 | `apply_access_template`, `list_access_templates` |

### 1.2 Infrastructure Implemented

- **`agent_tickets` table** (`infra/db/init/15_agent_tickets.sql`) — PoC ticketing for all write actions. Auto-creates and closes tickets around each executor call.
- **`access_requests` table** (`infra/db/init/16_access_requests.sql`) — Self-service access request queue. Supports `pending → approved → rejected` lifecycle managed through the agent.
- **Department access templates** (`ACCESS_TEMPLATES` constant in `services/genai/index.js`) — Pre-defined license + group bundles for 8 departments (service_desk, marketing, finance, hr, it_admin, operations, member, external_contractor).
- **Microsoft Graph client** (`services/genai/graph-client.js`) — Automatically switches between real Graph API (when `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` are set) and a safe mock client for local development.

Current implementation reference:
- GenAI service: `services/genai/index.js`
- Graph client: `services/genai/graph-client.js`
- Agent tickets DB init: `infra/db/init/15_agent_tickets.sql`
- Access requests DB init: `infra/db/init/16_access_requests.sql`
- UI: `services/app/src/public/index.html`

---

## 2. Remaining Work

### 2.1 ServiceNow / Jira Ticket Integration

**File:** `services/genai/index.js` — `createAndCloseTicket()` function and all executor callers

The `agent_tickets` Postgres table is a local stand-in for an ITSM system. In production, ticket creation and closure should route to ServiceNow or Jira instead. The same applies to `access_requests` — currently a Postgres table, production should route approvals through the ITSM approval workflow.

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
| 6 | Route `access_requests` approval flow (`approve_access_request` tool) through ITSM approval workflow |
| 7 | Keep `agent_tickets` and `access_requests` tables as audit log (write-only mirror) or remove if ITSM provides full audit trail |

---

### 2.2 SAML-Gated Permissions

**Files:** `services/genai/index.js`, `services/app/src/`

Currently the only auth guard is an API key (`x-api-key` header). Role-based access control must be enforced so that only authorised roles can invoke destructive agent actions.

**Role mapping** (from `docs/next-steps/saml-access-management.md`):

| Role | Permitted agent actions |
|---|---|
| `viewer` | None — no agent access |
| `analyst` | `list_open_tickets`, `list_access_requests`, `describe_capabilities` |
| `operator` | All non-destructive tools; excludes `provision_account`, `disable_account`, `reset_password`, `update_attribute`, `offboard_user`, `deprovision_cascade`, `dismiss_risky_user`, `revoke_app_consent`, `revoke_guest_access`, `get_bitlocker_key` |
| `admin` | All 37 tools |

**Implementation steps:**

| Step | Task |
|---|---|
| 1 | Complete SAML SSO integration (see `docs/next-steps/saml-access-management.md`) — this is a prerequisite |
| 2 | Decode the SAML assertion server-side and attach `req.user.role` in middleware |
| 3 | In `POST /api/agent`, after the API key guard, read `req.user.role` and compare the resolved `fnName` against a per-role allowlist |
| 4 | Return `HTTP 403` with `{ error: 'Insufficient permissions for action: <tool>' }` if the role is not authorised |
| 5 | Add `performed_by` email to `agent_tickets` and `access_requests` tables for full audit trail |
| 6 | Expose the user's role to the UI so action buttons and the prompt placeholder adapt accordingly |

**Permitted tools per role (server-side allowlist):**
```js
const ROLE_TOOL_ALLOWLIST = {
  viewer:   [],
  analyst:  ['list_open_tickets', 'list_access_requests', 'describe_capabilities',
             'list_inactive_licenses', 'list_stale_guests', 'list_app_consents',
             'get_device_compliance', 'get_mfa_status', 'get_out_of_office',
             'explain_ca_block', 'list_access_templates'],
  operator: [
    // Account (non-destructive)
    'provision_account', 'reset_password', 'update_attribute',
    'add_to_group', 'add_to_m365_group',
    // M365 service desk
    'reset_mfa', 'assign_license', 'remove_license', 'grant_mailbox_access',
    'add_email_alias', 'set_out_of_office', 'add_to_teams_channel', 'grant_onedrive_access',
    // Lifecycle (non-destructive)
    'onboard_user', 'apply_access_template', 'bulk_action',
    // Access requests
    'submit_access_request', 'approve_access_request',
    // Ticketing/info
    'create_ticket', 'list_open_tickets', 'list_access_requests', 'describe_capabilities',
    // Governance (read-only)
    'list_inactive_licenses', 'list_stale_guests', 'list_app_consents',
    'get_device_compliance', 'get_mfa_status', 'get_out_of_office', 'explain_ca_block',
    'list_access_templates',
  ],
  admin:    null, // null = unrestricted
};
```

---

## 5. Security Considerations for Remaining Work

| Item | Concern | Mitigation |
|---|---|---|
| ITSM integration | API key leakage, SSRF | Store ITSM credentials in environment variables only; validate `ITSM_BASE_URL` against a domain allowlist |
| SAML permissions | Privilege escalation via crafted prompts | Enforce tool allowlist server-side, never trust client-supplied role claims |
| Graph API credentials | Client secret exposure, over-permissioned app | Store in Secrets Manager / managed identity; grant only permissions needed for deployed tools; rotate secrets |
| Governance tool abuse | `revoke_app_consent`, `dismiss_risky_user`, `get_bitlocker_key`, `offboard_user` are high-risk | Gate all destructive governance/lifecycle tools behind `admin` role in `ROLE_TOOL_ALLOWLIST`; log every invocation with user identity |
| BitLocker key access | Key retrieval is sensitive; must be auditable | Always create a ticket (even for read operations) so there is a ServiceNow audit record; restrict to `admin` role |
| Bulk operations | `bulk_action` with `disable_account` can offboard many users in one call | Gate behind `admin` role; add dry-run preview step before execution |
| Access request approvals | `approve_access_request` executes provisioning immediately on approval | Require `operator` or `admin` role; log approver identity in `access_requests.approver_note` |

---

## 6. Success Criteria

- [ ] Agent tickets are created and closed via the ServiceNow API rather than the local `agent_tickets` table
- [ ] Access request approvals (`approve_access_request`) route through the ITSM approval workflow
- [ ] An `operator`-role user can invoke provisioning tools; a `viewer`-role user receives `HTTP 403`
- [ ] All governance tools (`dismiss_risky_user`, `get_bitlocker_key`, `revoke_app_consent`) are restricted to `admin` role and generate a ServiceNow audit ticket regardless of outcome
- [ ] Bulk operations (`bulk_action` with destructive actions) require `admin` role and a dry-run preview before execution

---

## 7. Former Member-Benefits Work

The former member-benefits experience and its dedicated claims ETL workflow were removed from this repository as part of the current user-search focus. Any related work now lives in the `document-search` repository, where that product-specific implementation continues.
