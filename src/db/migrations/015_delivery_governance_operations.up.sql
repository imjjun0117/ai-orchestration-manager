-- Phase 15 operator-path hardening added after validation rework.

CREATE OR REPLACE FUNCTION replace_phase_assignment(
  p_phase_id TEXT,
  p_assignment_role TEXT,
  p_new_actor_id TEXT,
  p_reason TEXT,
  p_actor_id TEXT,
  p_credential_binding TEXT,
  p_expected_version BIGINT
)
RETURNS phase_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  phase_row delivery_phases%ROWTYPE;
  previous_assignment phase_assignments%ROWTYPE;
  new_assignment phase_assignments%ROWTYPE;
BEGIN
  IF p_assignment_role NOT IN ('WORKER', 'PLANNING_VALIDATOR', 'DEVELOPMENT_VALIDATOR', 'GATE_ADMIN') THEN
    RAISE EXCEPTION 'invalid assignment role %', p_assignment_role USING ERRCODE = '22023';
  END IF;
  IF NULLIF(BTRIM(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'assignment replacement reason is required' USING ERRCODE = '22023';
  END IF;
  PERFORM phase15_assert_assignment(p_phase_id, p_actor_id, p_credential_binding, 'GATE_ADMIN');

  SELECT * INTO phase_row
  FROM delivery_phases
  WHERE id = p_phase_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase % does not exist', p_phase_id USING ERRCODE = 'P0002';
  END IF;
  IF phase_row.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'phase % version mismatch: expected %, actual %',
      p_phase_id, p_expected_version, phase_row.row_version USING ERRCODE = '40001';
  END IF;
  IF phase_row.status IN ('ACCEPTED', 'ACCEPTED_WITH_DEBT', 'CANCELLED') THEN
    RAISE EXCEPTION 'phase % assignments are immutable from status %', p_phase_id, phase_row.status USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM delivery_actors
    WHERE id = p_new_actor_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'replacement actor % is not active', p_new_actor_id USING ERRCODE = '42501';
  END IF;

  SELECT * INTO previous_assignment
  FROM phase_assignments
  WHERE phase_id = p_phase_id
    AND assignment_role = p_assignment_role
    AND revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase % has no active % assignment', p_phase_id, p_assignment_role USING ERRCODE = 'P0002';
  END IF;
  IF previous_assignment.actor_id = p_new_actor_id THEN
    RAISE EXCEPTION 'actor % already owns % for phase %', p_new_actor_id, p_assignment_role, p_phase_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE phase_assignments
  SET revoked_at = CURRENT_TIMESTAMP,
      revoke_reason = p_reason,
      valid_until = COALESCE(valid_until, CURRENT_TIMESTAMP)
  WHERE id = previous_assignment.id;

  INSERT INTO phase_assignments(
    phase_id, actor_id, assignment_role, assigned_by_actor_id
  ) VALUES (
    p_phase_id, p_new_actor_id, p_assignment_role, p_actor_id
  )
  RETURNING * INTO new_assignment;

  UPDATE delivery_phases
  SET row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = p_phase_id;

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (
    p_phase_id,
    phase_row.latest_submission_id,
    'PHASE_ASSIGNMENT_REPLACED',
    p_actor_id,
    jsonb_build_object(
      'assignmentRole', p_assignment_role,
      'previousActorId', previous_assignment.actor_id,
      'newActorId', p_new_actor_id,
      'reason', p_reason
    )
  );

  RETURN new_assignment;
END;
$$;

REVOKE ALL ON FUNCTION replace_phase_assignment(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC;

DO $$
DECLARE
  function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT p.oid::regprocedure AS function_signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'phase15_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_record.function_signature);
  END LOOP;
END;
$$;
