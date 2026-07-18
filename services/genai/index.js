'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const { Pool }  = require('pg');

const app     = express();
const PORT    = parseInt(process.env.PORT || '3001', 10);
const API_KEY = process.env.API_KEY || '';

app.use(express.json());

// ── Auth guard ────────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorised' });
});

// ── Rate limiter ─────────────────────────────────────────────────────────────
// Scoped to /api/agent only — each request triggers one or two Ollama LLM
// calls plus DB queries. Limits to 10 requests per IP per 60-second window.
app.use('/api/agent', rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait before sending another prompt.' },
}));

// ── Postgres ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@postgres:5432/appdb',
});

// ── Ollama config ─────────────────────────────────────────────────────────────
const OLLAMA_URL   = process.env.OLLAMA_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

// ── Stored-procedure SQL calls ────────────────────────────────────────────────
const SP_SAVE_CHAT        = 'CALL sp_save_chat_message($1, $2, $3)';

// ── Agent: tool definitions ───────────────────────────────────────────────────
// These are passed to the LLM via Ollama's tool-calling interface so it can
// decide which action to take in response to a user-card prompt.
// Action tools create a ticket, execute the action, and auto-close the ticket.

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'provision_account',
      description:
        'Provision (create) an account for the user in a target system they are currently missing from. ' +
        'Use when the user asks to create/provision an account in Active Directory, NetForum, or External Users.',
      parameters: {
        type: 'object',
        properties: {
          target_system: {
            type: 'string',
            enum: ['active_directory', 'netforum_members', 'external_users'],
            description: 'The system to provision the account in',
          },
          first_name:  { type: 'string', description: 'User first name' },
          last_name:   { type: 'string', description: 'User last name' },
          email:       { type: 'string', description: 'User email address' },
          type:        { type: 'string', description: 'Account type (e.g. "employee", "member", "contractor"). Default depends on system.' },
        },
        required: ['target_system', 'first_name', 'last_name', 'email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'disable_account',
      description:
        'Disable a user account across all systems they exist in. ' +
        'Use when the user asks to disable, deactivate, or offboard someone.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for disabling (e.g. "User has left the organisation")' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reset_password',
      description:
        'Reset the password for a user in Active Directory. ' +
        'Use when the user asks for a password reset.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_attribute',
      description:
        'Update a specific attribute/field for the user in a target system. ' +
        'Use when the user asks to change an email, sponsor, type, or other field.',
      parameters: {
        type: 'object',
        properties: {
          target_system: {
            type: 'string',
            enum: ['active_directory', 'netforum_members', 'external_users'],
            description: 'The system to update the attribute in',
          },
          field: {
            type: 'string',
            enum: ['email', 'first_name', 'last_name', 'type', 'sponsor'],
            description: 'The field to update',
          },
          new_value: { type: 'string', description: 'The new value for the field' },
        },
        required: ['target_system', 'field', 'new_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_to_group',
      description:
        'Add the user to a distribution group (mailing list). ' +
        'Use when the user asks to add someone to a mailing list or distribution group. ' +
        'NOT for M365/Microsoft 365/Security groups — use add_to_m365_group for those.',
      parameters: {
        type: 'object',
        properties: {
          group_name: { type: 'string', description: 'Name (or partial name) of the distribution group to add the user to' },
        },
        required: ['group_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_to_m365_group',
      description:
        'Add the user to a Microsoft 365 group (M365, Security, or Teams group). ' +
        'Use when the user asks to add someone to an M365 group, security group, or Teams group.',
      parameters: {
        type: 'object',
        properties: {
          group_name: { type: 'string', description: 'Name (or partial name) of the M365 group to add the user to' },
          role:       { type: 'string', enum: ['member', 'owner'], description: 'Role in the group. Defaults to member.' },
        },
        required: ['group_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_ticket',
      description:
        'Create a general service ticket when no specific action tool applies. ' +
        'Only use this as a fallback for requests that cannot be handled by provision_account, ' +
        'disable_account, reset_password, update_attribute, or add_to_group.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Short title for the ticket' },
          description: { type: 'string', description: 'Detailed description of what needs to happen' },
        },
        required: ['title', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_open_tickets',
      description: 'List all currently open tickets for the displayed user.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_capabilities',
      description:
        'Describe what actions the agent can perform. Use when the user asks ' +
        '"what can you do?" or "what actions are available?"',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

// ── Agent: action executors ───────────────────────────────────────────────────
// Each executor: creates a ticket → performs the DB action → auto-closes the
// ticket on success. Returns { ticket, actionResult } for the LLM to summarise.

async function createAndCloseTicket(pool, email, title, description, sessionId, actionFn) {
  // 1. Create the ticket
  const { rows: [ticket] } = await pool.query(
    `INSERT INTO agent_tickets (email, title, description, session_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [email, title, description, sessionId || null]
  );

  // 2. Execute the action
  let actionResult;
  try {
    actionResult = await actionFn();
  } catch (err) {
    // Action failed — leave ticket open with error note
    await pool.query(
      `UPDATE agent_tickets SET description = description || $1, updated_at = now() WHERE id = $2`,
      [`\n\n⚠️ Action failed: ${err.message}`, ticket.id]
    );
    return {
      ticket,
      actionResult: { success: false, error: err.message },
    };
  }

  // 3. Auto-close the ticket on success
  const { rows: [closedTicket] } = await pool.query(
    `UPDATE agent_tickets SET status = 'closed', updated_at = now(),
       description = description || $1
     WHERE id = $2 RETURNING *`,
    ['\n\n✅ Action completed automatically by agent.', ticket.id]
  );

  return { ticket: closedTicket, actionResult };
}

// ── Shared constants for executor validation ──────────────────────────────────
const {
  VALID_SYSTEMS,
  SYSTEM_LABELS,
  SAFE_TABLES,
  SAFE_COLUMNS,
  validateTargetSystem,
  escapeLike,
} = require('./validation');

async function executeProvisionAccount(pool, email, fnArgs, sessionId) {
  const { target_system, first_name, last_name, type: acctType } = fnArgs;
  validateTargetSystem(target_system);
  const label = SYSTEM_LABELS[target_system] || target_system;

  const title = `Provision ${label} account for ${first_name} ${last_name}`;
  const description = `Create a new ${label} account for ${first_name} ${last_name} <${email}>.`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    // Check if account already exists
    const safeTable = SAFE_TABLES[target_system];
    const { rows: existing } = await pool.query(
      `SELECT id FROM ${safeTable} WHERE email = $1`,
      [email]
    );
    if (existing.length > 0) {
      throw new Error(`Account already exists in ${label} for ${email}`);
    }

    // Determine defaults per system
    let insertSql, insertParams;
    const defaultType = target_system === 'netforum_members' ? 'member'
                      : target_system === 'external_users'   ? 'contractor'
                      : 'employee';

    if (target_system === 'active_directory') {
      insertSql = `INSERT INTO active_directory (first_name, last_name, email, type, enabled, locked, passwordlastreset, created_at)
                   VALUES ($1, $2, $3, $4, true, false, now(), now()) RETURNING id`;
      insertParams = [first_name, last_name, email, acctType || defaultType];
    } else if (target_system === 'netforum_members') {
      insertSql = `INSERT INTO netforum_members (first_name, last_name, email, type, enabled, last_login, created_at)
                   VALUES ($1, $2, $3, $4, true, null, now()) RETURNING id`;
      insertParams = [first_name, last_name, email, acctType || defaultType];
    } else if (target_system === 'external_users') {
      insertSql = `INSERT INTO external_users (first_name, last_name, email, type, enabled, sponsor, created_at)
                   VALUES ($1, $2, $3, $4, true, null, now()) RETURNING id`;
      insertParams = [first_name, last_name, email, acctType || defaultType];
    } else {
      throw new Error(`Unknown target system: ${target_system}`);
    }

    const { rows: [newRow] } = await pool.query(insertSql, insertParams);
    return { provisioned: true, system: label, recordId: newRow.id };
  });
}

async function executeDisableAccount(pool, email, fnArgs, sessionId, records) {
  const reason = fnArgs.reason || 'No reason provided';
  const title = `Disable account — offboarding`;
  const sources = (records || []).filter(r => r.found).map(r => r.source);
  const description = `Disable all accounts for ${email}. Reason: ${reason}. Active in: ${sources.join(', ') || 'unknown'}.`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    const DISABLE_TABLES = ['active_directory', 'netforum_members', 'external_users'];
    const results = {};

    for (const table of DISABLE_TABLES) {
      const safeTable = SAFE_TABLES[table];
      const { rowCount } = await pool.query(
        `UPDATE ${safeTable} SET enabled = false WHERE email = $1 AND enabled = true`,
        [email]
      );
      if (rowCount > 0) results[table] = 'disabled';
    }

    if (Object.keys(results).length === 0) {
      throw new Error(`No enabled accounts found for ${email}`);
    }

    return { disabled: true, systems: results };
  });
}

async function executeResetPassword(pool, email, sessionId) {
  const title = `Password reset`;
  const description = `Reset password for ${email} in Active Directory.`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    const { rowCount } = await pool.query(
      `UPDATE active_directory SET passwordlastreset = now() WHERE email = $1`,
      [email]
    );
    if (rowCount === 0) {
      throw new Error(`No Active Directory account found for ${email}`);
    }
    return { reset: true, email, timestamp: new Date().toISOString() };
  });
}

async function executeUpdateAttribute(pool, email, fnArgs, sessionId) {
  const { target_system, field, new_value } = fnArgs;
  validateTargetSystem(target_system);
  const label = SYSTEM_LABELS[target_system] || target_system;

  // Validate field against safe quoted-identifier map
  const safeCol = SAFE_COLUMNS[field];
  if (!safeCol) {
    throw new Error(`Field "${field}" is not an updatable attribute.`);
  }
  const safeTable = SAFE_TABLES[target_system];

  const title = `Update ${field} in ${label}`;
  const description = `Update ${field} to "${new_value}" for ${email} in ${label}.`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    const { rowCount } = await pool.query(
      `UPDATE ${safeTable} SET ${safeCol} = $1 WHERE email = $2`,
      [new_value, email]
    );
    if (rowCount === 0) {
      throw new Error(`No ${label} account found for ${email}`);
    }
    return { updated: true, system: label, field, new_value };
  });
}

async function executeAddToGroup(pool, email, fnArgs, sessionId, records) {
  const { group_name } = fnArgs;
  const userRecord = (records || []).find(r => r.firstName && r.email);
  const firstName = userRecord?.firstName || 'Unknown';
  const lastName = userRecord?.lastName || 'Unknown';

  const title = `Add to distribution group — ${group_name}`;
  const description = `Add ${firstName} ${lastName} <${email}> to the "${group_name}" distribution group.`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    // Find the group by name (case-insensitive partial match)
    const { rows: groups } = await pool.query(
      `SELECT id, name, contacts FROM distribution_groups WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
      [`%${escapeLike(group_name)}%`]
    );

    if (groups.length === 0) {
      throw new Error(`Distribution group matching "${group_name}" not found`);
    }

    const group = groups[0];
    const contacts = group.contacts || [];

    // Check if user is already a member
    if (contacts.some(c => c.email?.toLowerCase() === email.toLowerCase())) {
      throw new Error(`${email} is already a member of "${group.name}"`);
    }

    // Add user to the contacts array
    contacts.push({ first_name: firstName, last_name: lastName, email });
    await pool.query(
      `UPDATE distribution_groups SET contacts = $1::jsonb WHERE id = $2`,
      [JSON.stringify(contacts), group.id]
    );

    return { added: true, group: group.name, memberCount: contacts.length };
  });
}

async function executeAddToM365Group(pool, email, fnArgs, sessionId, records) {
  const { group_name, role: requestedRole } = fnArgs;
  const memberRole = requestedRole || 'member';
  const userRecord = (records || []).find(r => r.firstName && r.email);
  const firstName = userRecord?.firstName || 'Unknown';
  const lastName = userRecord?.lastName || 'Unknown';

  // Determine source system from user records
  const sourceMap = { 'Active Directory': 'active_directory', 'NetForum': 'netforum_members', 'External Users': 'external_users' };
  const activeRecord = (records || []).find(r => r.found);
  const source = activeRecord ? (sourceMap[activeRecord.source] || activeRecord.source) : 'unknown';

  const title = `Add to M365 group — ${group_name}`;
  const description = `Add ${firstName} ${lastName} <${email}> to the "${group_name}" M365 group as ${memberRole}.`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    // Find the group by name (case-insensitive partial match)
    const { rows: groups } = await pool.query(
      `SELECT id, group_name, group_email, group_type, users FROM m365_group_memberships WHERE LOWER(group_name) LIKE LOWER($1) LIMIT 1`,
      [`%${escapeLike(group_name)}%`]
    );

    if (groups.length === 0) {
      throw new Error(`M365 group matching "${group_name}" not found`);
    }

    const group = groups[0];
    const users = group.users || [];

    // Check if user is already a member
    if (users.some(u => u.email?.toLowerCase() === email.toLowerCase())) {
      throw new Error(`${email} is already a member of "${group.group_name}"`);
    }

    // Add user to the users JSONB array
    users.push({
      role: memberRole,
      email,
      source,
      joined_at: new Date().toISOString(),
    });

    await pool.query(
      `UPDATE m365_group_memberships SET users = $1::jsonb WHERE id = $2`,
      [JSON.stringify(users), group.id]
    );

    return {
      added: true,
      group: group.group_name,
      groupType: group.group_type,
      role: memberRole,
      memberCount: users.length,
    };
  });
}

// ── Agent: system prompt ──────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are a helpful agent embedded in a user-card panel. You have context about the user's records across multiple systems (Active Directory, NetForum, External Users, Distribution Groups, M365 Groups, etc.).

You can perform real actions on user accounts. When the user asks you to take an action, use the most specific tool available:

- **provision_account**: Create a new account in a system the user is missing from (AD, NetForum, External Users). This supports CROSS-SYSTEM provisioning — e.g. a NetForum-only user can be provisioned into Active Directory, or vice versa. Extract first_name, last_name, and email from the user context.
- **disable_account**: Disable the user across all systems (for offboarding). Provide a reason.
- **reset_password**: Reset the user's Active Directory password.
- **update_attribute**: Change a specific field (email, first_name, last_name, type, sponsor) in a specific system. Determine which system to target from the user context.
- **add_to_group**: Add the user to a distribution group (mailing list) by name.
- **add_to_m365_group**: Add the user to a Microsoft 365 group (M365, Security, or Teams group) by name. Optionally specify the role (member or owner).
- **create_ticket**: Only use this as a fallback for requests that don't fit the above tools.

Each action tool will: create a ticket → execute the action → auto-close the ticket if successful. If the action fails, the ticket stays open for manual follow-up.

CROSS-SYSTEM AWARENESS:
- The user context shows which systems the user exists in and which they are missing from.
- You can provision accounts across systems (e.g. a user who only has a NetForum account can be provisioned into Active Directory).
- You can add any user to a distribution group or M365 group regardless of which system(s) they currently exist in.
- When provisioning cross-system, extract name and email from whichever source record is available.

GROUP TYPES:
- Distribution groups = mailing lists → use add_to_group
- M365 groups (Microsoft365, Security, Teams) → use add_to_m365_group
- If the user just says "group" without specifying the type, ask for clarification.

When the user asks what you can do, use the describe_capabilities tool.
When the user asks about existing tickets, use the list_open_tickets tool.

Never fabricate data. Only reference information present in the user context provided.`;

// ── Conversation history ──────────────────────────────────────────────────────

async function saveMessage(sessionId, role, content) {
  await pool.query(SP_SAVE_CHAT, [sessionId, role, content]);
}

// ── Ollama chat with tool calling (agent) ─────────────────────────────────────

async function chatWithOllamaTools(messages, tools) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      tools,
      stream: false,
      options: {
        temperature: 0.3,
        num_ctx: 4096,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.message || {};
}

// ── Agent: tool dispatcher ───────────────────────────────────────────────────
// Executes a single LLM tool call and returns { toolResultContent, ticket }.
// Extracted so the multi-step agent loop can call it on each iteration.

async function executeToolCall(toolCall, { pool, email, sessionId, records }) {
  const fnName = toolCall.function?.name;
  const fnArgs = toolCall.function?.arguments || {};
  let toolResultContent = '';
  let ticket = null;

  switch (fnName) {
    case 'provision_account': {
      const { ticket: t, actionResult } = await executeProvisionAccount(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.provisioned || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'provision_account',
        ...actionResult,
      });
      break;
    }

    case 'disable_account': {
      const { ticket: t, actionResult } = await executeDisableAccount(pool, email, fnArgs, sessionId, records);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.disabled || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'disable_account',
        ...actionResult,
      });
      break;
    }

    case 'reset_password': {
      const { ticket: t, actionResult } = await executeResetPassword(pool, email, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.reset || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'reset_password',
        ...actionResult,
      });
      break;
    }

    case 'update_attribute': {
      const { ticket: t, actionResult } = await executeUpdateAttribute(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.updated || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'update_attribute',
        ...actionResult,
      });
      break;
    }

    case 'add_to_group': {
      const { ticket: t, actionResult } = await executeAddToGroup(pool, email, fnArgs, sessionId, records);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.added || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'add_to_group',
        ...actionResult,
      });
      break;
    }

    case 'add_to_m365_group': {
      const { ticket: t, actionResult } = await executeAddToM365Group(pool, email, fnArgs, sessionId, records);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.added || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'add_to_m365_group',
        ...actionResult,
      });
      break;
    }

    case 'create_ticket': {
      const { title, description } = fnArgs;
      const result = await pool.query(
        `INSERT INTO agent_tickets (email, title, description, session_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [email, title || 'Untitled ticket', description || '', sessionId || null]
      );
      ticket = result.rows[0];
      toolResultContent = JSON.stringify({
        success: true,
        ticketId: ticket.id,
        ticketStatus: 'open',
        title: ticket.title,
        note: 'This is a general ticket that requires manual action.',
      });
      break;
    }

    case 'list_open_tickets': {
      const { rows: tickets } = await pool.query(
        `SELECT id, title, description, status, created_at
         FROM agent_tickets
         WHERE email = $1 AND status = 'open'
         ORDER BY created_at DESC`,
        [email]
      );
      toolResultContent = JSON.stringify({ tickets });
      break;
    }

    case 'describe_capabilities': {
      toolResultContent = JSON.stringify({
        capabilities: [
          'Provision a new account in Active Directory, NetForum, or External Users — supports cross-system provisioning (e.g. a NetForum user can be provisioned into AD). Action is performed immediately and the ticket is auto-closed.',
          'Disable a user account across all systems (offboarding) — executed immediately.',
          'Reset a password in Active Directory — executed immediately.',
          'Update an attribute (email, name, type, sponsor) in a specific system — executed immediately.',
          'Add a user to a distribution group (mailing list) — executed immediately.',
          'Add a user to a Microsoft 365 group (M365, Security, or Teams group) — executed immediately with a configurable role (member or owner).',
          'Create a general service ticket for anything else (stays open for manual follow-up).',
          'List open tickets for the current user.',
        ],
      });
      break;
    }

    default:
      toolResultContent = JSON.stringify({ error: `Unknown tool: ${fnName}` });
  }

  return { toolResultContent, ticket };
}

