-- Phase 16 round-2: serialize task, approval, artifact supersession, and finalization state.

CREATE OR REPLACE FUNCTION phase16_stale_superseded_approvals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  locked_task_id VARCHAR(50);
BEGIN
  IF NEW.task_id IS NOT NULL AND NEW.artifact_type = 'CANDIDATE_COMMIT' THEN
    -- The finalization path locks an approval before it locks the task row.
    -- Keep the same order here to avoid a task/approval deadlock.
    PERFORM id
    FROM approvals
    WHERE task_id = NEW.task_id
      AND artifact_id IS DISTINCT FROM NEW.id
      AND status IN ('PENDING', 'APPROVED')
      AND artifact_id IS NOT NULL
    ORDER BY id
    FOR UPDATE;

    SELECT id INTO locked_task_id
    FROM tasks
    WHERE id = NEW.task_id
    FOR UPDATE;

    IF EXISTS (
      SELECT 1 FROM workspace_finalizations
      WHERE task_id = NEW.task_id AND status = 'CLAIMED'
    ) THEN
      RAISE EXCEPTION 'candidate artifact cannot supersede an active finalization claim' USING ERRCODE = '55000';
    END IF;
    UPDATE approvals
    SET status = 'STALE',
        reason = COALESCE(reason, 'superseded by artifact ' || NEW.id),
        updated_at = CURRENT_TIMESTAMP
    WHERE task_id = NEW.task_id
      AND artifact_id IS DISTINCT FROM NEW.id
      AND status IN ('PENDING', 'APPROVED')
      AND artifact_id IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION phase16_validate_finalization_task_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  approval_task_id VARCHAR(50);
  expected_state TEXT;
  expected_version BIGINT;
  current_state TEXT;
  current_version BIGINT;
BEGIN
  SELECT task_id, expected_task_state, expected_task_version
  INTO approval_task_id, expected_state, expected_version
  FROM approvals
  WHERE id = NEW.approval_id
  FOR UPDATE;

  IF NOT FOUND
     OR approval_task_id IS NULL
     OR approval_task_id IS DISTINCT FROM NEW.task_id
     OR expected_state IS NULL
     OR expected_version IS NULL THEN
    RAISE EXCEPTION 'finalization approval does not bind a valid task state' USING ERRCODE = '55000';
  END IF;

  SELECT status, row_version
  INTO current_state, current_version
  FROM tasks
  WHERE id = NEW.task_id
  FOR UPDATE;

  IF NOT FOUND
     OR current_state IS DISTINCT FROM expected_state
     OR current_version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'task state or version does not match approval expectation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_phase16_validate_finalization_task_state
BEFORE INSERT ON workspace_finalizations
FOR EACH ROW EXECUTE FUNCTION phase16_validate_finalization_task_state();

CREATE OR REPLACE FUNCTION phase16_guard_claimed_task_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.status, OLD.row_version) IS DISTINCT FROM (NEW.status, NEW.row_version)
     AND EXISTS (
       SELECT 1
       FROM workspace_finalizations
       WHERE task_id = OLD.id AND status = 'CLAIMED'
     ) THEN
    RAISE EXCEPTION 'task state cannot change during an active finalization claim' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_phase16_guard_claimed_task_state
BEFORE UPDATE OF status, row_version ON tasks
FOR EACH ROW EXECUTE FUNCTION phase16_guard_claimed_task_state();

CREATE OR REPLACE FUNCTION reconcile_candidate_finalization(
  p_finalization_id TEXT,
  p_expected_status TEXT,
  p_terminal_status TEXT,
  p_observed_ref_sha TEXT,
  p_incident_evidence JSONB,
  p_actor_id TEXT
)
RETURNS workspace_finalizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  finalization_row workspace_finalizations%ROWTYPE;
BEGIN
  IF p_expected_status NOT IN ('CLAIMED', 'NEEDS_RECONCILIATION')
     OR p_terminal_status NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'unsupported finalization reconciliation transition' USING ERRCODE = '22023';
  END IF;
  IF p_incident_evidence IS NULL
     OR jsonb_typeof(p_incident_evidence) <> 'object'
     OR COALESCE(p_incident_evidence->>'incidentId', '') = ''
     OR COALESCE(p_incident_evidence->>'rationale', '') = '' THEN
    RAISE EXCEPTION 'incidentId and rationale are required for finalization reconciliation' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO finalization_row
  FROM workspace_finalizations
  WHERE id = p_finalization_id
  FOR UPDATE;
  IF NOT FOUND OR finalization_row.status <> p_expected_status THEN
    RAISE EXCEPTION 'finalization reconciliation compare-and-set failed' USING ERRCODE = '55000';
  END IF;
  IF p_terminal_status = 'SUCCEEDED'
     AND p_observed_ref_sha IS DISTINCT FROM finalization_row.candidate_commit_sha THEN
    RAISE EXCEPTION 'observed canonical ref does not match the approved candidate' USING ERRCODE = '55000';
  END IF;
  IF p_terminal_status = 'FAILED' AND p_observed_ref_sha IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED reconciliation must not record an integrated ref' USING ERRCODE = '22023';
  END IF;

  UPDATE workspace_finalizations
  SET status = p_terminal_status,
      integrated_commit_sha = CASE WHEN p_terminal_status = 'SUCCEEDED' THEN p_observed_ref_sha ELSE NULL END,
      error_message = CASE WHEN p_terminal_status = 'FAILED' THEN p_incident_evidence->>'rationale' ELSE NULL END,
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_finalization_id AND status = p_expected_status
  RETURNING * INTO finalization_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalization reconciliation compare-and-set failed' USING ERRCODE = '55000';
  END IF;

  UPDATE workspace_leases
  SET released_at = COALESCE(released_at, CURRENT_TIMESTAMP)
  WHERE lease_id = finalization_row.lease_id;

  INSERT INTO workspace_safety_events(
    workspace_id, task_id, finalization_id, event_type, actor_id, event_payload
  ) VALUES (
    finalization_row.workspace_id,
    finalization_row.task_id,
    finalization_row.id,
    'FINALIZATION_RECONCILED_' || p_terminal_status,
    p_actor_id,
    jsonb_build_object(
      'observedRefSha', p_observed_ref_sha,
      'incidentEvidence', p_incident_evidence,
      'previousStatus', p_expected_status
    )
  );
  RETURN finalization_row;
END;
$$;

REVOKE ALL ON FUNCTION phase16_stale_superseded_approvals() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase16_validate_finalization_task_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase16_guard_claimed_task_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_candidate_finalization(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
