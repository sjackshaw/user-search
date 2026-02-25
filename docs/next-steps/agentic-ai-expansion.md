# Next Steps: Agentic AI for Distribution Group Management

**Date:** February 25, 2026

---

## 1. Objective

Extend the existing GenAI conversational assistant into an **agentic AI** capable of executing basic administrative actions — starting with adding and removing users from distribution groups. Today the assistant is read-only: it retrieves context from Postgres and answers questions. The agentic layer will allow it to **take actions** on behalf of authenticated users via natural-language instructions.

---

## 2. Current State

| Component | Status |
|---|---|
| GenAI chat service (`services/genai`) | Operational — intent classification, context retrieval, Ollama LLM |
| Distribution groups table | `distribution_groups` with `contacts` JSONB column (array of `{first_name, last_name, email}`) |
| Sync logs table | `distribution_group_sync_logs` tracking `accounts_added` / `accounts_removed` per sync event |
| ETL pipeline (`etl-dg-line`) | Reads `data/primary.json`, upserts groups, logs changes to `source_change_logs` |
| Change detection | Field-level diffs recorded for `name`, `alias`, and `contacts` (serialised JSON) |

The GenAI service already has intents for `group_lookup` and `user_lookup`, and can query group membership and user records. It cannot, however, modify any data.

---

## 3. Target Capabilities

### 3.1 Phase 1 — Single-Action Agent

The assistant can execute **one action per turn** when the user issues a clear instruction:

| Action | Example Prompt | Effect |
|---|---|---|
| Add user to group | *"Add jane.doe@corp.com to the Marketing group"* | Appends contact to `distribution_groups.contacts` JSONB |
| Remove user from group | *"Remove john.smith@corp.com from Executives"* | Removes contact from `distribution_groups.contacts` JSONB |
| List group members | *"Who is in the Finance distribution group?"* | Read-only (already supported) |

### 3.2 Phase 2 — Multi-Step Agent

The assistant can chain actions and resolve ambiguity:

- *"Move jane.doe from Marketing to Sales"* → remove from one group, add to another
- *"Add all members of the Finance group to the Quarterly-Review group"* → query members, then batch-add
- *"Remove everyone whose account is disabled from all distribution groups"* → cross-reference `active_directory.enabled = false` against group membership

---

## 4. Architecture

### 4.1 Tool Registry

Introduce a **tool registry** in the GenAI service — a set of named functions the LLM can invoke. Each tool has:

- **Name** — unique identifier (e.g. `add_user_to_group`)
- **Description** — natural-language description for the LLM system prompt
- **Parameters** — JSON schema defining required inputs
- **Handler** — async function that executes the action and returns a result

