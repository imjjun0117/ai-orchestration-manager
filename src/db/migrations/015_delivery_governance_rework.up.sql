-- Phase 15 validation rework.
-- Additive hardening for installations that already applied the immutable core migration.

CREATE UNIQUE INDEX IF NOT EXISTS uq_phase_assignment_active_actor
  ON phase_assignments(phase_id, actor_id)
  WHERE revoked_at IS NULL;

ALTER TABLE phase_submissions
  DROP CONSTRAINT IF EXISTS ck_phase_submission_base_commit_sha;
ALTER TABLE phase_submissions
  ADD CONSTRAINT ck_phase_submission_base_commit_sha
  CHECK (base_commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$');

ALTER TABLE phase_submissions
  DROP CONSTRAINT IF EXISTS ck_phase_submission_candidate_commit_sha;
ALTER TABLE phase_submissions
  ADD CONSTRAINT ck_phase_submission_candidate_commit_sha
  CHECK (candidate_commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$');

ALTER TABLE phase_debts
  ADD COLUMN IF NOT EXISTS risk_accepted_by_actor_id TEXT REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS risk_accepted_at TIMESTAMPTZ;

ALTER TABLE phase_debts
  DROP CONSTRAINT IF EXISTS ck_phase_debt_risk_acceptance;
ALTER TABLE phase_debts
  ADD CONSTRAINT ck_phase_debt_risk_acceptance CHECK (
    (risk_accepted_by_actor_id IS NULL AND risk_accepted_at IS NULL)
    OR
    (risk_accepted_by_actor_id = risk_owner_actor_id AND risk_accepted_at IS NOT NULL)
  );

ALTER TABLE phase_debt_approvals
  ADD COLUMN IF NOT EXISTS successor_safe BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS safety_rationale TEXT;

ALTER TABLE phase_debt_approvals
  DROP CONSTRAINT IF EXISTS ck_phase_debt_successor_safety;
ALTER TABLE phase_debt_approvals
  ADD CONSTRAINT ck_phase_debt_successor_safety CHECK (
    NOT successor_safe OR NULLIF(BTRIM(safety_rationale), '') IS NOT NULL
  );

CREATE TABLE IF NOT EXISTS phase_dependency_activations (
  phase_id TEXT NOT NULL,
  depends_on_phase_id TEXT NOT NULL,
  activated_by_submission_id TEXT NOT NULL REFERENCES phase_submissions(id) ON DELETE RESTRICT,
  activated_by_actor_id TEXT NOT NULL REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phase_id, depends_on_phase_id),
  FOREIGN KEY (phase_id, depends_on_phase_id)
    REFERENCES phase_dependencies(phase_id, depends_on_phase_id)
    ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION phase15_protect_sealed_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'SEALED' THEN
    RAISE EXCEPTION 'sealed phase submission % is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION phase15_protect_terminal_validation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.attempt_status IN ('COMPLETED', 'INFRA_FAILED', 'CANCELLED', 'STALE_ON_ARRIVAL') THEN
    RAISE EXCEPTION 'terminal phase validation % is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION phase15_assert_not_submission_worker(
  p_phase_submission_id TEXT,
  p_actor_id TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  submission_worker_actor_id TEXT;
BEGIN
  SELECT submitted_by_actor_id
    INTO submission_worker_actor_id
  FROM phase_submissions
  WHERE id = p_phase_submission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission % does not exist', p_phase_submission_id USING ERRCODE = 'P0002';
  END IF;
  IF submission_worker_actor_id = p_actor_id THEN
    RAISE EXCEPTION 'submission worker % cannot validate its own submission %',
      p_actor_id, p_phase_submission_id USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION phase15_refresh_validation_projection(p_phase_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  phase_row delivery_phases%ROWTYPE;
  planning_validation phase_validations%ROWTYPE;
  development_validation phase_validations%ROWTYPE;
  planning_status TEXT;
  development_status TEXT;
  projected_phase_status TEXT;
BEGIN
  SELECT * INTO phase_row
  FROM delivery_phases
  WHERE id = p_phase_id
  FOR UPDATE;

  IF NOT FOUND OR phase_row.latest_submission_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO planning_validation
  FROM phase_validations
  WHERE phase_submission_id = phase_row.latest_submission_id
    AND validator_type = 'PLANNING'
  ORDER BY validation_attempt DESC
  LIMIT 1;

  SELECT * INTO development_validation
  FROM phase_validations
  WHERE phase_submission_id = phase_row.latest_submission_id
    AND validator_type = 'DEVELOPMENT'
  ORDER BY validation_attempt DESC
  LIMIT 1;

  planning_status := CASE
    WHEN planning_validation.id IS NULL THEN 'PENDING'
    WHEN planning_validation.attempt_status IN ('PENDING', 'IN_PROGRESS') THEN planning_validation.attempt_status
    WHEN planning_validation.attempt_status = 'COMPLETED' THEN planning_validation.verdict
    WHEN planning_validation.attempt_status IN ('INFRA_FAILED', 'CANCELLED') THEN 'PENDING'
    ELSE 'STALE'
  END;
  development_status := CASE
    WHEN development_validation.id IS NULL THEN 'PENDING'
    WHEN development_validation.attempt_status IN ('PENDING', 'IN_PROGRESS') THEN development_validation.attempt_status
    WHEN development_validation.attempt_status = 'COMPLETED' THEN development_validation.verdict
    WHEN development_validation.attempt_status IN ('INFRA_FAILED', 'CANCELLED') THEN 'PENDING'
    ELSE 'STALE'
  END;

  projected_phase_status := CASE
    WHEN 'BLOCKED' IN (planning_status, development_status) THEN 'BLOCKED'
    WHEN 'CHANGES_REQUESTED' IN (planning_status, development_status) THEN 'CHANGES_REQUESTED'
    ELSE 'VALIDATION_IN_PROGRESS'
  END;

  UPDATE delivery_phases
  SET status = projected_phase_status,
      planning_validation_status = planning_status,
      development_validation_status = development_status,
      row_version = row_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_phase_id;
END;
$$;

CREATE OR REPLACE FUNCTION phase15_assert_dependencies_accepted(p_phase_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  blocked_dependency TEXT;
BEGIN
  SELECT d.depends_on_phase_id
    INTO blocked_dependency
  FROM phase_dependencies d
  JOIN delivery_phases predecessor ON predecessor.id = d.depends_on_phase_id
  LEFT JOIN phase_dependency_activations activation
    ON activation.phase_id = d.phase_id
   AND activation.depends_on_phase_id = d.depends_on_phase_id
  WHERE d.phase_id = p_phase_id
    AND (
      predecessor.status NOT IN ('ACCEPTED', 'ACCEPTED_WITH_DEBT')
      OR activation.phase_id IS NULL
      OR (
        predecessor.status = 'ACCEPTED_WITH_DEBT'
        AND EXISTS (
          SELECT 1
          FROM phase_debts debt
          JOIN phase_validation_findings finding ON finding.id = debt.finding_id
          JOIN phase_validations validation ON validation.id = finding.phase_validation_id
          JOIN phase_submissions submission ON submission.id = validation.phase_submission_id
          WHERE submission.phase_id = predecessor.id
            AND finding.status <> 'RESOLVED'
            AND (
              debt.risk_accepted_by_actor_id IS DISTINCT FROM debt.risk_owner_actor_id
              OR debt.risk_accepted_at IS NULL
              OR (
                SELECT COUNT(*)
                FROM phase_debt_approvals approval
                WHERE approval.debt_id = debt.id
                  AND approval.successor_safe
                  AND NULLIF(BTRIM(approval.safety_rationale), '') IS NOT NULL
              ) <> 2
            )
        )
      )
    )
  LIMIT 1;

  IF blocked_dependency IS NOT NULL THEN
    RAISE EXCEPTION 'phase % dependency % is not accepted and activated for safe succession',
      p_phase_id, blocked_dependency USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION start_phase_validation(
  p_validation_id TEXT,
  p_phase_submission_id TEXT,
  p_validator_type TEXT,
  p_validation_attempt INTEGER,
  p_actor_id TEXT,
  p_credential_binding TEXT
)
RETURNS phase_validations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  phase_id_value TEXT;
  latest_submission_id_value TEXT;
  submission_hash TEXT;
  submission_status TEXT;
  expected_attempt INTEGER;
  required_role TEXT;
  previous_attempt phase_validations%ROWTYPE;
  validation_row phase_validations%ROWTYPE;
BEGIN
  required_role := CASE p_validator_type
    WHEN 'PLANNING' THEN 'PLANNING_VALIDATOR'
    WHEN 'DEVELOPMENT' THEN 'DEVELOPMENT_VALIDATOR'
    ELSE NULL
  END;
  IF required_role IS NULL THEN
    RAISE EXCEPTION 'invalid validator type %', p_validator_type USING ERRCODE = '22023';
  END IF;

  SELECT s.phase_id, s.artifact_bundle_hash, s.status, p.latest_submission_id
    INTO phase_id_value, submission_hash, submission_status, latest_submission_id_value
  FROM phase_submissions s
  JOIN delivery_phases p ON p.id = s.phase_id
  WHERE s.id = p_phase_submission_id
  FOR UPDATE OF p, s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission % does not exist', p_phase_submission_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM phase15_assert_assignment(phase_id_value, p_actor_id, p_credential_binding, required_role);
  PERFORM phase15_assert_not_submission_worker(p_phase_submission_id, p_actor_id);

  IF latest_submission_id_value <> p_phase_submission_id OR submission_status <> 'SEALED' THEN
    RAISE EXCEPTION 'validation can start only for the latest sealed submission' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO previous_attempt
  FROM phase_validations
  WHERE phase_submission_id = p_phase_submission_id
    AND validator_type = p_validator_type
  ORDER BY validation_attempt DESC
  LIMIT 1;

  IF previous_attempt.id IS NOT NULL
     AND previous_attempt.attempt_status NOT IN ('INFRA_FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'new validation attempt requires the previous attempt to be INFRA_FAILED or CANCELLED'
      USING ERRCODE = '55000';
  END IF;

  expected_attempt := COALESCE(previous_attempt.validation_attempt, 0) + 1;
  IF p_validation_attempt <> expected_attempt THEN
    RAISE EXCEPTION 'expected validation attempt %, got %', expected_attempt, p_validation_attempt
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO phase_validations(
    id, phase_submission_id, validator_type, validation_attempt,
    attempt_status, artifact_bundle_hash, validated_by_actor_id
  ) VALUES (
    p_validation_id, p_phase_submission_id, p_validator_type, p_validation_attempt,
    'IN_PROGRESS', submission_hash, p_actor_id
  )
  RETURNING * INTO validation_row;

  PERFORM phase15_refresh_validation_projection(phase_id_value);

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (
    phase_id_value,
    p_phase_submission_id,
    'VALIDATION_STARTED',
    p_actor_id,
    jsonb_build_object('validatorType', p_validator_type, 'attempt', p_validation_attempt, 'validationId', p_validation_id)
  );

  RETURN validation_row;
END;
$$;

CREATE OR REPLACE FUNCTION complete_phase_validation(
  p_validation_id TEXT,
  p_verdict TEXT,
  p_evidence_json JSONB,
  p_findings_json JSONB,
  p_actor_id TEXT,
  p_credential_binding TEXT
)
RETURNS phase_validations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  validation_row phase_validations%ROWTYPE;
  phase_row delivery_phases%ROWTYPE;
  submission_row phase_submissions%ROWTYPE;
  required_role TEXT;
  terminal_status TEXT;
  finding_item JSONB;
  finding_ordinal BIGINT;
  finding_id TEXT;
BEGIN
  IF p_verdict NOT IN ('APPROVED', 'CHANGES_REQUESTED', 'BLOCKED') THEN
    RAISE EXCEPTION 'invalid validation verdict %', p_verdict USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_findings_json, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'findings must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO validation_row
  FROM phase_validations
  WHERE id = p_validation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'validation % does not exist', p_validation_id USING ERRCODE = 'P0002';
  END IF;
  IF validation_row.attempt_status NOT IN ('PENDING', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'validation % is already terminal', p_validation_id USING ERRCODE = '55000';
  END IF;
  IF validation_row.validated_by_actor_id <> p_actor_id THEN
    RAISE EXCEPTION 'validation % belongs to a different actor', p_validation_id USING ERRCODE = '42501';
  END IF;

  SELECT * INTO submission_row
  FROM phase_submissions
  WHERE id = validation_row.phase_submission_id;
  PERFORM phase15_assert_not_submission_worker(submission_row.id, p_actor_id);

  SELECT * INTO phase_row
  FROM delivery_phases
  WHERE id = submission_row.phase_id
  FOR UPDATE;

  required_role := CASE validation_row.validator_type
    WHEN 'PLANNING' THEN 'PLANNING_VALIDATOR'
    ELSE 'DEVELOPMENT_VALIDATOR'
  END;
  PERFORM phase15_assert_assignment(phase_row.id, p_actor_id, p_credential_binding, required_role);

  IF p_verdict = 'APPROVED' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_findings_json, '[]'::jsonb)) item
    WHERE item.value->>'severity' = 'BLOCKER'
  ) THEN
    RAISE EXCEPTION 'APPROVED validation cannot contain a BLOCKER finding' USING ERRCODE = '23514';
  END IF;

  terminal_status := CASE
    WHEN phase_row.latest_submission_id <> submission_row.id OR submission_row.status <> 'SEALED'
      THEN 'STALE_ON_ARRIVAL'
    ELSE 'COMPLETED'
  END;

  UPDATE phase_validations
  SET attempt_status = terminal_status,
      verdict = p_verdict,
      evidence_json = COALESCE(p_evidence_json, '[]'::jsonb),
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_validation_id
  RETURNING * INTO validation_row;

  FOR finding_item, finding_ordinal IN
    SELECT value, ordinality
    FROM jsonb_array_elements(COALESCE(p_findings_json, '[]'::jsonb)) WITH ORDINALITY
  LOOP
    finding_id := COALESCE(NULLIF(finding_item->>'id', ''), p_validation_id || ':finding-' || finding_ordinal);
    INSERT INTO phase_validation_findings(
      id, phase_validation_id, finding_key, severity, category, title, detail, evidence_json
    ) VALUES (
      finding_id,
      p_validation_id,
      COALESCE(NULLIF(finding_item->>'findingKey', ''), 'finding-' || finding_ordinal),
      finding_item->>'severity',
      COALESCE(NULLIF(finding_item->>'category', ''), 'GENERAL'),
      finding_item->>'title',
      finding_item->>'detail',
      COALESCE(finding_item->'evidence', '[]'::jsonb)
    );
  END LOOP;

  IF terminal_status = 'STALE_ON_ARRIVAL' THEN
    INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
    VALUES (
      phase_row.id,
      submission_row.id,
      'VALIDATION_STALE_ON_ARRIVAL',
      p_actor_id,
      jsonb_build_object('validationId', p_validation_id, 'validatorType', validation_row.validator_type)
    );
    RETURN validation_row;
  END IF;

  PERFORM phase15_refresh_validation_projection(phase_row.id);

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (
    phase_row.id,
    submission_row.id,
    'VALIDATION_COMPLETED',
    p_actor_id,
    jsonb_build_object(
      'validationId', p_validation_id,
      'validatorType', validation_row.validator_type,
      'attempt', validation_row.validation_attempt,
      'verdict', p_verdict
    )
  );

  RETURN validation_row;
END;
$$;

CREATE OR REPLACE FUNCTION fail_phase_validation_attempt(
  p_validation_id TEXT,
  p_terminal_status TEXT,
  p_evidence_json JSONB,
  p_actor_id TEXT,
  p_credential_binding TEXT
)
RETURNS phase_validations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  validation_row phase_validations%ROWTYPE;
  phase_id_value TEXT;
  required_role TEXT;
BEGIN
  IF p_terminal_status NOT IN ('INFRA_FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'invalid failed validation terminal status %', p_terminal_status USING ERRCODE = '22023';
  END IF;

  SELECT v.* INTO validation_row
  FROM phase_validations v
  WHERE v.id = p_validation_id
  FOR UPDATE OF v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'validation % does not exist', p_validation_id USING ERRCODE = 'P0002';
  END IF;
  IF validation_row.attempt_status NOT IN ('PENDING', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'validation % is already terminal', p_validation_id USING ERRCODE = '55000';
  END IF;
  IF validation_row.validated_by_actor_id <> p_actor_id THEN
    RAISE EXCEPTION 'validation % belongs to a different actor', p_validation_id USING ERRCODE = '42501';
  END IF;

  SELECT s.phase_id INTO phase_id_value
  FROM phase_submissions s
  WHERE s.id = validation_row.phase_submission_id;
  required_role := CASE validation_row.validator_type
    WHEN 'PLANNING' THEN 'PLANNING_VALIDATOR'
    ELSE 'DEVELOPMENT_VALIDATOR'
  END;
  PERFORM phase15_assert_assignment(phase_id_value, p_actor_id, p_credential_binding, required_role);

  UPDATE phase_validations
  SET attempt_status = p_terminal_status,
      evidence_json = COALESCE(p_evidence_json, '[]'::jsonb),
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_validation_id
  RETURNING * INTO validation_row;

  PERFORM phase15_refresh_validation_projection(phase_id_value);

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (
    phase_id_value,
    validation_row.phase_submission_id,
    'VALIDATION_ATTEMPT_FAILED',
    p_actor_id,
    jsonb_build_object(
      'validationId', p_validation_id,
      'validatorType', validation_row.validator_type,
      'attempt', validation_row.validation_attempt,
      'status', p_terminal_status
    )
  );

  RETURN validation_row;
END;
$$;

CREATE OR REPLACE FUNCTION start_phase_rework(
  p_phase_id TEXT,
  p_actor_id TEXT,
  p_credential_binding TEXT,
  p_expected_version BIGINT
)
RETURNS delivery_phases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  phase_row delivery_phases%ROWTYPE;
BEGIN
  PERFORM phase15_assert_assignment(p_phase_id, p_actor_id, p_credential_binding, 'WORKER');
  SELECT * INTO phase_row FROM delivery_phases WHERE id = p_phase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase % does not exist', p_phase_id USING ERRCODE = 'P0002';
  END IF;
  IF phase_row.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'phase % version mismatch', p_phase_id USING ERRCODE = '40001';
  END IF;
  IF phase_row.status NOT IN ('CHANGES_REQUESTED', 'BLOCKED') THEN
    RAISE EXCEPTION 'phase % cannot start rework from status %', p_phase_id, phase_row.status USING ERRCODE = '55000';
  END IF;

  UPDATE delivery_phases
  SET status = 'REWORK_IN_PROGRESS', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = p_phase_id
  RETURNING * INTO phase_row;

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id)
  VALUES (p_phase_id, phase_row.latest_submission_id, 'REWORK_STARTED', p_actor_id);
  RETURN phase_row;
END;
$$;

CREATE OR REPLACE FUNCTION cancel_delivery_phase(
  p_phase_id TEXT,
  p_reason TEXT,
  p_actor_id TEXT,
  p_credential_binding TEXT,
  p_expected_version BIGINT
)
RETURNS delivery_phases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  phase_row delivery_phases%ROWTYPE;
BEGIN
  IF NULLIF(BTRIM(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'cancellation reason is required' USING ERRCODE = '22023';
  END IF;
  PERFORM phase15_assert_assignment(p_phase_id, p_actor_id, p_credential_binding, 'GATE_ADMIN');
  SELECT * INTO phase_row FROM delivery_phases WHERE id = p_phase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase % does not exist', p_phase_id USING ERRCODE = 'P0002';
  END IF;
  IF phase_row.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'phase % version mismatch', p_phase_id USING ERRCODE = '40001';
  END IF;
  IF phase_row.status IN ('ACCEPTED', 'ACCEPTED_WITH_DEBT', 'CANCELLED') THEN
    RAISE EXCEPTION 'phase % cannot be cancelled from status %', p_phase_id, phase_row.status USING ERRCODE = '55000';
  END IF;

  UPDATE delivery_phases
  SET status = 'CANCELLED', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = p_phase_id
  RETURNING * INTO phase_row;
  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (p_phase_id, phase_row.latest_submission_id, 'PHASE_CANCELLED', p_actor_id, jsonb_build_object('reason', p_reason));
  RETURN phase_row;
END;
$$;

DROP FUNCTION IF EXISTS approve_phase_debt(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION approve_phase_debt(
  p_debt_id TEXT,
  p_validator_type TEXT,
  p_successor_safe BOOLEAN,
  p_safety_rationale TEXT,
  p_actor_id TEXT,
  p_credential_binding TEXT
)
RETURNS phase_debt_approvals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  approval_row phase_debt_approvals%ROWTYPE;
  phase_id_value TEXT;
  required_role TEXT;
BEGIN
  required_role := CASE p_validator_type
    WHEN 'PLANNING' THEN 'PLANNING_VALIDATOR'
    WHEN 'DEVELOPMENT' THEN 'DEVELOPMENT_VALIDATOR'
    ELSE NULL
  END;
  IF required_role IS NULL THEN
    RAISE EXCEPTION 'invalid debt validator type %', p_validator_type USING ERRCODE = '22023';
  END IF;
  IF p_successor_safe AND NULLIF(BTRIM(p_safety_rationale), '') IS NULL THEN
    RAISE EXCEPTION 'successor-safe debt approval requires a safety rationale' USING ERRCODE = '23514';
  END IF;

  SELECT s.phase_id INTO phase_id_value
  FROM phase_debts d
  JOIN phase_validation_findings f ON f.id = d.finding_id
  JOIN phase_validations v ON v.id = f.phase_validation_id
  JOIN phase_submissions s ON s.id = v.phase_submission_id
  WHERE d.id = p_debt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase debt % does not exist', p_debt_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM phase15_assert_assignment(phase_id_value, p_actor_id, p_credential_binding, required_role);
  INSERT INTO phase_debt_approvals(
    debt_id, validator_type, approved_by_actor_id, successor_safe, safety_rationale
  ) VALUES (
    p_debt_id, p_validator_type, p_actor_id, p_successor_safe, p_safety_rationale
  )
  RETURNING * INTO approval_row;

  INSERT INTO phase_gate_events(phase_id, event_type, actor_id, event_payload)
  VALUES (
    phase_id_value,
    'PHASE_DEBT_APPROVED',
    p_actor_id,
    jsonb_build_object(
      'debtId', p_debt_id,
      'validatorType', p_validator_type,
      'successorSafe', p_successor_safe,
      'safetyRationale', p_safety_rationale
    )
  );
  RETURN approval_row;
END;
$$;

CREATE OR REPLACE FUNCTION accept_phase_debt_risk(
  p_debt_id TEXT,
  p_actor_id TEXT,
  p_credential_binding TEXT
)
RETURNS phase_debts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  debt_row phase_debts%ROWTYPE;
  phase_id_value TEXT;
BEGIN
  SELECT d.* INTO debt_row
  FROM phase_debts d
  WHERE d.id = p_debt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase debt % does not exist', p_debt_id USING ERRCODE = 'P0002';
  END IF;
  SELECT s.phase_id INTO phase_id_value
  FROM phase_validation_findings f
  JOIN phase_validations v ON v.id = f.phase_validation_id
  JOIN phase_submissions s ON s.id = v.phase_submission_id
  WHERE f.id = debt_row.finding_id;
  IF debt_row.risk_owner_actor_id <> p_actor_id THEN
    RAISE EXCEPTION 'only the assigned risk owner can accept phase debt risk' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM delivery_actors
    WHERE id = p_actor_id AND status = 'ACTIVE' AND credential_binding = p_credential_binding
  ) THEN
    RAISE EXCEPTION 'risk owner credential is not valid' USING ERRCODE = '42501';
  END IF;

  UPDATE phase_debts
  SET risk_accepted_by_actor_id = p_actor_id, risk_accepted_at = CURRENT_TIMESTAMP
  WHERE id = p_debt_id
  RETURNING * INTO debt_row;
  INSERT INTO phase_gate_events(phase_id, event_type, actor_id, event_payload)
  VALUES (phase_id_value, 'PHASE_DEBT_RISK_ACCEPTED', p_actor_id, jsonb_build_object('debtId', p_debt_id));
  RETURN debt_row;
END;
$$;

CREATE OR REPLACE FUNCTION gate_delivery_phase(
  p_phase_id TEXT,
  p_actor_id TEXT,
  p_credential_binding TEXT,
  p_expected_version BIGINT,
  p_accept_with_debt BOOLEAN DEFAULT FALSE
)
RETURNS delivery_phases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  phase_row delivery_phases%ROWTYPE;
  submission_row phase_submissions%ROWTYPE;
  planning_validation phase_validations%ROWTYPE;
  development_validation phase_validations%ROWTYPE;
  open_blocker_count INTEGER;
  open_major_count INTEGER;
  uncovered_debt_count INTEGER;
  accepted_status TEXT;
  successor_phase_id TEXT;
BEGIN
  PERFORM phase15_assert_assignment(p_phase_id, p_actor_id, p_credential_binding, 'GATE_ADMIN');
  PERFORM phase15_assert_dependencies_accepted(p_phase_id);

  SELECT * INTO phase_row FROM delivery_phases WHERE id = p_phase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase % does not exist', p_phase_id USING ERRCODE = 'P0002';
  END IF;
  IF phase_row.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'phase % version mismatch: expected %, actual %',
      p_phase_id, p_expected_version, phase_row.row_version USING ERRCODE = '40001';
  END IF;
  IF phase_row.status <> 'VALIDATION_IN_PROGRESS' THEN
    RAISE EXCEPTION 'phase % cannot be gated from status %', p_phase_id, phase_row.status USING ERRCODE = '55000';
  END IF;

  SELECT * INTO submission_row
  FROM phase_submissions
  WHERE id = phase_row.latest_submission_id AND status = 'SEALED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'latest submission is not sealed' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO planning_validation
  FROM phase_validations
  WHERE phase_submission_id = submission_row.id AND validator_type = 'PLANNING'
  ORDER BY validation_attempt DESC LIMIT 1;
  SELECT * INTO development_validation
  FROM phase_validations
  WHERE phase_submission_id = submission_row.id AND validator_type = 'DEVELOPMENT'
  ORDER BY validation_attempt DESC LIMIT 1;

  IF planning_validation.id IS NULL OR development_validation.id IS NULL
     OR planning_validation.attempt_status <> 'COMPLETED'
     OR development_validation.attempt_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'both latest validation attempts must be terminal COMPLETED verdicts' USING ERRCODE = '55000';
  END IF;
  IF planning_validation.verdict <> 'APPROVED' OR development_validation.verdict <> 'APPROVED' THEN
    RAISE EXCEPTION 'both latest validations must be APPROVED' USING ERRCODE = '55000';
  END IF;
  IF planning_validation.artifact_bundle_hash <> submission_row.artifact_bundle_hash
     OR development_validation.artifact_bundle_hash <> submission_row.artifact_bundle_hash THEN
    RAISE EXCEPTION 'validation artifact hash does not match latest submission' USING ERRCODE = '55000';
  END IF;
  IF planning_validation.validated_by_actor_id = development_validation.validated_by_actor_id THEN
    RAISE EXCEPTION 'planning and development validators must be different actors' USING ERRCODE = '42501';
  END IF;
  IF submission_row.submitted_by_actor_id IN (
    planning_validation.validated_by_actor_id,
    development_validation.validated_by_actor_id
  ) THEN
    RAISE EXCEPTION 'submission worker cannot validate its own submission' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO open_blocker_count
  FROM phase_validation_findings f
  WHERE f.phase_validation_id IN (planning_validation.id, development_validation.id)
    AND f.severity = 'BLOCKER' AND f.status <> 'RESOLVED';
  IF open_blocker_count > 0 THEN
    RAISE EXCEPTION 'open BLOCKER findings prevent phase acceptance' USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO open_major_count
  FROM phase_validation_findings f
  WHERE f.phase_validation_id IN (planning_validation.id, development_validation.id)
    AND f.severity = 'MAJOR' AND f.status <> 'RESOLVED';
  IF open_major_count > 0 AND NOT p_accept_with_debt THEN
    RAISE EXCEPTION 'open MAJOR findings require ACCEPTED_WITH_DEBT' USING ERRCODE = '55000';
  END IF;

  IF open_major_count > 0 THEN
    SELECT COUNT(*) INTO uncovered_debt_count
    FROM phase_validation_findings f
    LEFT JOIN phase_debts d ON d.finding_id = f.id
    WHERE f.phase_validation_id IN (planning_validation.id, development_validation.id)
      AND f.severity = 'MAJOR'
      AND f.status <> 'RESOLVED'
      AND (
        f.category IN ('SECURITY', 'DATA_INTEGRITY', 'ROLLBACK')
        OR d.id IS NULL
        OR d.due_date <= CURRENT_DATE
        OR d.risk_accepted_by_actor_id IS DISTINCT FROM d.risk_owner_actor_id
        OR d.risk_accepted_at IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM phase_debt_approvals da
          WHERE da.debt_id = d.id
            AND da.validator_type = 'PLANNING'
            AND da.approved_by_actor_id = planning_validation.validated_by_actor_id
            AND da.successor_safe
            AND NULLIF(BTRIM(da.safety_rationale), '') IS NOT NULL
        )
        OR NOT EXISTS (
          SELECT 1 FROM phase_debt_approvals da
          WHERE da.debt_id = d.id
            AND da.validator_type = 'DEVELOPMENT'
            AND da.approved_by_actor_id = development_validation.validated_by_actor_id
            AND da.successor_safe
            AND NULLIF(BTRIM(da.safety_rationale), '') IS NOT NULL
        )
      );
    IF uncovered_debt_count > 0 THEN
      RAISE EXCEPTION 'one or more MAJOR findings are not eligible or fully approved as successor-safe debt'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  accepted_status := CASE WHEN open_major_count > 0 THEN 'ACCEPTED_WITH_DEBT' ELSE 'ACCEPTED' END;
  UPDATE delivery_phases
  SET status = accepted_status,
      planning_validation_status = 'APPROVED',
      development_validation_status = 'APPROVED',
      accepted_at = CURRENT_TIMESTAMP,
      row_version = row_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_phase_id
  RETURNING * INTO phase_row;

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (
    p_phase_id,
    submission_row.id,
    'PHASE_ACCEPTED',
    p_actor_id,
    jsonb_build_object(
      'status', accepted_status,
      'artifactBundleHash', submission_row.artifact_bundle_hash,
      'planningValidationId', planning_validation.id,
      'developmentValidationId', development_validation.id,
      'rowVersion', phase_row.row_version
    )
  );

  FOR successor_phase_id IN
    INSERT INTO phase_dependency_activations(
      phase_id, depends_on_phase_id, activated_by_submission_id, activated_by_actor_id
    )
    SELECT d.phase_id, p_phase_id, submission_row.id, p_actor_id
    FROM phase_dependencies d
    WHERE d.depends_on_phase_id = p_phase_id
    ON CONFLICT DO NOTHING
    RETURNING phase_id
  LOOP
    INSERT INTO phase_gate_events(phase_id, event_type, actor_id, event_payload)
    VALUES (
      successor_phase_id,
      'PHASE_DEPENDENCY_ACTIVATED',
      p_actor_id,
      jsonb_build_object(
        'dependsOnPhaseId', p_phase_id,
        'activatedBySubmissionId', submission_row.id
      )
    );
  END LOOP;

  RETURN phase_row;
END;
$$;

REVOKE ALL ON TABLE phase_dependency_activations FROM PUBLIC;

DO $$
DECLARE
  function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT p.oid::regprocedure AS function_signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'phase15_assert_not_submission_worker',
        'phase15_refresh_validation_projection',
        'phase15_assert_dependencies_accepted',
        'start_phase_validation',
        'complete_phase_validation',
        'fail_phase_validation_attempt',
        'start_phase_rework',
        'cancel_delivery_phase',
        'approve_phase_debt',
        'accept_phase_debt_risk',
        'gate_delivery_phase'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_record.function_signature);
  END LOOP;
END;
$$;