// ── POST /api/agent ───────────────────────────────────────────────────────────
// Receives a natural-language prompt together with the user-card context.
// Uses LLM tool-calling to decide which actions to take. The agent loop runs
// up to MAX_TOOL_STEPS iterations, allowing the LLM to chain multiple tool
// calls in a single user turn (e.g. provision across several systems at once).
// Returns { reply, tickets } where tickets is the array of all tickets created.

const MAX_TOOL_STEPS = 5;

app.post('/api/agent', async (req, res) => {
  try {
    const { prompt, userContext, sessionId } = req.body;
    if (!prompt || !userContext) {
      return res.status(400).json({ error: 'prompt and userContext are required.' });
    }

    const { email, records } = userContext;
    if (!email) {
      return res.status(400).json({ error: 'userContext.email is required.' });
    }

    // Build a context block that the LLM can reference
    const contextBlock = (records || []).map(r =>
      `Source: ${r.source} — ${JSON.stringify(r)}`
    ).join('\n');

    const systemContent = AGENT_SYSTEM_PROMPT + '\n\nUser context:\n' + contextBlock;

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user',   content: prompt },
    ];

    // ── Multi-step agent loop ─────────────────────────────────────────────────
    // Each iteration: call LLM → if tool_call, execute it and feed result back.
    // Loop exits when the LLM returns a plain reply or MAX_TOOL_STEPS is reached.

    const tickets = [];
    let replyText = '';
    let steps = 0;

    while (steps < MAX_TOOL_STEPS) {
      const llmResponse = await chatWithOllamaTools(messages, AGENT_TOOLS);
      messages.push(llmResponse);

      if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
        // LLM returned a plain message — done
        replyText = llmResponse.content || 'Done.';
        break;
      }

      const toolCall = llmResponse.tool_calls[0];
      const { toolResultContent, ticket } = await executeToolCall(
        toolCall,
        { pool, email, sessionId, records }
      );

      if (ticket) tickets.push(ticket);
      messages.push({ role: 'tool', content: toolResultContent });
      steps++;
    }

    // If the loop exhausted MAX_TOOL_STEPS without a plain reply, ask the LLM
    // to summarise what was done.
    if (!replyText) {
      const summary = await chatWithOllamaTools(messages, AGENT_TOOLS);
      replyText = summary.content || 'Done.';
    }

    // Persist conversation
    if (sessionId) {
      await saveMessage(sessionId, 'user', prompt);
      await saveMessage(sessionId, 'assistant', replyText);
    }

    return res.json({ reply: replyText, tickets });
  } catch (err) {
    console.error('[agent] error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── GET /api/tickets ──────────────────────────────────────────────────────────
// Returns open tickets for a given user email.

app.get('/api/tickets', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'email query parameter is required.' });
    }

    const { rows: tickets } = await pool.query(
      `SELECT id, email, title, description, status, created_at, updated_at
       FROM agent_tickets
       WHERE email = $1 AND status = 'open'
       ORDER BY created_at DESC`,
      [email]
    );

    res.json({ tickets });
  } catch (err) {
    console.error('[tickets] error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── PATCH /api/tickets/:id ────────────────────────────────────────────────────
// Close (or update status of) a ticket.

app.patch('/api/tickets/:id', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const { status, email } = req.body || {};
    if (!status || !['open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'status must be "open" or "closed".' });
    }
    if (!email) {
      return res.status(400).json({ error: 'email is required for ownership verification.' });
    }

    const { rows } = await pool.query(
      `UPDATE agent_tickets
       SET status = $1, updated_at = now()
       WHERE id = $2 AND email = $3
       RETURNING id, email, title, description, status, created_at, updated_at`,
      [status, ticketId, email]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found or not owned by this user.' });
    }

    res.json({ ticket: rows[0] });
  } catch (err) {
    console.error('[tickets:patch] error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', model: OLLAMA_MODEL });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GenAI service listening on :${PORT}`);
  console.log(`  Ollama URL:   ${OLLAMA_URL}`);
  console.log(`  Ollama Model: ${OLLAMA_MODEL}`);
});
