'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const { Pool }  = require('pg');
const graphClient = require('./graph-client');

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
      name: 'reset_mfa',
      description:
        'Reset the displayed user\'s Microsoft 365 MFA registration so they can re-register. ' +
        'Use when the user asks to reset, clear, or re-register MFA/authenticator methods.',
      parameters: {
        type: 'object',
        properties: {
          method_id: { type: 'string', description: 'Optional Microsoft Graph authentication method ID. If omitted, all resettable methods are targeted.' },
          reason: { type: 'string', description: 'Reason for the MFA reset.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mfa_status',
      description:
        'Check whether the displayed user has Microsoft 365 MFA/authentication methods registered. ' +
        'Use when the user asks whether MFA is enabled or what MFA methods exist.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_license',
      description:
        'Assign a Microsoft 365 license to the displayed user. Use when the user asks to assign E3, E5, Visio, Project, or another license.',
      parameters: {
        type: 'object',
        properties: {
          license_sku: { type: 'string', description: 'Friendly license name, such as E3, E5, Visio, or Project.' },
          sku_id: { type: 'string', description: 'Optional Microsoft Graph subscribedSku GUID.' },
          reason: { type: 'string', description: 'Reason for assigning the license.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_license',
      description:
        'Remove a Microsoft 365 license from the displayed user. Use when the user asks to remove E3, E5, Visio, Project, or another license.',
      parameters: {
        type: 'object',
        properties: {
          license_sku: { type: 'string', description: 'Friendly license name, such as E3, E5, Visio, or Project.' },
          sku_id: { type: 'string', description: 'Optional Microsoft Graph subscribedSku GUID.' },
          reason: { type: 'string', description: 'Reason for removing the license.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grant_mailbox_access',
      description:
        'Grant delegate mailbox access involving the displayed user. Use when asked to give another person delegate access to this mailbox, or give this user access to another mailbox.',
      parameters: {
        type: 'object',
        properties: {
          delegate_email: { type: 'string', description: 'Delegate user email address receiving access.' },
          mailbox_email: { type: 'string', description: 'Mailbox owner email. Defaults to the displayed user.' },
          access_level: { type: 'string', enum: ['read', 'full_access', 'send_as'], description: 'Mailbox access level. Defaults to read.' },
          reason: { type: 'string', description: 'Reason for granting access.' },
        },
        required: ['delegate_email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_email_alias',
      description:
        'Add an email alias/proxy address to the displayed Microsoft 365 user.',
      parameters: {
        type: 'object',
        properties: {
          alias_email: { type: 'string', description: 'Alias email address to add.' },
          reason: { type: 'string', description: 'Reason for adding the alias.' },
        },
        required: ['alias_email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_out_of_office',
      description:
        'Check the displayed user\'s Microsoft 365 out-of-office/automatic replies setting.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_out_of_office',
      description:
        'Set or update the displayed user\'s Microsoft 365 out-of-office/automatic replies message.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Out-of-office message body.' },
          start_time: { type: 'string', description: 'Optional ISO start time.' },
          end_time: { type: 'string', description: 'Optional ISO end time.' },
          reason: { type: 'string', description: 'Reason for setting out-of-office.' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_to_teams_channel',
      description:
        'Add the displayed user to a Microsoft Teams channel.',
      parameters: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'Microsoft Teams team ID.' },
          channel_id: { type: 'string', description: 'Microsoft Teams channel ID.' },
          team_name: { type: 'string', description: 'Optional team name for local demo or summary.' },
          channel_name: { type: 'string', description: 'Optional channel name for local demo or summary.' },
          reason: { type: 'string', description: 'Reason for adding the user to the channel.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grant_onedrive_access',
      description:
        'Grant another user access to the displayed user\'s OneDrive root folder.',
      parameters: {
        type: 'object',
        properties: {
          recipient_email: { type: 'string', description: 'Recipient email address receiving OneDrive access.' },
          role: { type: 'string', enum: ['read', 'write'], description: 'OneDrive permission role. Defaults to read.' },
          reason: { type: 'string', description: 'Reason for granting OneDrive access.' },
        },
        required: ['recipient_email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_inactive_licenses',
      description:
        'List Microsoft 365 users who appear to have unused or inactive licenses, including an estimated monthly savings figure. ' +
        'Use when the user asks about unused E3 licenses, inactive licenses, license waste, or license cost savings.',
      parameters: {
        type: 'object',
        properties: {
          license_sku: { type: 'string', description: 'License SKU to inspect. Defaults to E3.' },
          inactive_days: { type: 'integer', description: 'Number of inactive days to treat as stale. Defaults to 90.' },
          monthly_cost: { type: 'number', description: 'Monthly cost per license for savings estimate. Defaults to M365_E3_MONTHLY_COST or 36.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_stale_guests',
      description:
        'List guest or external accounts that have been inactive for a configurable number of days. ' +
        'Use when the user asks for stale guests, guest access hygiene, or guest lifecycle review.',
      parameters: {
        type: 'object',
        properties: {
          inactive_days: { type: 'integer', description: 'Number of inactive days to treat as stale. Defaults to 90.' },
          limit: { type: 'integer', description: 'Maximum number of guests to return. Defaults to 10.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revoke_guest_access',
      description:
        'Revoke access for a stale guest or external Microsoft 365 user. ' +
        'Use after identifying a stale guest account or when the user explicitly asks to revoke guest access.',
      parameters: {
        type: 'object',
        properties: {
          guest_email: { type: 'string', description: 'Guest email to revoke. Defaults to the displayed user.' },
          reason: { type: 'string', description: 'Reason for revoking guest access.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dismiss_risky_user',
      description:
        'Dismiss Microsoft Entra ID Protection risk for a user after investigation. ' +
        'Use only when the user asks to clear or dismiss a risky-user flag as a false positive.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Optional Entra user object ID. Defaults to resolving the displayed user.' },
          user_email: { type: 'string', description: 'Optional risky user email. Defaults to the displayed user.' },
          reason: { type: 'string', description: 'Reason for dismissing the risk flag.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_app_consents',
      description:
        'List OAuth app consent grants for the displayed user or a specified user. ' +
        'Use when asked what apps have been granted access.',
      parameters: {
        type: 'object',
        properties: {
          user_email: { type: 'string', description: 'Optional user email. Defaults to the displayed user.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revoke_app_consent',
      description:
        'Revoke an OAuth app consent grant for the displayed user or a specified user.',
      parameters: {
        type: 'object',
        properties: {
          consent_id: { type: 'string', description: 'OAuth2 permission grant ID to revoke.' },
          app_name: { type: 'string', description: 'Friendly app name, used for local demo or summary.' },
          user_email: { type: 'string', description: 'Optional user email. Defaults to the displayed user.' },
          reason: { type: 'string', description: 'Reason for revoking app consent.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_ca_block',
      description:
        'Explain likely Conditional Access policy reasons a user is blocked from an app. ' +
        'Use when asked why a user cannot access Salesforce, Teams, SharePoint, or another app.',
      parameters: {
        type: 'object',
        properties: {
          app_name: { type: 'string', description: 'Application the user is blocked from.' },
          user_email: { type: 'string', description: 'Optional user email. Defaults to the displayed user.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_device_compliance',
      description:
        'Get Microsoft Intune device compliance information for the displayed user or a specified user.',
      parameters: {
        type: 'object',
        properties: {
          user_email: { type: 'string', description: 'Optional user email. Defaults to the displayed user.' },
          device_name: { type: 'string', description: 'Optional device name to narrow results.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bitlocker_key',
      description:
        'Retrieve a BitLocker recovery key with an audit ticket. Use only when explicitly asked for a BitLocker recovery key.',
      parameters: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'Optional device ID associated with the recovery key.' },
          key_id: { type: 'string', description: 'Optional BitLocker recovery key ID.' },
          device_name: { type: 'string', description: 'Optional device name for local demo or summary.' },
          reason: { type: 'string', description: 'Reason for retrieving the BitLocker key.' },
        },
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

  // ── Lifecycle Management ──────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'onboard_user',
      description:
        'Run the complete new-hire onboarding workflow: provision accounts in the required ' +
        'systems, assign the standard Microsoft 365 license, and add the user to the correct ' +
        'distribution groups and M365 groups for their department — all in one action. ' +
        'Use when asked to onboard, hire, or set up a new employee, contractor, or member.',
      parameters: {
        type: 'object',
        properties: {
          first_name:  { type: 'string', description: 'New hire first name.' },
          last_name:   { type: 'string', description: 'New hire last name.' },
          email:       { type: 'string', description: 'New hire email address.' },
          department:  {
            type: 'string',
            description:
              'Department key. Use list_access_templates to see valid values ' +
              '(e.g. service_desk, marketing, finance, hr, it_admin, operations, member, external_contractor).',
          },
          user_type:   { type: 'string', enum: ['employee', 'contractor', 'member'], description: 'Account type. Defaults to employee.' },
          license_sku: { type: 'string', description: 'Microsoft 365 license to assign. Defaults to the department template default.' },
          reason:      { type: 'string', description: 'Reason or notes for onboarding.' },
        },
        required: ['first_name', 'last_name', 'email', 'department'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'offboard_user',
      description:
        'Run the complete offboarding workflow for a departing user: disable all accounts ' +
        'across all systems, remove from all distribution groups and M365 groups, revoke ' +
        'SharePoint permissions, reclaim Microsoft 365 licenses, and optionally set an ' +
        'out-of-office message — all in one action. ' +
        'Use when asked to offboard, terminate, or fully remove a user.',
      parameters: {
        type: 'object',
        properties: {
          reason:                { type: 'string', description: 'Reason for offboarding.' },
          set_out_of_office:     { type: 'boolean', description: 'Set an automated out-of-office reply. Defaults to true.' },
          out_of_office_message: { type: 'string', description: 'Out-of-office message text. Defaults to a standard departure message if omitted.' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deprovision_cascade',
      description:
        'Cascade deprovisioning for an already-disabled user: remove them from all ' +
        'distribution groups and M365 groups, revoke SharePoint permissions, and reclaim ' +
        'any Microsoft 365 licenses. ' +
        'Use after a user account has been disabled but downstream access has not yet been cleaned up.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for the deprovisioning cascade.' },
        },
      },
    },
  },

  // ── Bulk Operations ───────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'bulk_action',
      description:
        'Apply a single action to a list of user email addresses. ' +
        'Use when multiple users need the same change — e.g. add an entire team to a group, ' +
        'disable multiple leavers, assign licenses to a new cohort, or reset passwords for a department.',
      parameters: {
        type: 'object',
        properties: {
          emails: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of email addresses to apply the action to.',
          },
          action: {
            type: 'string',
            enum: ['disable_account', 'assign_license', 'remove_license', 'add_to_group', 'add_to_m365_group', 'reset_password'],
            description: 'The action to apply to every user in the list.',
          },
          action_params: {
            type: 'object',
            description: 'Parameters for the chosen action, e.g. { "group_name": "All Staff" } or { "license_sku": "E3" }.',
          },
          reason: { type: 'string', description: 'Reason for the bulk action.' },
        },
        required: ['emails', 'action'],
      },
    },
  },

  // ── Access Requests ───────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'submit_access_request',
      description:
        'Submit a self-service access request for a resource (distribution group, license, ' +
        'SharePoint site, or M365 group). The request is logged as pending and must be approved ' +
        'before access is granted. ' +
        'Use when a user asks to request access to a resource.',
      parameters: {
        type: 'object',
        properties: {
          resource_type: {
            type: 'string',
            enum: ['distribution_group', 'license', 'sharepoint', 'm365_group'],
            description: 'Type of resource being requested.',
          },
          resource_name:       { type: 'string', description: 'Name of the group, license, or site being requested.' },
          reason:              { type: 'string', description: 'Business reason for the request.' },
          requested_for_email: { type: 'string', description: 'Email of the user the request is for. Defaults to the displayed user.' },
        },
        required: ['resource_type', 'resource_name', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_access_requests',
      description:
        'List access requests. Use when asked to show pending requests, check request status, ' +
        'or view the access request queue.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected', 'all'],
            description: 'Filter by status. Defaults to pending.',
          },
          limit: { type: 'integer', description: 'Maximum number of requests to return. Defaults to 10.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'approve_access_request',
      description:
        'Approve a pending access request and immediately execute the provisioning action. ' +
        'Use when an approver wants to grant a pending access request.',
      parameters: {
        type: 'object',
        properties: {
          request_id:    { type: 'integer', description: 'ID of the access request to approve.' },
          approver_note: { type: 'string',  description: 'Optional approval note.' },
        },
        required: ['request_id'],
      },
    },
  },

  // ── Department Access Templates ───────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'apply_access_template',
      description:
        'Apply a pre-defined department access template to the displayed user: assign the ' +
        'standard license, distribution groups, and M365 groups for that department in a ' +
        'single action. ' +
        'Use when a user changes departments or when access needs to match a role standard.',
      parameters: {
        type: 'object',
        properties: {
          department: {
            type: 'string',
            description:
              'Department key (e.g. service_desk, marketing, finance, hr, it_admin, operations, ' +
              'member, external_contractor). Call list_access_templates to see all valid options.',
          },
          reason: { type: 'string', description: 'Reason for applying the template.' },
        },
        required: ['department'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_access_templates',
      description:
        'List all available department access templates, including what licenses, distribution ' +
        'groups, and M365 groups each one provisions. ' +
        'Use when asked what templates are available or before applying one.',
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
  SYSTEM_LABELS,
  SAFE_TABLES,
  SAFE_COLUMNS,
  validateTargetSystem,
  escapeLike,
} = require('./validation');

// ── Department access templates ───────────────────────────────────────────────
// Each entry defines the standard license, distribution groups, and M365 groups
// that should be provisioned for a given department or role. Used by onboard_user
// and apply_access_template.
const ACCESS_TEMPLATES = {
  service_desk: {
    label: 'Service Desk',
    description: 'Standard access for IT Service Desk staff handling user support requests.',
    license: 'E3',
    distribution_groups: ['IT Service Desk', 'All Staff', 'IT Announcements'],
    m365_groups: ['IT Team', 'Service Desk'],
  },
  marketing: {
    label: 'Marketing',
    description: 'Standard access for Marketing team members.',
    license: 'E3',
    distribution_groups: ['Marketing Team', 'All Staff', 'Company Announcements'],
    m365_groups: ['Marketing Team', 'Brand Assets'],
  },
  finance: {
    label: 'Finance',
    description: 'Standard access for Finance team members.',
    license: 'E3',
    distribution_groups: ['Finance Team', 'All Staff', 'Finance Announcements'],
    m365_groups: ['Finance Team', 'Budget Planning'],
  },
  hr: {
    label: 'Human Resources',
    description: 'Standard access for HR team members.',
    license: 'E3',
    distribution_groups: ['HR Team', 'All Staff'],
    m365_groups: ['HR Team', 'Recruitment'],
  },
  it_admin: {
    label: 'IT Administration',
    description: 'Elevated access for IT Administrators. Includes admin-level groups and an E5 license.',
    license: 'E5',
    distribution_groups: ['IT Admins', 'IT Service Desk', 'All Staff', 'IT Announcements'],
    m365_groups: ['IT Admins', 'IT Team', 'Security Operations'],
  },
  operations: {
    label: 'Operations',
    description: 'Standard access for Operations team members.',
    license: 'E3',
    distribution_groups: ['Operations Team', 'All Staff'],
    m365_groups: ['Operations Team'],
  },
  member: {
    label: 'Association Member',
    description: 'Standard access for registered association members (netForum only).',
    license: null,
    distribution_groups: ['Member Communications', 'Member Newsletter'],
    m365_groups: [],
    primary_system: 'netforum_members',
  },
  external_contractor: {
    label: 'External Contractor',
    description: 'Limited access for external contractors and consultants.',
    license: null,
    distribution_groups: ['External Contractors'],
    m365_groups: ['Contractors'],
    primary_system: 'external_users',
  },
};

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

async function executeResetMfa(pool, email, fnArgs, sessionId) {
  const methodId = fnArgs.method_id || null;
  const reason = fnArgs.reason || 'User needs to re-register MFA.';
  const title = 'Reset Microsoft 365 MFA registration';
  const description = `Reset MFA registration for ${email}. Reason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    if (graphClient.mode === 'graph') {
      if (methodId) {
        await graphClient.api(`/users/${encodeURIComponent(email)}/authentication/methods/${encodeURIComponent(methodId)}`).delete();
        return { reset: true, email, methodsReset: 1, graphMode: graphClient.mode };
      }

      const methods = await graphClient.api(`/users/${encodeURIComponent(email)}/authentication/methods`).get();
      const resettableMethods = (methods.value || []).filter(method => method.id);
      for (const method of resettableMethods) {
        await graphClient.api(`/users/${encodeURIComponent(email)}/authentication/methods/${encodeURIComponent(method.id)}`).delete();
      }
      return { reset: true, email, methodsReset: resettableMethods.length, graphMode: graphClient.mode };
    }

    const { rows } = await pool.query(
      `SELECT id FROM active_directory WHERE email = $1
       UNION ALL
       SELECT id FROM external_users WHERE email = $1
       LIMIT 1`,
      [email]
    );
    if (rows.length === 0) {
      throw new Error(`No local directory account found for ${email}`);
    }

    return { reset: true, email, methodsReset: methodId ? 1 : 'all', graphMode: graphClient.mode };
  });
}

async function ensureLocalUser(pool, email) {
  const { rows } = await pool.query(
    `SELECT email, first_name, last_name, type, 'active_directory' AS source
     FROM active_directory WHERE email = $1
     UNION ALL
     SELECT email, first_name, last_name, type, 'external_users' AS source
     FROM external_users WHERE email = $1
     UNION ALL
     SELECT email, first_name, last_name, type, 'netforum_members' AS source
     FROM netforum_members WHERE email = $1
     LIMIT 1`,
    [email]
  );
  if (rows.length === 0) {
    throw new Error(`No local user record found for ${email}`);
  }
  return rows[0];
}

function graphUserPath(email, suffix) {
  return `/users/${encodeURIComponent(email)}${suffix}`;
}

async function executeGetMfaStatus(pool, email) {
  if (graphClient.mode === 'graph') {
    const methods = await graphClient.api(graphUserPath(email, '/authentication/methods')).get();
    return {
      graphMode: graphClient.mode,
      email,
      enabled: (methods.value || []).length > 0,
      methods: methods.value || [],
    };
  }

  const user = await ensureLocalUser(pool, email);
  return {
    graphMode: graphClient.mode,
    email,
    enabled: true,
    methods: [
      { id: 'mock-authenticator-app', type: 'Microsoft Authenticator app' },
      { id: 'mock-sms', type: 'SMS' },
    ],
    source: user.source,
  };
}

async function executeAssignLicense(pool, email, fnArgs, sessionId) {
  const licenseSku = fnArgs.license_sku || fnArgs.sku_id || 'E3';
  const skuId = fnArgs.sku_id || licenseSku;
  const reason = fnArgs.reason || `Assign ${licenseSku} license.`;
  const title = `Assign Microsoft 365 license — ${licenseSku}`;
  const description = `Assign ${licenseSku} license to ${email}. Reason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    if (graphClient.mode === 'graph') {
      await graphClient.api(graphUserPath(email, '/assignLicense')).post({
        addLicenses: [{ skuId }],
        removeLicenses: [],
      });
      return { assigned: true, email, licenseSku, skuId, graphMode: graphClient.mode };
    }

    const user = await ensureLocalUser(pool, email);
    return { assigned: true, email, licenseSku, skuId, source: user.source, graphMode: graphClient.mode };
  });
}

async function executeRemoveLicense(pool, email, fnArgs, sessionId) {
  const licenseSku = fnArgs.license_sku || fnArgs.sku_id || 'E3';
  const skuId = fnArgs.sku_id || licenseSku;
  const reason = fnArgs.reason || `Remove ${licenseSku} license.`;
  const title = `Remove Microsoft 365 license — ${licenseSku}`;
  const description = `Remove ${licenseSku} license from ${email}. Reason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    if (graphClient.mode === 'graph') {
      await graphClient.api(graphUserPath(email, '/assignLicense')).post({
        addLicenses: [],
        removeLicenses: [skuId],
      });
      return { removed: true, email, licenseSku, skuId, graphMode: graphClient.mode };
    }

    const user = await ensureLocalUser(pool, email);
    return { removed: true, email, licenseSku, skuId, source: user.source, graphMode: graphClient.mode };
  });
}

async function executeGrantMailboxAccess(pool, email, fnArgs, sessionId) {
  const delegateEmail = fnArgs.delegate_email;
  const mailboxEmail = fnArgs.mailbox_email || email;
  const accessLevel = fnArgs.access_level || 'read';
  const reason = fnArgs.reason || 'Mailbox delegate access requested.';
  const title = `Grant mailbox access — ${mailboxEmail}`;
  const description = `Grant ${delegateEmail} ${accessLevel} access to ${mailboxEmail}. Reason: ${reason}`;

  return createAndCloseTicket(pool, mailboxEmail, title, description, sessionId, async () => {
    if (!delegateEmail) throw new Error('delegate_email is required.');
    if (graphClient.mode === 'graph') {
      await graphClient.api(graphUserPath(mailboxEmail, '/mailFolders/inbox/messageRules')).post({
        displayName: `Delegate access for ${delegateEmail}`,
        isEnabled: true,
        actions: { forwardTo: [{ emailAddress: { address: delegateEmail } }] },
      });
      return { granted: true, mailboxEmail, delegateEmail, accessLevel, graphMode: graphClient.mode };
    }

    await ensureLocalUser(pool, mailboxEmail);
    await ensureLocalUser(pool, delegateEmail);
    return { granted: true, mailboxEmail, delegateEmail, accessLevel, graphMode: graphClient.mode };
  });
}

async function executeAddEmailAlias(pool, email, fnArgs, sessionId) {
  const aliasEmail = fnArgs.alias_email;
  const reason = fnArgs.reason || 'Email alias requested.';
  const title = `Add email alias — ${aliasEmail || 'missing alias'}`;
  const description = `Add alias ${aliasEmail} to ${email}. Reason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    if (!aliasEmail) throw new Error('alias_email is required.');
    if (graphClient.mode === 'graph') {
      const user = await graphClient.api(graphUserPath(email, '?$select=proxyAddresses')).get();
      const proxyAddresses = Array.from(new Set([...(user.proxyAddresses || []), `smtp:${aliasEmail}`]));
      await graphClient.api(graphUserPath(email, '')).patch({ proxyAddresses });
      return { added: true, email, aliasEmail, graphMode: graphClient.mode };
    }

    await ensureLocalUser(pool, email);
    return { added: true, email, aliasEmail, graphMode: graphClient.mode };
  });
}

async function executeGetOutOfOffice(pool, email) {
  if (graphClient.mode === 'graph') {
    const settings = await graphClient.api(graphUserPath(email, '/mailboxSettings')).get();
    return { graphMode: graphClient.mode, email, automaticRepliesSetting: settings.automaticRepliesSetting || null };
  }

  const user = await ensureLocalUser(pool, email);
  return {
    graphMode: graphClient.mode,
    email,
    status: 'disabled',
    message: '',
    source: user.source,
  };
}

async function executeSetOutOfOffice(pool, email, fnArgs, sessionId) {
  const message = fnArgs.message;
  const reason = fnArgs.reason || 'Out-of-office update requested.';
  const title = 'Set Microsoft 365 out-of-office';
  const description = `Set out-of-office for ${email}. Reason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    if (!message) throw new Error('message is required.');
    const automaticRepliesSetting = {
      status: fnArgs.start_time || fnArgs.end_time ? 'scheduled' : 'alwaysEnabled',
      externalAudience: 'all',
      internalReplyMessage: message,
      externalReplyMessage: message,
    };
    if (fnArgs.start_time && fnArgs.end_time) {
      automaticRepliesSetting.scheduledStartDateTime = { dateTime: fnArgs.start_time, timeZone: 'UTC' };
      automaticRepliesSetting.scheduledEndDateTime = { dateTime: fnArgs.end_time, timeZone: 'UTC' };
    }

    if (graphClient.mode === 'graph') {
      await graphClient.api(graphUserPath(email, '/mailboxSettings')).patch({ automaticRepliesSetting });
      return { updated: true, email, automaticRepliesSetting, graphMode: graphClient.mode };
    }

    await ensureLocalUser(pool, email);
    return { updated: true, email, automaticRepliesSetting, graphMode: graphClient.mode };
  });
}

async function executeAddToTeamsChannel(pool, email, fnArgs, sessionId) {
  const teamId = fnArgs.team_id;
  const channelId = fnArgs.channel_id;
  const teamName = fnArgs.team_name || teamId || 'unspecified team';
  const channelName = fnArgs.channel_name || channelId || 'unspecified channel';
  const reason = fnArgs.reason || 'Teams channel access requested.';
  const title = `Add to Teams channel — ${channelName}`;
  const description = `Add ${email} to Teams channel ${teamName}/${channelName}. Reason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    if (graphClient.mode === 'graph') {
      if (!teamId || !channelId) throw new Error('team_id and channel_id are required for live Graph Teams channel membership.');
      await graphClient.api(`/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/members`).post({
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: [],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}`,
      });
      return { added: true, email, teamId, channelId, graphMode: graphClient.mode };
    }

    await ensureLocalUser(pool, email);
    return { added: true, email, teamName, channelName, graphMode: graphClient.mode };
  });
}

async function executeGrantOneDriveAccess(pool, email, fnArgs, sessionId) {
  const recipientEmail = fnArgs.recipient_email;
  const role = fnArgs.role || 'read';
  const reason = fnArgs.reason || 'OneDrive access requested.';
  const title = 'Grant OneDrive access';
  const description = `Grant ${recipientEmail} ${role} access to ${email}'s OneDrive. Reason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    if (!recipientEmail) throw new Error('recipient_email is required.');
    if (graphClient.mode === 'graph') {
      await graphClient.api(graphUserPath(email, '/drive/root/invite')).post({
        recipients: [{ email: recipientEmail }],
        requireSignIn: true,
        sendInvitation: false,
        roles: [role],
      });
      return { granted: true, email, recipientEmail, role, graphMode: graphClient.mode };
    }

    await ensureLocalUser(pool, email);
    await ensureLocalUser(pool, recipientEmail);
    return { granted: true, email, recipientEmail, role, graphMode: graphClient.mode };
  });
}

async function executeListInactiveLicenses(pool, fnArgs) {
  const licenseSku = fnArgs.license_sku || 'E3';
  const inactiveDays = Number.isInteger(fnArgs.inactive_days) ? fnArgs.inactive_days : 90;
  const monthlyCost = typeof fnArgs.monthly_cost === 'number'
    ? fnArgs.monthly_cost
    : parseFloat(process.env.M365_E3_MONTHLY_COST || '36');

  if (graphClient.mode === 'graph') {
    const report = await graphClient
      .api('/reports/getOffice365ActiveUserDetail(period=\'D90\')')
      .get();
    return {
      graphMode: graphClient.mode,
      licenseSku,
      inactiveDays,
      report,
      note: 'Graph reporting data returned directly; filter by Assigned Products and Last Activity Date before license removal.',
    };
  }

  const { rows } = await pool.query(
    `SELECT first_name, last_name, email, type, passwordlastreset, created_at
     FROM active_directory
     WHERE enabled = true
       AND (passwordlastreset IS NULL OR passwordlastreset < now() - ($1::int * interval '1 day'))
     ORDER BY passwordlastreset NULLS FIRST, created_at ASC
     LIMIT 25`,
    [inactiveDays]
  );

  const users = rows.map(row => ({
    name: `${row.first_name} ${row.last_name}`,
    email: row.email,
    type: row.type,
    lastActivity: row.passwordlastreset || row.created_at,
    licenseSku,
    estimatedMonthlySavings: monthlyCost,
  }));

  return {
    graphMode: graphClient.mode,
    licenseSku,
    inactiveDays,
    count: users.length,
    estimatedMonthlySavings: Number((users.length * monthlyCost).toFixed(2)),
    users,
  };
}

async function executeListStaleGuests(pool, fnArgs) {
  const inactiveDays = Number.isInteger(fnArgs.inactive_days) ? fnArgs.inactive_days : 90;
  const limit = Number.isInteger(fnArgs.limit) ? Math.min(Math.max(fnArgs.limit, 1), 50) : 10;

  if (graphClient.mode === 'graph') {
    const guests = await graphClient
      .api(`/users?$filter=userType eq 'Guest'&$select=id,displayName,mail,userPrincipalName,accountEnabled,signInActivity&$top=${limit}`)
      .get();
    return { graphMode: graphClient.mode, inactiveDays, guests: guests.value || [] };
  }

  const { rows } = await pool.query(
    `SELECT first_name, last_name, email, type, sponsor, enabled, created_at
     FROM external_users
     WHERE enabled = true
       AND (type ILIKE '%guest%' OR type ILIKE '%contractor%' OR sponsor IS NOT NULL)
       AND created_at < now() - ($1::int * interval '1 day')
     ORDER BY created_at ASC
     LIMIT $2`,
    [inactiveDays, limit]
  );

  return {
    graphMode: graphClient.mode,
    inactiveDays,
    count: rows.length,
    guests: rows.map(row => ({
      name: `${row.first_name} ${row.last_name}`,
      email: row.email,
      type: row.type,
      sponsor: row.sponsor,
      enabled: row.enabled,
      lastSeen: row.created_at,
    })),
  };
}

async function executeRevokeGuestAccess(pool, email, fnArgs, sessionId) {
  const guestEmail = fnArgs.guest_email || email;
  const reason = fnArgs.reason || 'Stale guest account lifecycle cleanup.';
  const title = 'Revoke Microsoft 365 guest access';
  const description = `Revoke guest access for ${guestEmail}. Reason: ${reason}`;

  return createAndCloseTicket(pool, guestEmail, title, description, sessionId, async () => {
    if (graphClient.mode === 'graph') {
      await graphClient.api(`/users/${encodeURIComponent(guestEmail)}`).delete();
      return { revoked: true, email: guestEmail, graphMode: graphClient.mode };
    }

    const { rowCount } = await pool.query(
      `UPDATE external_users
       SET enabled = false
       WHERE email = $1
         AND enabled = true
         AND (type ILIKE '%guest%' OR type ILIKE '%contractor%' OR sponsor IS NOT NULL)`,
      [guestEmail]
    );

    if (rowCount === 0) {
      throw new Error(`No enabled local guest/external account found for ${guestEmail}`);
    }

    return { revoked: true, email: guestEmail, graphMode: graphClient.mode };
  });
}

async function resolveGraphUserId(email, fallbackUserId) {
  if (fallbackUserId) return fallbackUserId;
  const user = await graphClient.api(graphUserPath(email, '?$select=id')).get();
  if (!user.id) throw new Error(`Could not resolve Microsoft Graph user ID for ${email}`);
  return user.id;
}

async function executeDismissRiskyUser(pool, email, fnArgs, sessionId) {
  const targetEmail = fnArgs.user_email || email;
  const reason = fnArgs.reason || 'Risk reviewed and confirmed as false positive.';
  const title = 'Dismiss Microsoft Entra risky-user flag';
  const description = `Dismiss risky-user flag for ${targetEmail}. Reason: ${reason}`;

  return createAndCloseTicket(pool, targetEmail, title, description, sessionId, async () => {
    if (graphClient.mode === 'graph') {
      const userId = await resolveGraphUserId(targetEmail, fnArgs.user_id);
      await graphClient.api('/identityProtection/riskyUsers/dismiss').post({ userIds: [userId] });
      return { dismissed: true, email: targetEmail, userId, graphMode: graphClient.mode };
    }

    const user = await ensureLocalUser(pool, targetEmail);
    return { dismissed: true, email: targetEmail, userId: fnArgs.user_id || user.email, graphMode: graphClient.mode };
  });
}

async function executeListAppConsents(pool, email, fnArgs) {
  const targetEmail = fnArgs.user_email || email;

  if (graphClient.mode === 'graph') {
    const userId = await resolveGraphUserId(targetEmail);
    const grants = await graphClient
      .api(`/oauth2PermissionGrants?$filter=principalId eq '${userId}'`)
      .get();
    return { graphMode: graphClient.mode, email: targetEmail, userId, consents: grants.value || [] };
  }

  const user = await ensureLocalUser(pool, targetEmail);
  return {
    graphMode: graphClient.mode,
    email: targetEmail,
    source: user.source,
    consents: [
      { id: `mock-${targetEmail}-grammarly`, appName: 'Grammarly', scopes: ['User.Read', 'Mail.Read'] },
      { id: `mock-${targetEmail}-salesforce`, appName: 'Salesforce', scopes: ['User.Read'] },
    ],
  };
}

async function executeRevokeAppConsent(pool, email, fnArgs, sessionId) {
  const targetEmail = fnArgs.user_email || email;
  const appName = fnArgs.app_name || fnArgs.consent_id || 'specified app';
  const reason = fnArgs.reason || 'OAuth app consent no longer approved.';
  const title = `Revoke app consent — ${appName}`;
  const description = `Revoke app consent for ${targetEmail}: ${appName}. Reason: ${reason}`;

  return createAndCloseTicket(pool, targetEmail, title, description, sessionId, async () => {
    if (graphClient.mode === 'graph') {
      if (!fnArgs.consent_id) throw new Error('consent_id is required to revoke live Graph app consent.');
      await graphClient.api(`/oauth2PermissionGrants/${encodeURIComponent(fnArgs.consent_id)}`).delete();
      return { revoked: true, email: targetEmail, consentId: fnArgs.consent_id, appName, graphMode: graphClient.mode };
    }

    await ensureLocalUser(pool, targetEmail);
    return { revoked: true, email: targetEmail, consentId: fnArgs.consent_id || `mock-${appName}`, appName, graphMode: graphClient.mode };
  });
}

async function executeExplainCaBlock(pool, email, fnArgs) {
  const targetEmail = fnArgs.user_email || email;
  const appName = fnArgs.app_name || 'the requested app';

  if (graphClient.mode === 'graph') {
    const policies = await graphClient.api('/identity/conditionalAccess/policies').get();
    return {
      graphMode: graphClient.mode,
      email: targetEmail,
      appName,
      policies: policies.value || [],
      note: 'Graph Conditional Access policies returned for evaluation against sign-in logs and user/device state.',
    };
  }

  await ensureLocalUser(pool, targetEmail);
  return {
    graphMode: graphClient.mode,
    email: targetEmail,
    appName,
    likelyCaBlock: true,
    reasons: [
      'Device compliance is required for this cloud app.',
      'MFA is required for external network access.',
      'Guest or contractor accounts require approved client apps.',
    ],
  };
}

async function executeGetDeviceCompliance(pool, email, fnArgs) {
  const targetEmail = fnArgs.user_email || email;
  const deviceName = fnArgs.device_name || null;

  if (graphClient.mode === 'graph') {
    const filter = `userPrincipalName eq '${targetEmail}'`;
    const devices = await graphClient
      .api(`/deviceManagement/managedDevices?$filter=${encodeURIComponent(filter)}`)
      .get();
    const values = deviceName
      ? (devices.value || []).filter(device => (device.deviceName || '').toLowerCase().includes(deviceName.toLowerCase()))
      : (devices.value || []);
    return { graphMode: graphClient.mode, email: targetEmail, deviceName, devices: values };
  }

  const user = await ensureLocalUser(pool, targetEmail);
  return {
    graphMode: graphClient.mode,
    email: targetEmail,
    devices: [
      {
        deviceName: deviceName || `${user.first_name || 'User'}-Laptop`,
        complianceState: 'noncompliant',
        os: 'macOS',
        issue: 'Encryption policy has not reported in the last 24 hours.',
      },
    ],
  };
}

async function executeGetBitlockerKey(pool, email, fnArgs, sessionId) {
  const deviceName = fnArgs.device_name || fnArgs.device_id || fnArgs.key_id || 'specified device';
  const reason = fnArgs.reason || 'BitLocker recovery requested for support.';
  const title = `Retrieve BitLocker recovery key — ${deviceName}`;
  const description = `Retrieve BitLocker recovery key for ${email}, device ${deviceName}. Reason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    if (graphClient.mode === 'graph') {
      const keyPath = fnArgs.key_id
        ? `/informationProtection/bitlocker/recoveryKeys/${encodeURIComponent(fnArgs.key_id)}?$select=id,createdDateTime,deviceId,key`
        : `/informationProtection/bitlocker/recoveryKeys?$filter=deviceId eq '${fnArgs.device_id || ''}'`;
      const key = await graphClient.api(keyPath).get();
      return { retrieved: true, email, deviceName, key, graphMode: graphClient.mode };
    }

    await ensureLocalUser(pool, email);
    return {
      retrieved: true,
      email,
      deviceName,
      key: {
        id: fnArgs.key_id || 'mock-bitlocker-key',
        deviceId: fnArgs.device_id || 'mock-device-id',
        recoveryKey: '111111-222222-333333-444444-555555-666666-777777-888888',
      },
      graphMode: graphClient.mode,
    };
  });
}

// ── Lifecycle management executors ────────────────────────────────────────────

async function executeOnboardUser(pool, email, fnArgs, sessionId) {
  const { first_name, last_name, department, user_type, license_sku, reason } = fnArgs;
  const template = ACCESS_TEMPLATES[department] || ACCESS_TEMPLATES['operations'];
  const primarySystem = template.primary_system || 'active_directory';

  const title = `Onboard new ${template.label} team member — ${first_name} ${last_name}`;
  const description =
    `Full onboarding for ${first_name} ${last_name} <${email}>.\n` +
    `Department: ${template.label}\nReason: ${reason || 'New hire onboarding'}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    const steps = [];

    // 1. Provision account in primary system if not already present
    const safeTable = SAFE_TABLES[primarySystem];
    if (safeTable) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM ${safeTable} WHERE email = $1`, [email]
      );
      if (existing.length === 0) {
        const defaultType = user_type || (
          primarySystem === 'netforum_members' ? 'member'
          : primarySystem === 'external_users' ? 'contractor'
          : 'employee'
        );
        let insertSql, insertParams;
        if (primarySystem === 'active_directory') {
          insertSql = `INSERT INTO active_directory
            (first_name, last_name, email, type, enabled, locked, passwordlastreset, created_at)
            VALUES ($1,$2,$3,$4,true,false,now(),now()) RETURNING id`;
          insertParams = [first_name, last_name, email, defaultType];
        } else if (primarySystem === 'netforum_members') {
          insertSql = `INSERT INTO netforum_members
            (first_name, last_name, email, type, enabled, last_login, created_at)
            VALUES ($1,$2,$3,$4,true,null,now()) RETURNING id`;
          insertParams = [first_name, last_name, email, defaultType];
        } else if (primarySystem === 'external_users') {
          insertSql = `INSERT INTO external_users
            (first_name, last_name, email, type, enabled, sponsor, created_at)
            VALUES ($1,$2,$3,$4,true,null,now()) RETURNING id`;
          insertParams = [first_name, last_name, email, defaultType];
        }
        if (insertSql) {
          await pool.query(insertSql, insertParams);
          steps.push(`Provisioned ${SYSTEM_LABELS[primarySystem]} account`);
        }
      } else {
        steps.push(`${SYSTEM_LABELS[primarySystem]} account already exists — skipped provisioning`);
      }
    }

    // 2. License assignment (live: Graph assignLicense; PoC: recorded in ticket)
    const licenseToAssign = license_sku || template.license;
    if (licenseToAssign) {
      steps.push(`Assigned ${licenseToAssign} license`);
    }

    // 3. Add to distribution groups
    for (const groupName of (template.distribution_groups || [])) {
      const { rows: groups } = await pool.query(
        `SELECT id, name, contacts FROM distribution_groups
         WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
        [`%${escapeLike(groupName)}%`]
      );
      if (groups.length > 0) {
        const group = groups[0];
        const contacts = group.contacts || [];
        if (!contacts.some(c => c.email?.toLowerCase() === email.toLowerCase())) {
          contacts.push({ first_name, last_name, email });
          await pool.query(
            `UPDATE distribution_groups SET contacts = $1::jsonb WHERE id = $2`,
            [JSON.stringify(contacts), group.id]
          );
          steps.push(`Added to distribution group: ${group.name}`);
        } else {
          steps.push(`Already in distribution group: ${group.name}`);
        }
      } else {
        steps.push(`Distribution group not found (will create in production): ${groupName}`);
      }
    }

    // 4. Add to M365 groups
    for (const groupName of (template.m365_groups || [])) {
      const { rows: groups } = await pool.query(
        `SELECT id, group_name, users FROM m365_group_memberships
         WHERE LOWER(group_name) LIKE LOWER($1) LIMIT 1`,
        [`%${escapeLike(groupName)}%`]
      );
      if (groups.length > 0) {
        const group = groups[0];
        const users = group.users || [];
        if (!users.some(u => u.email?.toLowerCase() === email.toLowerCase())) {
          users.push({
            role: 'member',
            email,
            source: primarySystem,
            joined_at: new Date().toISOString(),
          });
          await pool.query(
            `UPDATE m365_group_memberships SET users = $1::jsonb WHERE id = $2`,
            [JSON.stringify(users), group.id]
          );
          steps.push(`Added to M365 group: ${group.group_name}`);
        } else {
          steps.push(`Already in M365 group: ${group.group_name}`);
        }
      } else {
        steps.push(`M365 group not found (will create in production): ${groupName}`);
      }
    }

    return {
      onboarded: true,
      email,
      department: template.label,
      stepsCompleted: steps.length,
      steps,
    };
  });
}

async function executeOffboardUser(pool, email, fnArgs, sessionId) {
  const reason = fnArgs.reason || 'No reason provided';
  const setOOF = fnArgs.set_out_of_office !== false;
  const oofMessage = fnArgs.out_of_office_message ||
    'This person has left the organisation. Please contact the service desk or your team manager for assistance.';

  const title = `Full offboarding — ${email}`;
  const description = `Complete offboarding for ${email}.\nReason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    const steps = [];

    // 1. Disable all accounts
    for (const table of ['active_directory', 'netforum_members', 'external_users']) {
      const tbl = SAFE_TABLES[table];
      const { rowCount } = await pool.query(
        `UPDATE ${tbl} SET enabled = false WHERE email = $1 AND enabled = true`,
        [email]
      );
      if (rowCount > 0) steps.push(`Disabled ${SYSTEM_LABELS[table]} account`);
    }

    // 2. Remove from all distribution groups (text search on JSONB)
    const { rows: dgRows } = await pool.query(
      `SELECT id, name, contacts FROM distribution_groups
       WHERE contacts::text ILIKE $1`,
      [`%${escapeLike(email)}%`]
    );
    for (const group of dgRows) {
      const updated = (group.contacts || []).filter(
        c => c.email?.toLowerCase() !== email.toLowerCase()
      );
      if (updated.length !== (group.contacts || []).length) {
        await pool.query(
          `UPDATE distribution_groups SET contacts = $1::jsonb WHERE id = $2`,
          [JSON.stringify(updated), group.id]
        );
        steps.push(`Removed from distribution group: ${group.name}`);
      }
    }

    // 3. Remove from all M365 groups
    const { rows: m365Rows } = await pool.query(
      `SELECT id, group_name, users FROM m365_group_memberships
       WHERE users::text ILIKE $1`,
      [`%${escapeLike(email)}%`]
    );
    for (const group of m365Rows) {
      const updated = (group.users || []).filter(
        u => u.email?.toLowerCase() !== email.toLowerCase()
      );
      if (updated.length !== (group.users || []).length) {
        await pool.query(
          `UPDATE m365_group_memberships SET users = $1::jsonb WHERE id = $2`,
          [JSON.stringify(updated), group.id]
        );
        steps.push(`Removed from M365 group: ${group.group_name}`);
      }
    }

    // 4. Revoke SharePoint permissions
    const { rowCount: spCount } = await pool.query(
      `DELETE FROM sharepoint_permissions WHERE user_email = $1`,
      [email]
    );
    if (spCount > 0) steps.push(`Revoked ${spCount} SharePoint permission(s)`);

    // 5. Out-of-office (recorded; live Graph call in production)
    if (setOOF) steps.push('Out-of-office reply recorded');

    if (steps.length === 0) {
      throw new Error(`No active accounts or memberships found for ${email}`);
    }

    return {
      offboarded: true,
      email,
      reason,
      stepsCompleted: steps.length,
      steps,
      outOfOfficeSet: setOOF,
      outOfOfficeMessage: setOOF ? oofMessage : null,
    };
  });
}

async function executeDeprovisionCascade(pool, email, fnArgs, sessionId) {
  const reason = fnArgs.reason || 'Post-disable access cleanup';
  const title = `Deprovisioning cascade — ${email}`;
  const description = `Remove all downstream access for disabled user ${email}.\nReason: ${reason}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    const steps = [];

    // Remove from all distribution groups
    const { rows: dgRows } = await pool.query(
      `SELECT id, name, contacts FROM distribution_groups
       WHERE contacts::text ILIKE $1`,
      [`%${escapeLike(email)}%`]
    );
    for (const group of dgRows) {
      const updated = (group.contacts || []).filter(
        c => c.email?.toLowerCase() !== email.toLowerCase()
      );
      if (updated.length !== (group.contacts || []).length) {
        await pool.query(
          `UPDATE distribution_groups SET contacts = $1::jsonb WHERE id = $2`,
          [JSON.stringify(updated), group.id]
        );
        steps.push(`Removed from distribution group: ${group.name}`);
      }
    }

    // Remove from all M365 groups
    const { rows: m365Rows } = await pool.query(
      `SELECT id, group_name, users FROM m365_group_memberships
       WHERE users::text ILIKE $1`,
      [`%${escapeLike(email)}%`]
    );
    for (const group of m365Rows) {
      const updated = (group.users || []).filter(
        u => u.email?.toLowerCase() !== email.toLowerCase()
      );
      if (updated.length !== (group.users || []).length) {
        await pool.query(
          `UPDATE m365_group_memberships SET users = $1::jsonb WHERE id = $2`,
          [JSON.stringify(updated), group.id]
        );
        steps.push(`Removed from M365 group: ${group.group_name}`);
      }
    }

    // Revoke SharePoint permissions
    const { rowCount: spCount } = await pool.query(
      `DELETE FROM sharepoint_permissions WHERE user_email = $1`,
      [email]
    );
    if (spCount > 0) steps.push(`Revoked ${spCount} SharePoint permission(s)`);

    if (steps.length === 0) {
      return {
        cascaded: true,
        email,
        steps: ['No downstream access found — user is already fully deprovisioned'],
        stepsCompleted: 0,
      };
    }

    return { cascaded: true, email, stepsCompleted: steps.length, steps };
  });
}

// ── Bulk operations executor ──────────────────────────────────────────────────

async function executeBulkAction(pool, email, fnArgs, sessionId) {
  const { emails, action, action_params: actionParams = {}, reason } = fnArgs;
  if (!Array.isArray(emails) || emails.length === 0) {
    throw new Error('emails must be a non-empty array.');
  }
  const ALLOWED_BULK_ACTIONS = ['disable_account', 'assign_license', 'remove_license', 'add_to_group', 'add_to_m365_group', 'reset_password'];
  if (!ALLOWED_BULK_ACTIONS.includes(action)) {
    throw new Error(`Unsupported bulk action: ${action}`);
  }

  const title = `Bulk ${action} — ${emails.length} user(s)`;
  const description =
    `Apply "${action}" to ${emails.length} user(s).\n` +
    `Users: ${emails.slice(0, 10).join(', ')}${emails.length > 10 ? ` … +${emails.length - 10} more` : ''}\n` +
    `Reason: ${reason || 'Bulk operation'}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    const results = [];

    for (const targetEmail of emails) {
      try {
        let result;

        if (action === 'disable_account') {
          const disabled = {};
          for (const table of ['active_directory', 'netforum_members', 'external_users']) {
            const tbl = SAFE_TABLES[table];
            const { rowCount } = await pool.query(
              `UPDATE ${tbl} SET enabled = false WHERE email = $1 AND enabled = true`,
              [targetEmail]
            );
            if (rowCount > 0) disabled[table] = 'disabled';
          }
          result = { success: Object.keys(disabled).length > 0, disabled };

        } else if (action === 'reset_password') {
          const { rowCount } = await pool.query(
            `UPDATE active_directory SET passwordlastreset = now() WHERE email = $1`,
            [targetEmail]
          );
          result = { success: rowCount > 0 };

        } else if (action === 'assign_license' || action === 'remove_license') {
          const sku = actionParams.license_sku || actionParams.sku_id || 'E3';
          result = { success: true, license_sku: sku };

        } else if (action === 'add_to_group') {
          const groupName = actionParams.group_name;
          if (!groupName) throw new Error('action_params.group_name is required for add_to_group');
          const { rows: groups } = await pool.query(
            `SELECT id, name, contacts FROM distribution_groups
             WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
            [`%${escapeLike(groupName)}%`]
          );
          if (groups.length === 0) throw new Error(`Distribution group not found: ${groupName}`);
          const group = groups[0];
          const contacts = group.contacts || [];
          if (!contacts.some(c => c.email?.toLowerCase() === targetEmail.toLowerCase())) {
            contacts.push({ first_name: targetEmail.split('@')[0], last_name: '', email: targetEmail });
            await pool.query(
              `UPDATE distribution_groups SET contacts = $1::jsonb WHERE id = $2`,
              [JSON.stringify(contacts), group.id]
            );
          }
          result = { success: true, group: group.name };

        } else if (action === 'add_to_m365_group') {
          const groupName = actionParams.group_name;
          if (!groupName) throw new Error('action_params.group_name is required for add_to_m365_group');
          const { rows: groups } = await pool.query(
            `SELECT id, group_name, users FROM m365_group_memberships
             WHERE LOWER(group_name) LIKE LOWER($1) LIMIT 1`,
            [`%${escapeLike(groupName)}%`]
          );
          if (groups.length === 0) throw new Error(`M365 group not found: ${groupName}`);
          const group = groups[0];
          const users = group.users || [];
          if (!users.some(u => u.email?.toLowerCase() === targetEmail.toLowerCase())) {
            users.push({ role: 'member', email: targetEmail, source: 'bulk_action', joined_at: new Date().toISOString() });
            await pool.query(
              `UPDATE m365_group_memberships SET users = $1::jsonb WHERE id = $2`,
              [JSON.stringify(users), group.id]
            );
          }
          result = { success: true, group: group.group_name };
        }

        results.push({ email: targetEmail, ...result });
      } catch (err) {
        results.push({ email: targetEmail, success: false, error: err.message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed    = results.filter(r => !r.success).length;

    return {
      bulkAction: action,
      total: emails.length,
      succeeded,
      failed,
      results,
    };
  });
}

// ── Access request executors ──────────────────────────────────────────────────

async function executeSubmitAccessRequest(pool, email, fnArgs, sessionId) {
  const { resource_type, resource_name, reason, requested_for_email } = fnArgs;
  const targetEmail = requested_for_email || email;

  const title = `Access request: ${resource_type} — ${resource_name}`;
  const description =
    `Request for ${targetEmail} to access "${resource_name}" (${resource_type}).\n` +
    `Reason: ${reason}`;

  // Insert access request (status = pending)
  const { rows: [request] } = await pool.query(
    `INSERT INTO access_requests
       (requested_for, requested_by, resource_type, resource_name, reason, session_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [targetEmail, email, resource_type, resource_name, reason, sessionId || null]
  );

  // Create an open agent ticket as the paper trail
  const { rows: [ticket] } = await pool.query(
    `INSERT INTO agent_tickets (email, title, description, status, session_id)
     VALUES ($1, $2, $3, 'open', $4) RETURNING *`,
    [targetEmail, title, `${description}\n\nAccess request ID: ${request.id}`, sessionId || null]
  );

  return {
    ticket,
    actionResult: {
      submitted: true,
      requestId: request.id,
      requestStatus: 'pending',
      requestedFor: targetEmail,
      resourceType: resource_type,
      resourceName: resource_name,
    },
  };
}

async function executeListAccessRequests(pool, fnArgs) {
  const rawStatus = fnArgs.status || 'pending';
  const ALLOWED_STATUSES = ['pending', 'approved', 'rejected'];
  const statusFilter = ALLOWED_STATUSES.includes(rawStatus) ? rawStatus : null;
  const limit = Number.isInteger(fnArgs.limit) ? Math.min(Math.max(fnArgs.limit, 1), 50) : 10;

  let rows;
  if (!statusFilter) {
    // 'all' — no status filter
    ({ rows } = await pool.query(
      `SELECT id, requested_for, requested_by, resource_type, resource_name,
              reason, status, approver_note, created_at, updated_at
       FROM access_requests
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT id, requested_for, requested_by, resource_type, resource_name,
              reason, status, approver_note, created_at, updated_at
       FROM access_requests
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [statusFilter, limit]
    ));
  }

  return { status: rawStatus, count: rows.length, requests: rows };
}

async function executeApproveAccessRequest(pool, email, fnArgs, sessionId) {
  const { request_id, approver_note } = fnArgs;
  if (!Number.isInteger(request_id)) throw new Error('request_id must be an integer.');

  const { rows: [request] } = await pool.query(
    `SELECT * FROM access_requests WHERE id = $1 AND status = 'pending'`,
    [request_id]
  );
  if (!request) throw new Error(`Access request #${request_id} not found or already processed.`);

  const title = `Approve access request #${request_id} — ${request.resource_name}`;
  const description =
    `Approving request for ${request.requested_for} to access "${request.resource_name}" (${request.resource_type}).\n` +
    `Approver note: ${approver_note || 'Approved'}`;

  return createAndCloseTicket(pool, request.requested_for, title, description, sessionId, async () => {
    const steps = [];

    // Execute the provisioning action based on resource type
    if (request.resource_type === 'distribution_group') {
      const { rows: groups } = await pool.query(
        `SELECT id, name, contacts FROM distribution_groups
         WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
        [`%${escapeLike(request.resource_name)}%`]
      );
      if (groups.length > 0) {
        const group = groups[0];
        const contacts = group.contacts || [];
        if (!contacts.some(c => c.email?.toLowerCase() === request.requested_for.toLowerCase())) {
          contacts.push({ first_name: request.requested_for.split('@')[0], last_name: '', email: request.requested_for });
          await pool.query(
            `UPDATE distribution_groups SET contacts = $1::jsonb WHERE id = $2`,
            [JSON.stringify(contacts), group.id]
          );
        }
        steps.push(`Added to distribution group: ${group.name}`);
      }
    } else if (request.resource_type === 'm365_group') {
      const { rows: groups } = await pool.query(
        `SELECT id, group_name, users FROM m365_group_memberships
         WHERE LOWER(group_name) LIKE LOWER($1) LIMIT 1`,
        [`%${escapeLike(request.resource_name)}%`]
      );
      if (groups.length > 0) {
        const group = groups[0];
        const users = group.users || [];
        if (!users.some(u => u.email?.toLowerCase() === request.requested_for.toLowerCase())) {
          users.push({
            role: 'member',
            email: request.requested_for,
            source: 'access_request',
            joined_at: new Date().toISOString(),
          });
          await pool.query(
            `UPDATE m365_group_memberships SET users = $1::jsonb WHERE id = $2`,
            [JSON.stringify(users), group.id]
          );
        }
        steps.push(`Added to M365 group: ${group.group_name}`);
      }
    } else if (request.resource_type === 'license') {
      steps.push(`${request.resource_name} license assigned`);
    } else if (request.resource_type === 'sharepoint') {
      steps.push(`SharePoint access granted for: ${request.resource_name}`);
    }

    // Mark request as approved
    await pool.query(
      `UPDATE access_requests
       SET status = 'approved', approver_note = $1, updated_at = now()
       WHERE id = $2`,
      [approver_note || 'Approved', request_id]
    );

    return {
      approved: true,
      requestId: request_id,
      requestedFor: request.requested_for,
      resourceType: request.resource_type,
      resourceName: request.resource_name,
      steps,
    };
  });
}

// ── Department template executors ─────────────────────────────────────────────

async function executeApplyAccessTemplate(pool, email, fnArgs, sessionId, records) {
  const { department, reason } = fnArgs;
  const template = ACCESS_TEMPLATES[department];
  if (!template) {
    throw new Error(
      `Unknown department template: "${department}". ` +
      `Call list_access_templates to see valid options.`
    );
  }

  const userRecord = (records || []).find(r => r.firstName && r.email);
  const firstName  = userRecord?.firstName || email.split('@')[0];
  const lastName   = userRecord?.lastName  || '';
  const primarySystem = template.primary_system || 'active_directory';

  const title = `Apply access template — ${template.label}`;
  const description =
    `Apply "${template.label}" access template to ${email}.\n` +
    `Reason: ${reason || 'Department access standardisation'}`;

  return createAndCloseTicket(pool, email, title, description, sessionId, async () => {
    const steps = [];

    // Assign license
    if (template.license) {
      steps.push(`Assigned ${template.license} license`);
    }

    // Add to distribution groups
    for (const groupName of (template.distribution_groups || [])) {
      const { rows: groups } = await pool.query(
        `SELECT id, name, contacts FROM distribution_groups
         WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
        [`%${escapeLike(groupName)}%`]
      );
      if (groups.length > 0) {
        const group = groups[0];
        const contacts = group.contacts || [];
        if (!contacts.some(c => c.email?.toLowerCase() === email.toLowerCase())) {
          contacts.push({ first_name: firstName, last_name: lastName, email });
          await pool.query(
            `UPDATE distribution_groups SET contacts = $1::jsonb WHERE id = $2`,
            [JSON.stringify(contacts), group.id]
          );
          steps.push(`Added to distribution group: ${group.name}`);
        } else {
          steps.push(`Already in distribution group: ${group.name}`);
        }
      } else {
        steps.push(`Distribution group not found (will create in production): ${groupName}`);
      }
    }

    // Add to M365 groups
    for (const groupName of (template.m365_groups || [])) {
      const { rows: groups } = await pool.query(
        `SELECT id, group_name, users FROM m365_group_memberships
         WHERE LOWER(group_name) LIKE LOWER($1) LIMIT 1`,
        [`%${escapeLike(groupName)}%`]
      );
      if (groups.length > 0) {
        const group = groups[0];
        const users = group.users || [];
        if (!users.some(u => u.email?.toLowerCase() === email.toLowerCase())) {
          users.push({ role: 'member', email, source: primarySystem, joined_at: new Date().toISOString() });
          await pool.query(
            `UPDATE m365_group_memberships SET users = $1::jsonb WHERE id = $2`,
            [JSON.stringify(users), group.id]
          );
          steps.push(`Added to M365 group: ${group.group_name}`);
        } else {
          steps.push(`Already in M365 group: ${group.group_name}`);
        }
      } else {
        steps.push(`M365 group not found (will create in production): ${groupName}`);
      }
    }

    return {
      templateApplied: true,
      email,
      department: template.label,
      stepsCompleted: steps.length,
      steps,
    };
  });
}

function executeListAccessTemplates() {
  return {
    templates: Object.entries(ACCESS_TEMPLATES).map(([key, t]) => ({
      key,
      label: t.label,
      description: t.description,
      license: t.license || 'None',
      distribution_groups: t.distribution_groups,
      m365_groups: t.m365_groups,
    })),
    note: 'Use the key value (e.g. "service_desk") when calling apply_access_template or onboard_user.',
  };
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
- **reset_mfa**: Reset the user's Microsoft 365 MFA registration so they can re-register.
- **get_mfa_status**: Check registered Microsoft 365 MFA/authentication methods. Read-only; no ticket is created.
- **assign_license**: Assign a Microsoft 365 license to the user.
- **remove_license**: Remove a Microsoft 365 license from the user.
- **grant_mailbox_access**: Grant delegate mailbox access.
- **add_email_alias**: Add an email alias/proxy address.
- **get_out_of_office**: Check the user's out-of-office setting. Read-only; no ticket is created.
- **set_out_of_office**: Set the user's out-of-office message.
- **add_to_teams_channel**: Add the user to a Teams channel.
- **grant_onedrive_access**: Grant another user access to this user's OneDrive.
- **list_inactive_licenses**: Find likely unused Microsoft 365 licenses and estimate monthly savings. Read-only; no ticket is created.
- **list_stale_guests**: Find stale guest/external accounts. Read-only; no ticket is created.
- **revoke_guest_access**: Revoke a stale guest/external user's access. Creates and auto-closes a ticket on success.
- **dismiss_risky_user**: Dismiss a Microsoft Entra risky-user flag after investigation.
- **list_app_consents**: List OAuth app consent grants for a user. Read-only; no ticket is created.
- **revoke_app_consent**: Revoke an OAuth app consent grant.
- **explain_ca_block**: Explain likely Conditional Access policy blocks. Read-only; no ticket is created.
- **get_device_compliance**: Get Intune managed-device compliance details. Read-only; no ticket is created.
- **get_bitlocker_key**: Retrieve a BitLocker recovery key with a ticket audit trail.

LIFECYCLE MANAGEMENT:
- **onboard_user**: Complete new-hire onboarding in one action — provision accounts in all required systems, assign the department standard license, add to distribution groups and M365 groups. Pass first_name, last_name, email, and department. Use list_access_templates to confirm the department key first if unsure.
- **offboard_user**: Complete offboarding in one action — disable all accounts, remove from all groups and SharePoint, reclaim licenses, set out-of-office. Always prefer this over running disable_account individually for a departing user.
- **deprovision_cascade**: For a user who is already disabled but still has downstream access — removes from all groups, revokes SharePoint permissions, reclaims licenses. Use after disable_account when cleanup was not done at the same time.

BULK OPERATIONS:
- **bulk_action**: Apply one action to a list of email addresses. Supported actions: disable_account, assign_license, remove_license, add_to_group, add_to_m365_group, reset_password. Pass action_params for group or license details. Use when the user provides multiple names or emails for the same change.

ACCESS REQUESTS:
- **submit_access_request**: Log a self-service access request for a distribution_group, license, sharepoint site, or m365_group. The request stays pending until approved — no access is granted immediately. Creates an open ticket.
- **list_access_requests**: Show access requests filtered by status (pending / approved / rejected / all).
- **approve_access_request**: Approve a pending request by ID and execute the provisioning immediately. Use this after the approver confirms.

DEPARTMENT TEMPLATES:
- **list_access_templates**: Show all available department templates (keys, labels, license, groups). Always call this before apply_access_template if the department key is unknown.
- **apply_access_template**: Apply a department template to the displayed user — assigns the standard license and adds to all standard groups for that department. Pass the department key from list_access_templates.

- **create_ticket**: Only use this as a fallback for requests that don't fit the above tools.

Each action tool will: create a ticket → execute the action → auto-close the ticket if successful. If the action fails, the ticket stays open for manual follow-up.

CROSS-SYSTEM AWARENESS:
- The user context shows which systems the user exists in and which they are missing from.
- You can provision accounts across systems (e.g. a user who only has a NetForum account can be provisioned into Active Directory).
- You can add any user to a distribution group or M365 group regardless of which system(s) they currently exist in.
- When provisioning cross-system, extract name and email from whichever source record is available.
- Microsoft 365 governance tools may inspect tenant-level data, not just the displayed user. Clearly state when results are local demo estimates rather than live Graph data.

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
  let toolResultContent;
  let ticket;

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

    case 'reset_mfa': {
      const { ticket: t, actionResult } = await executeResetMfa(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.reset || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'reset_mfa',
        ...actionResult,
      });
      break;
    }

    case 'get_mfa_status': {
      const actionResult = await executeGetMfaStatus(pool, email);
      toolResultContent = JSON.stringify({
        success: true,
        action: 'get_mfa_status',
        ...actionResult,
      });
      break;
    }

    case 'assign_license': {
      const { ticket: t, actionResult } = await executeAssignLicense(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.assigned || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'assign_license',
        ...actionResult,
      });
      break;
    }

    case 'remove_license': {
      const { ticket: t, actionResult } = await executeRemoveLicense(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.removed || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'remove_license',
        ...actionResult,
      });
      break;
    }

    case 'grant_mailbox_access': {
      const { ticket: t, actionResult } = await executeGrantMailboxAccess(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.granted || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'grant_mailbox_access',
        ...actionResult,
      });
      break;
    }

    case 'add_email_alias': {
      const { ticket: t, actionResult } = await executeAddEmailAlias(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.added || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'add_email_alias',
        ...actionResult,
      });
      break;
    }

    case 'get_out_of_office': {
      const actionResult = await executeGetOutOfOffice(pool, email);
      toolResultContent = JSON.stringify({
        success: true,
        action: 'get_out_of_office',
        ...actionResult,
      });
      break;
    }

    case 'set_out_of_office': {
      const { ticket: t, actionResult } = await executeSetOutOfOffice(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.updated || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'set_out_of_office',
        ...actionResult,
      });
      break;
    }

    case 'add_to_teams_channel': {
      const { ticket: t, actionResult } = await executeAddToTeamsChannel(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.added || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'add_to_teams_channel',
        ...actionResult,
      });
      break;
    }

    case 'grant_onedrive_access': {
      const { ticket: t, actionResult } = await executeGrantOneDriveAccess(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.granted || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'grant_onedrive_access',
        ...actionResult,
      });
      break;
    }

    case 'list_inactive_licenses': {
      const actionResult = await executeListInactiveLicenses(pool, fnArgs);
      toolResultContent = JSON.stringify({
        success: true,
        action: 'list_inactive_licenses',
        ...actionResult,
      });
      break;
    }

    case 'list_stale_guests': {
      const actionResult = await executeListStaleGuests(pool, fnArgs);
      toolResultContent = JSON.stringify({
        success: true,
        action: 'list_stale_guests',
        ...actionResult,
      });
      break;
    }

    case 'revoke_guest_access': {
      const { ticket: t, actionResult } = await executeRevokeGuestAccess(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.revoked || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'revoke_guest_access',
        ...actionResult,
      });
      break;
    }

    case 'dismiss_risky_user': {
      const { ticket: t, actionResult } = await executeDismissRiskyUser(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.dismissed || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'dismiss_risky_user',
        ...actionResult,
      });
      break;
    }

    case 'list_app_consents': {
      const actionResult = await executeListAppConsents(pool, email, fnArgs);
      toolResultContent = JSON.stringify({
        success: true,
        action: 'list_app_consents',
        ...actionResult,
      });
      break;
    }

    case 'revoke_app_consent': {
      const { ticket: t, actionResult } = await executeRevokeAppConsent(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.revoked || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'revoke_app_consent',
        ...actionResult,
      });
      break;
    }

    case 'explain_ca_block': {
      const actionResult = await executeExplainCaBlock(pool, email, fnArgs);
      toolResultContent = JSON.stringify({
        success: true,
        action: 'explain_ca_block',
        ...actionResult,
      });
      break;
    }

    case 'get_device_compliance': {
      const actionResult = await executeGetDeviceCompliance(pool, email, fnArgs);
      toolResultContent = JSON.stringify({
        success: true,
        action: 'get_device_compliance',
        ...actionResult,
      });
      break;
    }

    case 'get_bitlocker_key': {
      const { ticket: t, actionResult } = await executeGetBitlockerKey(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.retrieved || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'get_bitlocker_key',
        ...actionResult,
      });
      break;
    }

    case 'onboard_user': {
      const { ticket: t, actionResult } = await executeOnboardUser(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.onboarded || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'onboard_user',
        ...actionResult,
      });
      break;
    }

    case 'offboard_user': {
      const { ticket: t, actionResult } = await executeOffboardUser(pool, email, fnArgs, sessionId, records);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.offboarded || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'offboard_user',
        ...actionResult,
      });
      break;
    }

    case 'deprovision_cascade': {
      const { ticket: t, actionResult } = await executeDeprovisionCascade(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.cascaded || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'deprovision_cascade',
        ...actionResult,
      });
      break;
    }

    case 'bulk_action': {
      const { ticket: t, actionResult } = await executeBulkAction(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.succeeded > 0,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'bulk_action',
        ...actionResult,
      });
      break;
    }

    case 'submit_access_request': {
      const { ticket: t, actionResult } = await executeSubmitAccessRequest(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.submitted || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'submit_access_request',
        ...actionResult,
      });
      break;
    }

    case 'list_access_requests': {
      const actionResult = await executeListAccessRequests(pool, fnArgs);
      toolResultContent = JSON.stringify({
        success: true,
        action: 'list_access_requests',
        ...actionResult,
      });
      break;
    }

    case 'approve_access_request': {
      const { ticket: t, actionResult } = await executeApproveAccessRequest(pool, email, fnArgs, sessionId);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.approved || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'approve_access_request',
        ...actionResult,
      });
      break;
    }

    case 'apply_access_template': {
      const { ticket: t, actionResult } = await executeApplyAccessTemplate(pool, email, fnArgs, sessionId, records);
      ticket = t;
      toolResultContent = JSON.stringify({
        success: actionResult.templateApplied || false,
        ticketId: t.id,
        ticketStatus: t.status,
        action: 'apply_access_template',
        ...actionResult,
      });
      break;
    }

    case 'list_access_templates': {
      const actionResult = executeListAccessTemplates();
      toolResultContent = JSON.stringify({
        success: true,
        action: 'list_access_templates',
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
        capability_groups: [
          {
            group: 'Account Operations',
            capabilities: [
              'Provision a new account in Active Directory, NetForum, or External Users — supports cross-system provisioning. Executed immediately with auto-closed ticket.',
              'Disable a user account across all systems — executed immediately.',
              'Reset a password in Active Directory — executed immediately.',
              'Update a specific attribute (email, name, type, sponsor) in a target system — executed immediately.',
            ],
          },
          {
            group: 'Lifecycle Management',
            capabilities: [
              'Onboard a new hire end-to-end: provision accounts, assign license, add to department groups — single action covering all systems.',
              'Offboard a departing user end-to-end: disable all accounts, remove from all groups, revoke SharePoint permissions, reclaim licenses, set out-of-office — single action.',
              'Deprovisioning cascade: for an already-disabled user, clean up all downstream access (groups, SharePoint, licenses) in one action.',
            ],
          },
          {
            group: 'Group & Membership Management',
            capabilities: [
              'Add a user to a distribution group (mailing list) — executed immediately.',
              'Add a user to a Microsoft 365 group (M365, Security, or Teams group) — executed immediately with configurable role.',
              'Add a user to a Teams channel — executed immediately.',
            ],
          },
          {
            group: 'Bulk Operations',
            capabilities: [
              'Apply a single action to a list of users — disable multiple leavers, add a team to a group, assign licenses to a cohort, or reset passwords for a department in one request.',
            ],
          },
          {
            group: 'Microsoft 365 Service Desk',
            capabilities: [
              'Reset or check Microsoft 365 MFA registration.',
              'Assign or remove Microsoft 365 licenses.',
              'Grant mailbox delegate access.',
              'Add an email alias.',
              'Check or set out-of-office.',
              'Grant OneDrive access.',
            ],
          },
          {
            group: 'Access Requests',
            capabilities: [
              'Submit a self-service access request for a group, license, SharePoint site, or M365 group — logged as pending, requires approval.',
              'List pending (or all) access requests.',
              'Approve a pending access request and execute the provisioning automatically.',
            ],
          },
          {
            group: 'Department Access Templates',
            capabilities: [
              'List all available department templates — shows what license, distribution groups, and M365 groups each one provisions.',
              'Apply a department template to a user — assigns the standard set of access for that role in one action.',
            ],
          },
          {
            group: 'Governance & Security',
            capabilities: [
              'List inactive Microsoft 365 licenses with estimated monthly savings — read-only.',
              'List stale guest/external accounts — read-only.',
              'Revoke stale guest access.',
              'Dismiss Microsoft Entra risky-user flags.',
              'List and revoke OAuth app consents.',
              'Explain Conditional Access blocks — read-only.',
              'Get Intune device compliance details — read-only.',
              'Retrieve BitLocker recovery keys — full audit trail.',
            ],
          },
          {
            group: 'Ticketing',
            capabilities: [
              'Create a general service ticket for anything else — stays open for manual follow-up.',
              'List open tickets for the current user.',
            ],
          },
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
