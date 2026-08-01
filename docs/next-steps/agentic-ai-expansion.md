# Agentic AI — User Card Agent: Production Hardening

**Date:** June 16, 2026
**Status:** 🔧 Phase 6 — Production Path (in progress)

---

## 1. Context

Phases 1–5 are complete. The agent is operational with 28 tools across account operations, Microsoft 365 service desk workflows, and governance checks. The items below are the **remaining work** required to move the agent toward a production-ready state.

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
- [ ] All governance tools (`dismiss_risky_user`, `get_bitlocker_key`, `revoke_app_consent`) are restricted to `admin` role and generate a ServiceNow audit ticket regardless of outcome

---

## 7. Member Benefits Bot (moved)

The Member Benefits Bot (`services/member-benefits-app`) and its supporting claims ETL line (`etl-claims-line`, `claims`/`claims_logs` schema) have moved to the `document-search` repository, which pairs more closely with that work. See that repository's docs for the current design, remaining production steps, and security considerations.
