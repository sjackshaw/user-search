-- Self-service access request table for the user-card agent.
-- Supports item 6 (Self-Service Access Requests) from the high-impact
-- capability additions. Requests are created as 'pending', approved by
-- an operator, and the provisioning action is executed on approval.
--
-- In production, approval notifications would route through ServiceNow /
-- Jira and email the user's manager. For the PoC, status is managed here.

CREATE TABLE IF NOT EXISTS access_requests (
  id              SERIAL       PRIMARY KEY,
  requested_for   TEXT         NOT NULL,               -- email of the user being given access
  requested_by    TEXT,                                 -- email of the requester (if different)
  resource_type   TEXT         NOT NULL,               -- 'distribution_group' | 'license' | 'sharepoint' | 'm365_group'
  resource_name   TEXT         NOT NULL,               -- name of the group, license, or site
  reason          TEXT         NOT NULL,               -- business justification
  status          TEXT         NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  approver_note   TEXT,                                 -- optional note from the approver
  session_id      UUID,                                 -- chat session that submitted the request
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_requests_for_idx
  ON access_requests (requested_for, status, created_at DESC);

CREATE INDEX IF NOT EXISTS access_requests_status_idx
  ON access_requests (status, created_at DESC);
