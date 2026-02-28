# Agentic AI — User Card Agent

**Date:** February 26, 2026
**Status:** ✅ Implemented (Phases 1–5 complete)

---

## 1. Objective

Embed an **agentic AI assistant directly into the user-card detail panel**. When a user opens a record (e.g. a person who exists in Active Directory but not in NetForum), they can issue natural-language requests — such as provisioning an account, updating attributes, or adding to groups — without leaving the card. The agent executes **real actions** against the database via LLM tool-calling. Each action creates a service ticket, executes the operation, and auto-closes the ticket on success. Open tickets for the displayed user are listed below the prompt in real time.

---

## 2. Current State — Implemented

| Component | Status |
|---|---|
| User card detail panel | `index.html` overlay — reads from `/api/lookup`, renders per-source sections (AD, NetForum, External Users, DG, M365, activity logs, SP permissions) |
| GenAI agent service (`services/genai`) | Operational — LLM tool-calling via Ollama, 9 tools, 6 action executors, cross-system provisioning, M365 group support |
| Database | Postgres with tables for `active_directory`, `netforum_members`, `external_users`, `distribution_groups`, `m365_group_memberships`, `agent_tickets`, and associated log tables |
| Agent UI | Embedded in user-card panel with prompt input, message thread, spinner, tickets list, close button, auto-refresh |
| Card auto-refresh | User card data refreshes automatically after agent actions to show updated state |

---

## 3. Implemented Experience

### 3.1 User Card with Embedded Agent

```
┌──────────────────────────────────────────────────────┐
│  All records for jane.doe@corp.com            ✕      │
│                                                      │
│  ┌─ ACTIVE DIRECTORY ─────────────────────────────┐  │
│  │  First Name: Jane    Last Name: Doe            │  │
│  │  Email: jane.doe@corp.com   Enabled: Yes       │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ NETFORUM ─────────────────────────────────────┐  │
│  │  No record found                               │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ╔═══════════════════════════════════════════════════╗│
│  ║  🤖 User Card Agent                              ║│
│  ║                                                   ║│
│  ║  > "Provision a NetForum account for this user"   ║│
│  ║                                                   ║│
│  ║  Agent: Done — provisioned jane.doe@corp.com in   ║│
│  ║  NetForum. Ticket #12 auto-closed.                ║│
│  ╚═══════════════════════════════════════════════════╝│
│                                                      │
│  ── Open Tickets ────────────────────────────────────│
│  (none — auto-closed on success)                     │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 3.2 Supported Actions

| Prompt | Agent Action | Tool |
|---|---|---|
| *"Provision a NetForum account for this user"* | Creates account in target system, auto-closes ticket | `provision_account` |
| *"Disable this account — the user has left"* | Disables across all systems, auto-closes ticket | `disable_account` |
| *"Reset this user's password"* | Resets AD password, auto-closes ticket | `reset_password` |
| *"Change this user's sponsor to M. Chen"* | Updates field in target system, auto-closes ticket | `update_attribute` |
| *"Add this user to the Marketing distribution group"* | Adds to DG with duplicate check, auto-closes ticket | `add_to_group` |
| *"Add to the Engineering M365 group as owner"* | Adds to M365 group with role, auto-closes ticket | `add_to_m365_group` |
| *"Provision this NetForum user into AD"* | Cross-system provisioning, auto-closes ticket | `provision_account` |
| *"Open a ticket to investigate login issues"* | Creates general ticket (stays open for manual follow-up) | `create_ticket` |
| *"What actions can I take?"* | Lists capabilities | `describe_capabilities` |

---

## 4. Architecture

### 4.1 Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      User Card (UI)                          │
│                                                              │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │ Record Sections      │  │ Agent Prompt + Messages       │  │
│  │ (AD, NF, EU, DG,    │  │  ┌──────────────────────┐    │  │
│  │  M365, Logs)         │  │  │ Text input + Send     │    │  │
│  │                      │  │  └──────────┬───────────┘    │  │
│  └─────────────────────┘  └─────────────┼────────────────┘  │
│                                          │                    │
│  ┌───────────────────────────────────────┼───────────────┐   │
│  │ Open Tickets List (auto-refreshed)    │  [Close ✕]    │   │
│  └───────────────────────────────────────┼───────────────┘   │
└──────────────────────────────────────────┼───────────────────┘
                                           │
                    POST /api/agent        │   GET /api/tickets?email=…
                    PATCH /api/tickets/:id │
                                           ▼
┌──────────────────────────────────────────────────────────────┐
│                     GenAI Service (port 3001)                │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  LLM Tool Selector (Ollama tool-calling)              │   │
│  └──────────┬───────────────────────────────────────────┘   │
│             │                                                │
│   ┌─────────┼──────────────────────────────────────────┐    │
│   ▼         ▼         ▼          ▼         ▼           ▼    │
│ provision disable  reset_pw  update_attr add_to_group  ...  │
│ _account  _account           _ibute                          │
│   │         │         │          │         │           │    │
│   ▼         ▼         ▼          ▼         ▼           ▼    │
│  ┌──────────────────────────────────────────────────┐        │
│  │  createAndCloseTicket() → execute → auto-close   │        │
│  └──────────────────────────────────────────────────┘        │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────────────────────────────────────────┐        │
│  │              Postgres (pg.Pool)                   │        │
│  │  agent_tickets · chat_messages · user tables      │        │
│  └──────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/agent` | Send a natural-language prompt with user-card context; LLM selects a tool, executes the action, returns reply + ticket |
| `GET` | `/api/tickets?email=<email>` | Retrieve open tickets for a given user |
| `PATCH` | `/api/tickets/:id` | Close (or reopen) a ticket — requires email for ownership verification |

