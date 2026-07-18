-- Phase 15: Delivery Governance Bootstrap
-- This migration is intentionally independent from the runtime workflow tables.

CREATE TABLE IF NOT EXISTS delivery_actors (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN', 'AGENT', 'SERVICE')),
  display_name TEXT NOT NULL,
  credential_binding TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS delivery_phases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sequence_no INTEGER NOT NULL UNIQUE CHECK (sequence_no > 0),
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN (
    'PLANNED',
    'IN_PROGRESS',
    'IMPLEMENTATION_SUBMITTED',
    'VALIDATION_IN_PROGRESS',
    'CHANGES_REQUESTED',
    'REWORK_IN_PROGRESS',
    'ACCEPTED',
    'ACCEPTED_WITH_DEBT',
    'BLOCKED',
    'CANCELLED'
  )),
  planning_validation_status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (planning_validation_status IN (
    'NOT_STARTED', 'PENDING', 'IN_PROGRESS', 'APPROVED', 'CHANGES_REQUESTED', 'BLOCKED', 'STALE'
  )),
  development_validation_status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (development_validation_status IN (
    'NOT_STARTED', 'PENDING', 'IN_PROGRESS', 'APPROVED', 'CHANGES_REQUESTED', 'BLOCKED', 'STALE'
  )),
  latest_submission_id TEXT,
  row_version BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase_dependencies (
  phase_id TEXT NOT NULL REFERENCES delivery_phases(id) ON DELETE CASCADE,
  depends_on_phase_id TEXT NOT NULL REFERENCES delivery_phases(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phase_id, depends_on_phase_id),
  CHECK (phase_id <> depends_on_phase_id)
);

