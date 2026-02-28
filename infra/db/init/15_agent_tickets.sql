-- Proof-of-concept ticketing table for the user-card agent.
-- Part of the Agentic AI Expansion: Phase 1 — Database & API.
--
-- In production this would be replaced by a ServiceNow / Jira integration.
-- For the PoC the agent writes tickets here instead of calling live external
-- systems, giving a safe demonstration of agentic actions.

-- ── agent_tickets ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_tickets (
  id           SERIAL       PRIMARY KEY,
  email        TEXT         NOT NULL,               -- user the ticket is about
  title        TEXT         NOT NULL,               -- short summary
  description  TEXT         NOT NULL,               -- detailed description
  status       TEXT         NOT NULL DEFAULT 'open', -- 'open' | 'closed'
  session_id   UUID,                                 -- chat session that created the ticket
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_tickets_email_idx
  ON agent_tickets (email, status, created_at DESC);