### 4.3 Tool Definitions (9 tools)

| Tool | Type | Description |
|---|---|---|
| `provision_account` | Action | Create account in AD, NetForum, or External Users (supports cross-system) |
| `disable_account` | Action | Disable user across all systems (offboarding) |
| `reset_password` | Action | Reset Active Directory password |
| `update_attribute` | Action | Update a whitelisted field in a specific system |
| `add_to_group` | Action | Add user to a distribution group (mailing list) |
| `add_to_m365_group` | Action | Add user to an M365/Security/Teams group with role |
| `create_ticket` | Fallback | Create a general ticket for manual follow-up |
| `list_open_tickets` | Query | List open tickets for the current user |
| `describe_capabilities` | Query | Describe available actions |

### 4.4 Execution Flow

1. User opens a user card and types a request into the agent prompt
2. The UI sends `POST /api/agent` with the prompt, full user-card context (all source records), and persistent session ID
3. The GenAI service builds a system prompt that includes the user-card context, tool definitions, cross-system awareness rules, and group type guidance
4. The LLM responds with a **tool call** (e.g. `provision_account` with arguments)
5. The handler calls `createAndCloseTicket()` which: creates a ticket → executes the action → auto-closes the ticket on success
6. The tool result is fed back to the LLM for a human-readable confirmation
7. The UI displays the reply, refreshes the tickets list, and re-fetches the user card data (card glows blue on refresh)

---

## 5. Database

### 5.1 Agent Tickets Table

