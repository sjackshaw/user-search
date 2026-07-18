-- Chat storage for the GenAI conversational interface.
-- Part of the GenAI expansion: Phase 2 — Create Chat Storage Schema.

-- ── chat_messages ─────────────────────────────────────────────────────────────
-- Stores every message in a conversation. Each conversation is grouped by a
-- client-generated session_id (UUID). Rows are append-only; the UI replays
-- the full history for a session on reconnect.

CREATE TABLE IF NOT EXISTS chat_messages (
  id             SERIAL       PRIMARY KEY,
  session_id     UUID         NOT NULL,                 -- groups messages into a conversation
  role           TEXT         NOT NULL,                 -- 'user' | 'assistant'
  content        TEXT         NOT NULL,                 -- message body
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages (session_id, created_at);
