-- Real system-event-driven governance evaluation: these triggers fire on the
-- actual data writes (ETL syncs, agent tool calls, manual SQL) rather than
-- waiting for a chat message or the daily/manual scan. They cover the two
-- single-row-scoped checks (naming convention, zero-owner groups); site-level
-- aggregate checks (SharePoint orphan/oversharing) remain on the batch scan
-- in runGovernanceScan(), since those need to look across many rows.
--
-- They also auto-propose a remediation (remediation_status = 'proposed') for
-- fixable violations, same as the JS batch scan — nothing is ever applied
-- without an explicit approve_remediation call; see 24_remediation_proposals.sql.

CREATE OR REPLACE FUNCTION trg_evaluate_group_governance() RETURNS TRIGGER AS $$
DECLARE
  v_group_type      TEXT;
  v_group_name      TEXT;
  v_old_name        TEXT;
  v_group_email     TEXT;
  v_resource_type   TEXT;
  v_expected_prefix TEXT;
  v_owner_count     INTEGER;
  v_owner_email     TEXT;
  v_candidate_email TEXT;
BEGIN
  IF TG_TABLE_NAME = 'm365_group_memberships' THEN
    v_group_type    := NEW.group_type;
    v_group_name    := NEW.group_name;
    v_group_email   := NEW.group_email;
    v_resource_type := 'm365_group';
    v_old_name      := CASE WHEN TG_OP = 'UPDATE' THEN OLD.group_name ELSE NULL END;
    SELECT count(*) FILTER (WHERE u->>'role' = 'owner'),
           (array_agg(u->>'email') FILTER (WHERE u->>'role' = 'owner'))[1],
           (array_agg(u->>'email' ORDER BY (u->>'joined_at')::timestamptz ASC NULLS LAST))[1]
      INTO v_owner_count, v_owner_email, v_candidate_email
      FROM jsonb_array_elements(NEW.users) u;
  ELSE
    v_group_type    := 'Distribution';
    v_group_name    := NEW.name;
    v_group_email   := NEW.email;
    v_resource_type := 'distribution_group';
    v_old_name      := CASE WHEN TG_OP = 'UPDATE' THEN OLD.name ELSE NULL END;
    v_owner_count   := NULL; -- distribution_groups has no owner concept
    v_owner_email   := NULL;
    v_candidate_email := NULL;
  END IF;

  v_expected_prefix := CASE v_group_type
    WHEN 'Distribution' THEN 'DL-'
    WHEN 'Security'     THEN 'SG-'
    WHEN 'Microsoft365' THEN 'M365-'
    ELSE NULL
  END;

  -- naming_convention
  IF v_expected_prefix IS NOT NULL AND left(upper(v_group_name), length(v_expected_prefix)) <> upper(v_expected_prefix) THEN
    INSERT INTO governance_violations (violation_type, resource_type, resource_name, resource_id, severity, details, assigned_to,
                                        remediation_action, remediation_params, remediation_status, remediation_requested_at)
    VALUES ('naming_convention', v_resource_type, v_group_name, v_group_email, 'low',
            jsonb_build_object('expectedPrefix', v_expected_prefix, 'groupType', v_group_type, 'trigger', TG_TABLE_NAME),
            v_owner_email,
            'rename_group', jsonb_build_object('newName', v_expected_prefix || v_group_name), 'proposed', now())
    ON CONFLICT (violation_type, resource_type, resource_name) DO UPDATE SET
      resource_id = EXCLUDED.resource_id,
      details     = EXCLUDED.details,
      assigned_to = COALESCE(governance_violations.assigned_to, EXCLUDED.assigned_to),
      status      = CASE WHEN governance_violations.status = 'resolved' THEN 'open' ELSE governance_violations.status END,
      resolved_at = CASE WHEN governance_violations.status = 'resolved' THEN NULL ELSE governance_violations.resolved_at END,
      remediation_action = CASE
        WHEN governance_violations.status = 'resolved'
          OR governance_violations.remediation_status IS NULL OR governance_violations.remediation_status = 'none'
        THEN EXCLUDED.remediation_action ELSE governance_violations.remediation_action END,
      remediation_params = CASE
        WHEN governance_violations.status = 'resolved'
          OR governance_violations.remediation_status IS NULL OR governance_violations.remediation_status = 'none'
        THEN EXCLUDED.remediation_params ELSE governance_violations.remediation_params END,
      remediation_status = CASE
        WHEN governance_violations.status = 'resolved'
          OR governance_violations.remediation_status IS NULL OR governance_violations.remediation_status = 'none'
        THEN 'proposed' ELSE governance_violations.remediation_status END,
      remediation_requested_at = CASE
        WHEN governance_violations.status = 'resolved'
          OR governance_violations.remediation_status IS NULL OR governance_violations.remediation_status = 'none'
        THEN now() ELSE governance_violations.remediation_requested_at END,
      updated_at  = now();
    -- Renamed into compliance under a different name while a prior violation still exists under the old one
    IF v_old_name IS NOT NULL AND v_old_name <> v_group_name THEN
      UPDATE governance_violations
      SET status = 'resolved', resolved_at = now(),
          resolution_note = 'Auto-resolved: renamed (trigger)', updated_at = now()
      WHERE violation_type = 'naming_convention' AND resource_type = v_resource_type AND resource_name = v_old_name
        AND status IN ('open', 'acknowledged');
    END IF;
  ELSE
    UPDATE governance_violations
    SET status = 'resolved', resolved_at = now(),
        resolution_note = 'Auto-resolved: fixed at write-time (trigger)', updated_at = now()
    WHERE violation_type = 'naming_convention' AND resource_type = v_resource_type
      AND resource_name IN (v_group_name, COALESCE(v_old_name, v_group_name))
      AND status IN ('open', 'acknowledged');
  END IF;

  -- orphaned_resource (M365 groups only — distribution_groups has no owner concept)
  IF TG_TABLE_NAME = 'm365_group_memberships' THEN
    IF v_owner_count = 0 THEN
      INSERT INTO governance_violations (violation_type, resource_type, resource_name, resource_id, severity, details,
                                          remediation_action, remediation_params, remediation_status, remediation_requested_at)
      VALUES ('orphaned_resource', 'm365_group', v_group_name, v_group_email, 'high',
              jsonb_build_object('groupType', v_group_type, 'trigger', TG_TABLE_NAME),
              CASE WHEN v_candidate_email IS NOT NULL THEN 'reassign_owner' ELSE NULL END,
              CASE WHEN v_candidate_email IS NOT NULL THEN jsonb_build_object('resourceType', 'm365_group', 'suggestedOwner', v_candidate_email) ELSE NULL END,
              CASE WHEN v_candidate_email IS NOT NULL THEN 'proposed' ELSE 'none' END,
              CASE WHEN v_candidate_email IS NOT NULL THEN now() ELSE NULL END)
      ON CONFLICT (violation_type, resource_type, resource_name) DO UPDATE SET
        resource_id = EXCLUDED.resource_id,
        details     = EXCLUDED.details,
        status      = CASE WHEN governance_violations.status = 'resolved' THEN 'open' ELSE governance_violations.status END,
        resolved_at = CASE WHEN governance_violations.status = 'resolved' THEN NULL ELSE governance_violations.resolved_at END,
        remediation_action = CASE
          WHEN governance_violations.status = 'resolved'
            OR governance_violations.remediation_status IS NULL OR governance_violations.remediation_status = 'none'
          THEN EXCLUDED.remediation_action ELSE governance_violations.remediation_action END,
        remediation_params = CASE
          WHEN governance_violations.status = 'resolved'
            OR governance_violations.remediation_status IS NULL OR governance_violations.remediation_status = 'none'
          THEN EXCLUDED.remediation_params ELSE governance_violations.remediation_params END,
        remediation_status = CASE
          WHEN EXCLUDED.remediation_action IS NULL THEN COALESCE(governance_violations.remediation_status, 'none')
          WHEN governance_violations.status = 'resolved'
            OR governance_violations.remediation_status IS NULL OR governance_violations.remediation_status = 'none'
          THEN 'proposed' ELSE governance_violations.remediation_status END,
        remediation_requested_at = CASE
          WHEN EXCLUDED.remediation_action IS NULL THEN governance_violations.remediation_requested_at
          WHEN governance_violations.status = 'resolved'
            OR governance_violations.remediation_status IS NULL OR governance_violations.remediation_status = 'none'
          THEN now() ELSE governance_violations.remediation_requested_at END,
        updated_at  = now();
      IF v_old_name IS NOT NULL AND v_old_name <> v_group_name THEN
        UPDATE governance_violations
        SET status = 'resolved', resolved_at = now(),
            resolution_note = 'Auto-resolved: renamed (trigger)', updated_at = now()
        WHERE violation_type = 'orphaned_resource' AND resource_type = 'm365_group' AND resource_name = v_old_name
          AND status IN ('open', 'acknowledged');
      END IF;
    ELSE
      UPDATE governance_violations
      SET status = 'resolved', resolved_at = now(),
          resolution_note = 'Auto-resolved: fixed at write-time (trigger)', updated_at = now()
      WHERE violation_type = 'orphaned_resource' AND resource_type = 'm365_group'
        AND resource_name IN (v_group_name, COALESCE(v_old_name, v_group_name))
        AND status IN ('open', 'acknowledged');
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_m365_group_governance ON m365_group_memberships;
CREATE TRIGGER trg_m365_group_governance
  AFTER INSERT OR UPDATE ON m365_group_memberships
  FOR EACH ROW EXECUTE FUNCTION trg_evaluate_group_governance();

DROP TRIGGER IF EXISTS trg_distribution_group_governance ON distribution_groups;
CREATE TRIGGER trg_distribution_group_governance
  AFTER INSERT OR UPDATE ON distribution_groups
  FOR EACH ROW EXECUTE FUNCTION trg_evaluate_group_governance();