```
┌─────────────────────────────────────────────────────┐
│                   GenAI Service                      │
│                                                      │
│  ┌──────────────┐    ┌─────────────────────────┐    │
│  │ Intent        │───▶│ Tool Selector            │    │
│  │ Classifier    │    │ (LLM function-calling)   │    │
│  └──────────────┘    └──────────┬──────────────┘    │
│                                  │                    │
│         ┌────────────────────────┼──────────────┐    │
│         ▼                        ▼              ▼    │
│  ┌─────────────┐  ┌───────────────┐  ┌───────────┐  │
│  │ add_user_to │  │ remove_user_  │  │ list_group │  │
│  │ _group      │  │ from_group    │  │ _members   │  │
│  └──────┬──────┘  └──────┬────────┘  └─────┬─────┘  │
│         │                │                  │        │
│         ▼                ▼                  ▼        │
│  ┌──────────────────────────────────────────────┐    │
│  │              Postgres (pg.Pool)               │    │
│  │  distribution_groups · source_change_logs     │    │
│  │  distribution_group_sync_logs                 │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### 4.2 Tool Definitions

```js
const TOOLS = [
  {
    name: 'add_user_to_group',
    description: 'Add a user (by email) to a distribution group (by name or alias).',
    parameters: {
      type: 'object',
      properties: {
        user_email:  { type: 'string', description: 'Email address of the user to add' },
        group_name:  { type: 'string', description: 'Name or alias of the distribution group' },
      },
      required: ['user_email', 'group_name'],
    },
  },
  {
    name: 'remove_user_from_group',
    description: 'Remove a user (by email) from a distribution group (by name or alias).',
    parameters: {
      type: 'object',
      properties: {
        user_email:  { type: 'string', description: 'Email address of the user to remove' },
        group_name:  { type: 'string', description: 'Name or alias of the distribution group' },
      },
      required: ['user_email', 'group_name'],
    },
  },
];
```

### 4.3 Execution Flow

1. User sends a message via `POST /api/chat`
2. Intent classifier detects an **action intent** (new intents: `group_add`, `group_remove`)
3. The LLM receives the tool definitions in the system prompt and the user message
4. The LLM responds with a **tool call** (structured JSON specifying tool name + arguments)
5. The GenAI service validates the tool call, extracts parameters, and invokes the handler
6. The handler:
   - Validates the user exists (query `active_directory`, `netforum_members`, or `external_users`)
   - Validates the group exists (query `distribution_groups`)
   - Executes the JSONB mutation (see SQL below)
   - Logs the change to `source_change_logs` and `distribution_group_sync_logs`
   - Returns a success/failure result
7. The result is fed back to the LLM as a tool response
8. The LLM generates a human-readable confirmation message
9. Both messages are persisted to `chat_messages`

### 4.4 Confirmation Step

All write actions require a **confirmation loop** before execution:

1. LLM proposes the action: *"I'll add Jane Doe (jane.doe@corp.com) to the Marketing group. Confirm?"*
2. User responds *"yes"* / *"no"*
3. Only on confirmation does the tool handler execute

This is implemented by storing a `pending_action` object in the conversation state (a new `pending_actions` column on `chat_messages` or a transient in-memory map keyed by `sessionId`).

---

## 5. Database Changes

### 5.1 New Stored Procedures

```sql
-- Add a contact to a distribution group's JSONB contacts array
CREATE OR REPLACE FUNCTION sp_group_add_member(
  p_group_alias   TEXT,
  p_first_name    TEXT,
  p_last_name     TEXT,
  p_member_email  TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_group_id INTEGER;
BEGIN
  SELECT id INTO v_group_id
  FROM distribution_groups
  WHERE alias = p_group_alias
    AND NOT contacts @> jsonb_build_array(
          jsonb_build_object('email', p_member_email));

  IF NOT FOUND THEN
    RETURN FALSE;  -- group not found or user already a member
  END IF;

  UPDATE distribution_groups
  SET contacts = contacts || jsonb_build_array(
        jsonb_build_object(
          'first_name', p_first_name,
          'last_name',  p_last_name,
          'email',      p_member_email
        ))
  WHERE id = v_group_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Remove a contact from a distribution group's JSONB contacts array
CREATE OR REPLACE FUNCTION sp_group_remove_member(
  p_group_alias  TEXT,
  p_member_email TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_group_id INTEGER;
  v_idx      INTEGER;
BEGIN
  SELECT id INTO v_group_id FROM distribution_groups WHERE alias = p_group_alias;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Find the index of the member in the JSONB array
  SELECT ordinality - 1 INTO v_idx
  FROM distribution_groups,
       jsonb_array_elements(contacts) WITH ORDINALITY AS elem
  WHERE id = v_group_id AND elem.value ->> 'email' = p_member_email;

  IF v_idx IS NULL THEN RETURN FALSE; END IF;

  UPDATE distribution_groups
  SET contacts = contacts - v_idx
  WHERE id = v_group_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
```

### 5.2 Audit Logging

Every tool execution writes to **both** logging tables:

| Table | What is logged |
|---|---|
| `source_change_logs` | `change_type = 'updated'`, `field_name = 'contacts'`, old/new serialised JSONB |
| `distribution_group_sync_logs` | `accounts_added` or `accounts_removed` array, timestamped |

This ensures the existing change-history queries and UI continue to surface agent-made changes alongside ETL-detected changes.

---

## 6. New Intent Classification Rules

Extend the regex-based classifier in `classifyIntent()`:

```js
// Group modification — add
if (/\b(add|include|put|assign)\b.+\b(to|into)\b.+\b(group|distribution|list)\b/i.test(m)) {
  const emailMatch = message.match(EMAIL_RE);
  return { intent: 'group_add', email: emailMatch?.[0]?.toLowerCase() || null };
}

// Group modification — remove
if (/\b(remove|delete|drop|take\s+out)\b.+\b(from)\b.+\b(group|distribution|list)\b/i.test(m)) {
  const emailMatch = message.match(EMAIL_RE);
  return { intent: 'group_remove', email: emailMatch?.[0]?.toLowerCase() || null };
}
```

---

## 7. System Prompt Additions

Append to the existing `SYSTEM_PROMPT`:

```
You can also perform actions when the user asks:
- **Add a user to a distribution group**: Use the add_user_to_group tool.
- **Remove a user from a distribution group**: Use the remove_user_from_group tool.

Before executing any write action, ALWAYS confirm with the user first. State exactly what you will do (user email, group name, action) and wait for explicit confirmation.

If the user or group cannot be found, say so and ask for clarification.
```

---

## 8. Implementation Plan

### Phase 1 — Foundation (Estimated: 2–3 days)

| Step | Task |
|---|---|
| 1 | Create `sp_group_add_member` and `sp_group_remove_member` stored procedures |
| 2 | Add `group_add` and `group_remove` intents to the classifier |
| 3 | Implement tool registry pattern in `services/genai/index.js` |
| 4 | Implement `add_user_to_group` and `remove_user_from_group` tool handlers |
| 5 | Add confirmation loop logic (pending action state per session) |
| 6 | Update system prompt with tool descriptions |
| 7 | Add audit logging (source_change_logs + distribution_group_sync_logs) |

### Phase 2 — Multi-Step & Hardening (Estimated: 2–3 days)

| Step | Task |
|---|---|
| 8 | Support chained actions (move user between groups) |
| 9 | Support batch operations (add multiple users) |
| 10 | Add rate limiting per session (max N write actions per minute) |
| 11 | Add rollback capability (undo last action within a time window) |
| 12 | Integration tests covering add, remove, confirm, deny, and error paths |

### Phase 3 — Expanded Actions (Future)

| Action | Description |
|---|---|
| Create distribution group | Create a new group with an initial set of members |
| Enable/disable user account | Toggle `enabled` flag on `active_directory` records |
| Reassign sponsor | Update the `sponsor` field on `external_users` |

---

## 9. Security Considerations

| Concern | Mitigation |
|---|---|
| Unauthorised modifications | All write actions gated behind confirmation loop; future SAML integration will enforce role-based access (see SAML access management plan) |
| Prompt injection | Tool calls are validated against the tool schema before execution; the LLM cannot invoke arbitrary SQL |
| Audit trail | Every mutation is logged to `source_change_logs` and `distribution_group_sync_logs` with timestamps and the originating `session_id` |
| Rate limiting | Per-session write limits prevent runaway agent loops |
| Data integrity | JSONB mutations are wrapped in transactions; duplicate-add prevention built into `sp_group_add_member` |

---

## 10. Success Criteria

- [ ] User can add a member to a distribution group via natural-language chat
- [ ] User can remove a member from a distribution group via natural-language chat
- [ ] All mutations require explicit user confirmation before execution
- [ ] All mutations are recorded in `source_change_logs` and `distribution_group_sync_logs`
- [ ] Existing read-only queries (`group_lookup`, `change_history`) continue to function
- [ ] Changes made by the agent are visible in the UI change history panel
- [ ] Next ETL run does not revert agent-made changes (ETL upsert respects current state)