```sql
CREATE TABLE IF NOT EXISTS agent_tickets (
  id           SERIAL       PRIMARY KEY,
  email        TEXT         NOT NULL,
  title        TEXT         NOT NULL,
  description  TEXT         NOT NULL,
  status       TEXT         NOT NULL DEFAULT 'open',
  session_id   UUID,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

Init script: `infra/db/init/15_agent_tickets.sql`

---

## 6. Implementation Status

### Phase 1 — Database & API ✅ Complete

| Step | Task | Status |
|---|---|---|
| 1 | Create `infra/db/init/15_agent_tickets.sql` | ✅ |
| 2 | Add `POST /api/agent` route with tool-calling logic | ✅ |
| 3 | Add `GET /api/tickets?email=` route | ✅ |
| 4 | Define `AGENT_TOOLS` and `AGENT_SYSTEM_PROMPT` | ✅ |

### Phase 2 — UI Integration ✅ Complete

| Step | Task | Status |
|---|---|---|
| 5 | Add agent prompt + tickets section to detail panel | ✅ |
| 6 | Implement `sendAgentPrompt()` and `refreshTickets()` | ✅ |
| 7 | Style agent section (purple accent, message bubbles) | ✅ |
| 8 | Auto-load tickets on card open | ✅ |

### Phase 3 — Polish & Hardening ✅ Complete

| Step | Task | Status |
|---|---|---|
| 9 | Loading spinner and error handling | ✅ |
| 10 | Close tickets from UI (`PATCH /api/tickets/:id`) | ✅ |
| 11 | Persistent agent chat sessions per user | ✅ |
| 12 | Tested across AD-only, NetForum-only, multi-source users | ✅ |

### Phase 4 — Action-Capable Agent ✅ Complete

| Step | Task | Status |
|---|---|---|
| 13 | Replace generic `create_ticket` with 6 action tools | ✅ |
| 14 | `createAndCloseTicket()` helper (create → execute → auto-close) | ✅ |
| 15 | Duplicate-entry guards in all executors | ✅ |
| 16 | Error cases leave tickets open for manual follow-up | ✅ |

### Phase 5 — Cross-System & M365 ✅ Complete

| Step | Task | Status |
|---|---|---|
| 17 | Cross-system provisioning (e.g. NF → AD) | ✅ |
| 18 | `add_to_m365_group` tool with role support | ✅ |
| 19 | System prompt: CROSS-SYSTEM AWARENESS + GROUP TYPES sections | ✅ |
| 20 | Card auto-refresh after agent actions (blue flash animation) | ✅ |
| 21 | `renderMarkdown()` for agent message formatting | ✅ |

### Phase 6 — Production Path (Future)

| Step | Description |
|---|---|
| Replace `agent_tickets` with ServiceNow / Jira API integration | Swap the Postgres insert for an API call; keep the same tool interface |
| Add SAML-gated permissions | Only authorised roles can create certain ticket types (see SAML access management plan) |
| Multi-step agent | Chain lookups and actions (e.g. "Provision this user in all missing systems") |
| Rate limiting | Add per-session rate limiter on `POST /api/agent` |

---

## 7. Security Considerations

| Concern | Mitigation |
|---|---|
| SQL injection via LLM tool arguments | `target_system` validated against server-side allowlist (`VALID_SYSTEMS`); `field` validated against `ALLOWED_FIELDS`; all user values parameterised |
| Unauthorised ticket creation | API key guard on all `/api` routes; future SAML integration will enforce role-based access |
| Prompt injection | Tool calls are validated against the tool schema; system prompt does not accept override instructions |
| Data leakage | Agent only sees data already visible on the user card; no additional access granted |
| Audit trail | Every ticket records `session_id` and timestamps; tickets are append-only (no deletes) |
| Ticket ownership | `PATCH /api/tickets/:id` requires email for ownership verification |
| LIKE wildcards | Group name search escapes `%` and `_` metacharacters |
| XSS in agent messages | `renderMarkdown()` runs `esc()` first (HTML entity encoding), then applies restricted regex for markdown formatting |

See [findings4.md](../security/findings4.md) for the full agent security review.

---

## 8. Success Criteria

- [x] User card detail panel shows an embedded agent prompt at the bottom
- [x] User can type a natural-language request and receive an agent response
- [x] Agent executes real actions (provision, disable, reset, update, add to group) with auto-closing tickets
- [x] Open tickets for the displayed user are listed below the prompt and refresh automatically
- [x] Agent correctly identifies data gaps and cross-system opportunities
- [x] Existing user card functionality (record display, activity logs, change history) is unaffected
- [x] Tickets persist across page reloads and are visible when the same user card is reopened
- [x] Card data refreshes automatically after agent actions to show updated state
- [x] M365 group support with role assignment (member/owner)
- [x] Cross-system provisioning (e.g. NetForum user → Active Directory)