CREATE TABLE IF NOT EXISTS phase_assignments (
  id BIGSERIAL PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES delivery_phases(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  assignment_role TEXT NOT NULL CHECK (assignment_role IN (
    'WORKER', 'PLANNING_VALIDATOR', 'DEVELOPMENT_VALIDATOR', 'GATE_ADMIN'
  )),
  assigned_by_actor_id TEXT REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_phase_assignment_active_role
  ON phase_assignments(phase_id, assignment_role)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_phase_assignment_actor
  ON phase_assignments(actor_id, phase_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS phase_submissions (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES delivery_phases(id) ON DELETE CASCADE,
  submission_round INTEGER NOT NULL CHECK (submission_round > 0),
  base_commit_sha TEXT NOT NULL,
  candidate_commit_sha TEXT NOT NULL,
  artifact_bundle_hash TEXT NOT NULL CHECK (artifact_bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_schema_version INTEGER NOT NULL CHECK (manifest_schema_version > 0),
  manifest_json JSONB NOT NULL CHECK (jsonb_typeof(manifest_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'SEALED' CHECK (status IN ('DRAFT', 'SEALED')),
  submitted_by_actor_id TEXT NOT NULL REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (phase_id, submission_round)
);

ALTER TABLE delivery_phases
  DROP CONSTRAINT IF EXISTS fk_delivery_phase_latest_submission;

ALTER TABLE delivery_phases
  ADD CONSTRAINT fk_delivery_phase_latest_submission
  FOREIGN KEY (latest_submission_id)
  REFERENCES phase_submissions(id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS ix_phase_submission_latest
  ON phase_submissions(phase_id, submission_round DESC);

CREATE TABLE IF NOT EXISTS phase_validations (
  id TEXT PRIMARY KEY,
  phase_submission_id TEXT NOT NULL REFERENCES phase_submissions(id) ON DELETE CASCADE,
  validator_type TEXT NOT NULL CHECK (validator_type IN ('PLANNING', 'DEVELOPMENT')),
  validation_attempt INTEGER NOT NULL CHECK (validation_attempt > 0),
  attempt_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (attempt_status IN (
    'PENDING', 'IN_PROGRESS', 'COMPLETED', 'INFRA_FAILED', 'CANCELLED', 'STALE_ON_ARRIVAL'
  )),
  verdict TEXT CHECK (verdict IN ('APPROVED', 'CHANGES_REQUESTED', 'BLOCKED')),
  artifact_bundle_hash TEXT NOT NULL CHECK (artifact_bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_json) IN ('array', 'object')),
  validated_by_actor_id TEXT NOT NULL REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (phase_submission_id, validator_type, validation_attempt),
  CHECK (
    (attempt_status IN ('COMPLETED', 'STALE_ON_ARRIVAL') AND verdict IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (attempt_status IN ('PENDING', 'IN_PROGRESS', 'INFRA_FAILED', 'CANCELLED') AND verdict IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_phase_validation_gate
  ON phase_validations(phase_submission_id, validator_type, attempt_status, validation_attempt DESC);

CREATE TABLE IF NOT EXISTS phase_validation_findings (
  id TEXT PRIMARY KEY,
  phase_validation_id TEXT NOT NULL REFERENCES phase_validations(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('BLOCKER', 'MAJOR', 'MINOR', 'NOTE')),
  category TEXT NOT NULL DEFAULT 'GENERAL' CHECK (category IN (
    'GENERAL', 'REQUIREMENTS', 'SECURITY', 'DATA_INTEGRITY', 'ROLLBACK', 'OPERATIONS', 'PERFORMANCE'
  )),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_json) IN ('array', 'object')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'WONT_FIX')),
  resolution_note TEXT,
  resolved_by_actor_id TEXT REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (phase_validation_id, finding_key),
  CHECK (
    (status = 'OPEN' AND resolved_at IS NULL)
    OR
    (status IN ('RESOLVED', 'WONT_FIX') AND resolved_at IS NOT NULL AND resolved_by_actor_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_phase_finding_open
  ON phase_validation_findings(phase_validation_id, severity, status);

CREATE TABLE IF NOT EXISTS phase_debts (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL UNIQUE REFERENCES phase_validation_findings(id) ON DELETE CASCADE,
  debt_owner_actor_id TEXT NOT NULL REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  risk_owner_actor_id TEXT NOT NULL REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  created_by_actor_id TEXT NOT NULL REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  due_date DATE NOT NULL,
  impact_scope TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase_debt_approvals (
  debt_id TEXT NOT NULL REFERENCES phase_debts(id) ON DELETE CASCADE,
  validator_type TEXT NOT NULL CHECK (validator_type IN ('PLANNING', 'DEVELOPMENT')),
  approved_by_actor_id TEXT NOT NULL REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (debt_id, validator_type)
);

CREATE TABLE IF NOT EXISTS phase_gate_events (
  id BIGSERIAL PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES delivery_phases(id) ON DELETE CASCADE,
  phase_submission_id TEXT REFERENCES phase_submissions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT REFERENCES delivery_actors(id) ON DELETE RESTRICT,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_phase_gate_event_phase
  ON phase_gate_events(phase_id, id);

CREATE OR REPLACE FUNCTION phase15_reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'phase_gate_events is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_phase_gate_events_append_only ON phase_gate_events;
CREATE TRIGGER trg_phase_gate_events_append_only
BEFORE UPDATE OR DELETE ON phase_gate_events
FOR EACH ROW EXECUTE FUNCTION phase15_reject_event_mutation();

CREATE OR REPLACE FUNCTION phase15_protect_sealed_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'SEALED' THEN
    RAISE EXCEPTION 'sealed phase submission % is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_phase_submission_immutable ON phase_submissions;
CREATE TRIGGER trg_phase_submission_immutable
BEFORE UPDATE OR DELETE ON phase_submissions
FOR EACH ROW EXECUTE FUNCTION phase15_protect_sealed_submission();

CREATE OR REPLACE FUNCTION phase15_protect_terminal_validation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.attempt_status IN ('COMPLETED', 'INFRA_FAILED', 'CANCELLED', 'STALE_ON_ARRIVAL') THEN
    RAISE EXCEPTION 'terminal phase validation % is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_phase_validation_immutable ON phase_validations;
CREATE TRIGGER trg_phase_validation_immutable
BEFORE UPDATE OR DELETE ON phase_validations
FOR EACH ROW EXECUTE FUNCTION phase15_protect_terminal_validation();

CREATE OR REPLACE FUNCTION phase15_check_assignment_separation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conflicting_role TEXT;
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT pa.assignment_role
    INTO conflicting_role
  FROM phase_assignments pa
  WHERE pa.phase_id = NEW.phase_id
    AND pa.revoked_at IS NULL
    AND pa.actor_id = NEW.actor_id
    AND pa.assignment_role <> NEW.assignment_role
    AND (TG_OP = 'INSERT' OR pa.id <> NEW.id)
  LIMIT 1;

  IF conflicting_role IS NOT NULL THEN
    RAISE EXCEPTION 'actor % cannot hold both % and % for phase %',
      NEW.actor_id, conflicting_role, NEW.assignment_role, NEW.phase_id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_phase_assignment_separation ON phase_assignments;
CREATE TRIGGER trg_phase_assignment_separation
BEFORE INSERT OR UPDATE ON phase_assignments
FOR EACH ROW EXECUTE FUNCTION phase15_check_assignment_separation();

CREATE OR REPLACE FUNCTION phase15_assert_assignment(
  p_phase_id TEXT,
  p_actor_id TEXT,
  p_credential_binding TEXT,
  p_assignment_role TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM delivery_actors a
    JOIN phase_assignments pa ON pa.actor_id = a.id
    WHERE a.id = p_actor_id
      AND a.status = 'ACTIVE'
      AND a.credential_binding = p_credential_binding
      AND pa.phase_id = p_phase_id
      AND pa.assignment_role = p_assignment_role
      AND pa.revoked_at IS NULL
      AND pa.valid_from <= CURRENT_TIMESTAMP
      AND (pa.valid_until IS NULL OR pa.valid_until > CURRENT_TIMESTAMP)
  ) THEN
    RAISE EXCEPTION 'actor % is not authorized as % for phase %',
      p_actor_id, p_assignment_role, p_phase_id
      USING ERRCODE = '42501';
  END IF;
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
  WHERE d.phase_id = p_phase_id
    AND predecessor.status NOT IN ('ACCEPTED', 'ACCEPTED_WITH_DEBT')
  LIMIT 1;

  IF blocked_dependency IS NOT NULL THEN
    RAISE EXCEPTION 'phase % dependency % is not accepted', p_phase_id, blocked_dependency
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION start_delivery_phase(
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
  PERFORM phase15_assert_assignment(p_phase_id, p_actor_id, p_credential_binding, 'GATE_ADMIN');
  PERFORM phase15_assert_dependencies_accepted(p_phase_id);

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
  IF phase_row.status <> 'PLANNED' THEN
    RAISE EXCEPTION 'phase % cannot start from status %', p_phase_id, phase_row.status USING ERRCODE = '55000';
  END IF;

  UPDATE delivery_phases
  SET status = 'IN_PROGRESS',
      started_at = CURRENT_TIMESTAMP,
      row_version = row_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_phase_id
  RETURNING * INTO phase_row;

  INSERT INTO phase_gate_events(phase_id, event_type, actor_id, event_payload)
  VALUES (p_phase_id, 'PHASE_STARTED', p_actor_id, jsonb_build_object('rowVersion', phase_row.row_version));

  RETURN phase_row;
END;
$$;

CREATE OR REPLACE FUNCTION seal_phase_submission(
  p_submission_id TEXT,
  p_phase_id TEXT,
  p_submission_round INTEGER,
  p_base_commit_sha TEXT,
  p_candidate_commit_sha TEXT,
  p_artifact_bundle_hash TEXT,
  p_manifest_schema_version INTEGER,
  p_manifest_json JSONB,
  p_actor_id TEXT,
  p_credential_binding TEXT,
  p_expected_version BIGINT
)
RETURNS phase_submissions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  phase_row delivery_phases%ROWTYPE;
  submission_row phase_submissions%ROWTYPE;
  expected_round INTEGER;
  previous_submission_id TEXT;
BEGIN
  PERFORM phase15_assert_assignment(p_phase_id, p_actor_id, p_credential_binding, 'WORKER');

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
  IF phase_row.status NOT IN ('IN_PROGRESS', 'REWORK_IN_PROGRESS') THEN
    RAISE EXCEPTION 'phase % cannot accept submission from status %', p_phase_id, phase_row.status USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_manifest_json) <> 'object' THEN
    RAISE EXCEPTION 'submission manifest must be a JSON object' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(MAX(submission_round), 0) + 1
    INTO expected_round
  FROM phase_submissions
  WHERE phase_id = p_phase_id;

  IF p_submission_round <> expected_round THEN
    RAISE EXCEPTION 'phase % expected submission round %, got %',
      p_phase_id, expected_round, p_submission_round USING ERRCODE = '23514';
  END IF;

  previous_submission_id := phase_row.latest_submission_id;

  INSERT INTO phase_submissions(
    id,
    phase_id,
    submission_round,
    base_commit_sha,
    candidate_commit_sha,
    artifact_bundle_hash,
    manifest_schema_version,
    manifest_json,
    status,
    submitted_by_actor_id,
    sealed_at
  ) VALUES (
    p_submission_id,
    p_phase_id,
    p_submission_round,
    p_base_commit_sha,
    p_candidate_commit_sha,
    p_artifact_bundle_hash,
    p_manifest_schema_version,
    p_manifest_json,
    'SEALED',
    p_actor_id,
    CURRENT_TIMESTAMP
  )
  RETURNING * INTO submission_row;

  UPDATE delivery_phases
  SET latest_submission_id = p_submission_id,
      status = 'VALIDATION_IN_PROGRESS',
      planning_validation_status = 'PENDING',
      development_validation_status = 'PENDING',
      row_version = row_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_phase_id;

  IF previous_submission_id IS NOT NULL THEN
    INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
    VALUES (
      p_phase_id,
      previous_submission_id,
      'VALIDATION_STALED',
      p_actor_id,
      jsonb_build_object('supersededBySubmissionId', p_submission_id)
    );
  END IF;

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (
    p_phase_id,
    p_submission_id,
    'SUBMISSION_SEALED',
    p_actor_id,
    jsonb_build_object('round', p_submission_round, 'artifactBundleHash', p_artifact_bundle_hash)
  );

  RETURN submission_row;
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

  IF latest_submission_id_value <> p_phase_submission_id OR submission_status <> 'SEALED' THEN
    RAISE EXCEPTION 'validation can start only for the latest sealed submission' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(MAX(validation_attempt), 0) + 1
    INTO expected_attempt
  FROM phase_validations
  WHERE phase_submission_id = p_phase_submission_id
    AND validator_type = p_validator_type;

  IF p_validation_attempt <> expected_attempt THEN
    RAISE EXCEPTION 'expected validation attempt %, got %', expected_attempt, p_validation_attempt USING ERRCODE = '23514';
  END IF;

  INSERT INTO phase_validations(
    id,
    phase_submission_id,
    validator_type,
    validation_attempt,
    attempt_status,
    artifact_bundle_hash,
    validated_by_actor_id
  ) VALUES (
    p_validation_id,
    p_phase_submission_id,
    p_validator_type,
    p_validation_attempt,
    'IN_PROGRESS',
    submission_hash,
    p_actor_id
  )
  RETURNING * INTO validation_row;

  UPDATE delivery_phases
  SET planning_validation_status = CASE WHEN p_validator_type = 'PLANNING' THEN 'IN_PROGRESS' ELSE planning_validation_status END,
      development_validation_status = CASE WHEN p_validator_type = 'DEVELOPMENT' THEN 'IN_PROGRESS' ELSE development_validation_status END,
      row_version = row_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = phase_id_value;

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
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_findings_json, '[]'::jsonb)) item
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
      id,
      phase_validation_id,
      finding_key,
      severity,
      category,
      title,
      detail,
      evidence_json
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

  UPDATE delivery_phases
  SET status = CASE
        WHEN p_verdict = 'BLOCKED' THEN 'BLOCKED'
        WHEN p_verdict = 'CHANGES_REQUESTED' THEN 'CHANGES_REQUESTED'
        ELSE status
      END,
      planning_validation_status = CASE
        WHEN validation_row.validator_type = 'PLANNING' THEN p_verdict
        ELSE planning_validation_status
      END,
      development_validation_status = CASE
        WHEN validation_row.validator_type = 'DEVELOPMENT' THEN p_verdict
        ELSE development_validation_status
      END,
      row_version = row_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = phase_row.id;

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

  SELECT v.*
    INTO validation_row
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

  SELECT s.phase_id
    INTO phase_id_value
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

  SELECT * INTO phase_row
  FROM delivery_phases
  WHERE id = p_phase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase % does not exist', p_phase_id USING ERRCODE = 'P0002';
  END IF;
  IF phase_row.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'phase % version mismatch', p_phase_id USING ERRCODE = '40001';
  END IF;
  IF phase_row.status <> 'CHANGES_REQUESTED' THEN
    RAISE EXCEPTION 'phase % cannot start rework from status %', p_phase_id, phase_row.status USING ERRCODE = '55000';
  END IF;

  UPDATE delivery_phases
  SET status = 'REWORK_IN_PROGRESS',
      row_version = row_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_phase_id
  RETURNING * INTO phase_row;

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id)
  VALUES (p_phase_id, phase_row.latest_submission_id, 'REWORK_STARTED', p_actor_id);

  RETURN phase_row;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_phase_finding(
  p_finding_id TEXT,
  p_resolution_status TEXT,
  p_resolution_note TEXT,
  p_actor_id TEXT,
  p_credential_binding TEXT
)
RETURNS phase_validation_findings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  finding_row phase_validation_findings%ROWTYPE;
  phase_id_value TEXT;
  submission_id_value TEXT;
BEGIN
  IF p_resolution_status NOT IN ('RESOLVED', 'WONT_FIX') THEN
    RAISE EXCEPTION 'invalid finding resolution status %', p_resolution_status USING ERRCODE = '22023';
  END IF;

  SELECT f.*
    INTO finding_row
  FROM phase_validation_findings f
  WHERE f.id = p_finding_id
  FOR UPDATE OF f;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'finding % does not exist', p_finding_id USING ERRCODE = 'P0002';
  END IF;
  IF finding_row.status <> 'OPEN' THEN
    RAISE EXCEPTION 'finding % is already resolved', p_finding_id USING ERRCODE = '55000';
  END IF;

  SELECT s.phase_id, s.id
    INTO phase_id_value, submission_id_value
  FROM phase_validations v
  JOIN phase_submissions s ON s.id = v.phase_submission_id
  WHERE v.id = finding_row.phase_validation_id;

  PERFORM phase15_assert_assignment(phase_id_value, p_actor_id, p_credential_binding, 'WORKER');

  UPDATE phase_validation_findings
  SET status = p_resolution_status,
      resolution_note = p_resolution_note,
      resolved_by_actor_id = p_actor_id,
      resolved_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_finding_id
  RETURNING * INTO finding_row;

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (
    phase_id_value,
    submission_id_value,
    'FINDING_RESOLVED',
    p_actor_id,
    jsonb_build_object('findingId', p_finding_id, 'status', p_resolution_status)
  );

  RETURN finding_row;
END;
$$;

CREATE OR REPLACE FUNCTION register_phase_debt(
  p_debt_id TEXT,
  p_finding_id TEXT,
  p_debt_owner_actor_id TEXT,
  p_risk_owner_actor_id TEXT,
  p_due_date DATE,
  p_impact_scope TEXT,
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
  finding_row phase_validation_findings%ROWTYPE;
  phase_id_value TEXT;
  submission_id_value TEXT;
BEGIN
  SELECT f.*
    INTO finding_row
  FROM phase_validation_findings f
  WHERE f.id = p_finding_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'finding % does not exist', p_finding_id USING ERRCODE = 'P0002';
  END IF;

  SELECT s.phase_id, s.id
    INTO phase_id_value, submission_id_value
  FROM phase_validations v
  JOIN phase_submissions s ON s.id = v.phase_submission_id
  WHERE v.id = finding_row.phase_validation_id;

  PERFORM phase15_assert_assignment(phase_id_value, p_actor_id, p_credential_binding, 'GATE_ADMIN');

  IF finding_row.severity <> 'MAJOR' OR finding_row.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'only an unresolved MAJOR finding can be registered as debt' USING ERRCODE = '23514';
  END IF;
  IF finding_row.category IN ('SECURITY', 'DATA_INTEGRITY', 'ROLLBACK') THEN
    RAISE EXCEPTION 'finding category % cannot be accepted as debt', finding_row.category USING ERRCODE = '23514';
  END IF;
  IF p_due_date <= CURRENT_DATE THEN
    RAISE EXCEPTION 'debt due date must be in the future' USING ERRCODE = '23514';
  END IF;
  IF (
    SELECT COUNT(DISTINCT id)
    FROM delivery_actors
    WHERE id IN (p_debt_owner_actor_id, p_risk_owner_actor_id)
      AND status = 'ACTIVE'
  ) <> 2 THEN
    RAISE EXCEPTION 'debt owner and risk owner must be distinct active actors' USING ERRCODE = '42501';
  END IF;

  INSERT INTO phase_debts(
    id,
    finding_id,
    debt_owner_actor_id,
    risk_owner_actor_id,
    created_by_actor_id,
    due_date,
    impact_scope
  ) VALUES (
    p_debt_id,
    p_finding_id,
    p_debt_owner_actor_id,
    p_risk_owner_actor_id,
    p_actor_id,
    p_due_date,
    p_impact_scope
  )
  RETURNING * INTO debt_row;

  INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
  VALUES (
    phase_id_value,
    submission_id_value,
    'PHASE_DEBT_REGISTERED',
    p_actor_id,
    jsonb_build_object('debtId', p_debt_id, 'findingId', p_finding_id, 'dueDate', p_due_date)
  );

  RETURN debt_row;
END;
$$;

CREATE OR REPLACE FUNCTION approve_phase_debt(
  p_debt_id TEXT,
  p_validator_type TEXT,
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

  SELECT s.phase_id
    INTO phase_id_value
  FROM phase_debts d
  JOIN phase_validation_findings f ON f.id = d.finding_id
  JOIN phase_validations v ON v.id = f.phase_validation_id
  JOIN phase_submissions s ON s.id = v.phase_submission_id
  WHERE d.id = p_debt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase debt % does not exist', p_debt_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM phase15_assert_assignment(phase_id_value, p_actor_id, p_credential_binding, required_role);

  INSERT INTO phase_debt_approvals(debt_id, validator_type, approved_by_actor_id)
  VALUES (p_debt_id, p_validator_type, p_actor_id)
  RETURNING * INTO approval_row;

  INSERT INTO phase_gate_events(phase_id, event_type, actor_id, event_payload)
  VALUES (
    phase_id_value,
    'PHASE_DEBT_APPROVED',
    p_actor_id,
    jsonb_build_object('debtId', p_debt_id, 'validatorType', p_validator_type)
  );

  RETURN approval_row;
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
  worker_actor_id TEXT;
  open_blocker_count INTEGER;
  open_major_count INTEGER;
  uncovered_debt_count INTEGER;
  accepted_status TEXT;
BEGIN
  PERFORM phase15_assert_assignment(p_phase_id, p_actor_id, p_credential_binding, 'GATE_ADMIN');
  PERFORM phase15_assert_dependencies_accepted(p_phase_id);

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
  IF phase_row.status <> 'VALIDATION_IN_PROGRESS' THEN
    RAISE EXCEPTION 'phase % cannot be gated from status %', p_phase_id, phase_row.status USING ERRCODE = '55000';
  END IF;
  IF phase_row.latest_submission_id IS NULL THEN
    RAISE EXCEPTION 'phase % has no latest submission', p_phase_id USING ERRCODE = '55000';
  END IF;

  SELECT * INTO submission_row
  FROM phase_submissions
  WHERE id = phase_row.latest_submission_id
    AND status = 'SEALED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'latest submission is not sealed' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO planning_validation
  FROM phase_validations
  WHERE phase_submission_id = submission_row.id
    AND validator_type = 'PLANNING'
    AND attempt_status = 'COMPLETED'
  ORDER BY validation_attempt DESC
  LIMIT 1;

  SELECT * INTO development_validation
  FROM phase_validations
  WHERE phase_submission_id = submission_row.id
    AND validator_type = 'DEVELOPMENT'
    AND attempt_status = 'COMPLETED'
  ORDER BY validation_attempt DESC
  LIMIT 1;

  IF planning_validation.id IS NULL OR development_validation.id IS NULL THEN
    RAISE EXCEPTION 'both planning and development terminal validations are required' USING ERRCODE = '55000';
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

  SELECT actor_id INTO worker_actor_id
  FROM phase_assignments
  WHERE phase_id = p_phase_id
    AND assignment_role = 'WORKER'
    AND revoked_at IS NULL;

  IF worker_actor_id IN (planning_validation.validated_by_actor_id, development_validation.validated_by_actor_id) THEN
    RAISE EXCEPTION 'worker cannot validate its own submission' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO open_blocker_count
  FROM phase_validation_findings f
  WHERE f.phase_validation_id IN (planning_validation.id, development_validation.id)
    AND f.severity = 'BLOCKER'
    AND f.status <> 'RESOLVED';

  IF open_blocker_count > 0 THEN
    RAISE EXCEPTION 'open BLOCKER findings prevent phase acceptance' USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO open_major_count
  FROM phase_validation_findings f
  WHERE f.phase_validation_id IN (planning_validation.id, development_validation.id)
    AND f.severity = 'MAJOR'
    AND f.status <> 'RESOLVED';

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
        OR NOT EXISTS (
          SELECT 1
          FROM phase_debt_approvals da
          WHERE da.debt_id = d.id
            AND da.validator_type = 'PLANNING'
            AND da.approved_by_actor_id = planning_validation.validated_by_actor_id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM phase_debt_approvals da
          WHERE da.debt_id = d.id
            AND da.validator_type = 'DEVELOPMENT'
            AND da.approved_by_actor_id = development_validation.validated_by_actor_id
        )
      );

    IF uncovered_debt_count > 0 THEN
      RAISE EXCEPTION 'one or more MAJOR findings are not eligible or fully approved as debt' USING ERRCODE = '55000';
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

  RETURN phase_row;
END;
$$;
