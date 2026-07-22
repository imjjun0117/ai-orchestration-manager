-- Phase 17: explicit, audited operator recovery for unresolved jobs and outbox events.

ALTER TABLE role_jobs
  ADD COLUMN reconciliation_revision BIGINT NOT NULL DEFAULT 0
  CHECK (reconciliation_revision >= 0);

ALTER TABLE outbox_events
  ADD COLUMN reconciliation_revision BIGINT NOT NULL DEFAULT 0
  CHECK (reconciliation_revision >= 0);

CREATE OR REPLACE FUNCTION phase17_bump_reconciliation_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('NEEDS_RECONCILIATION', 'DEAD_LETTER')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reconciliation_revision := OLD.reconciliation_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_role_jobs_reconciliation_revision
BEFORE UPDATE OF status ON role_jobs
FOR EACH ROW EXECUTE FUNCTION phase17_bump_reconciliation_revision();

CREATE TRIGGER trg_outbox_events_reconciliation_revision
BEFORE UPDATE OF status ON outbox_events
FOR EACH ROW EXECUTE FUNCTION phase17_bump_reconciliation_revision();

CREATE TABLE phase17_reconciliation_actions (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  item_type TEXT NOT NULL CHECK (item_type IN ('ROLE_JOB', 'OUTBOX_EVENT')),
  item_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('RETRY', 'DEAD_LETTER')),
  actor_principal TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 16 AND 2000),
  evidence_ref TEXT NOT NULL CHECK (
    char_length(evidence_ref) BETWEEN 3 AND 512
    AND evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]*$'
  ),
  before_status TEXT NOT NULL CHECK (before_status IN ('NEEDS_RECONCILIATION', 'DEAD_LETTER')),
  after_status TEXT NOT NULL CHECK (after_status IN ('RETRY_WAIT', 'DEAD_LETTER')),
  before_revision BIGINT NOT NULL CHECK (before_revision >= 0),
  after_revision BIGINT NOT NULL CHECK (after_revision >= before_revision),
  snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (item_type, item_id, before_revision)
);

CREATE INDEX ix_phase17_reconciliation_actions_item
  ON phase17_reconciliation_actions(item_type, item_id, id DESC);

CREATE TRIGGER trg_phase17_reconciliation_actions_append_only
BEFORE UPDATE OR DELETE ON phase17_reconciliation_actions
FOR EACH ROW EXECUTE FUNCTION phase17_append_only();

CREATE OR REPLACE FUNCTION reconcile_phase17_item(
  p_request_id TEXT,
  p_item_type TEXT,
  p_item_id TEXT,
  p_decision TEXT,
  p_expected_revision BIGINT,
  p_reason TEXT,
  p_evidence_ref TEXT
)
RETURNS phase17_reconciliation_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_action phase17_reconciliation_actions%ROWTYPE;
  action_row phase17_reconciliation_actions%ROWTYPE;
  job_row role_jobs%ROWTYPE;
  outbox_row outbox_events%ROWTYPE;
  after_status TEXT;
  after_revision BIGINT;
  unresolved_siblings INTEGER;
BEGIN
  IF p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'reconciliation request id is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_item_type NOT IN ('ROLE_JOB', 'OUTBOX_EVENT') THEN
    RAISE EXCEPTION 'unsupported reconciliation item type' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_item_id, '') = '' OR char_length(p_item_id) > 200 THEN
    RAISE EXCEPTION 'reconciliation item id is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_decision NOT IN ('RETRY', 'DEAD_LETTER') THEN
    RAISE EXCEPTION 'unsupported reconciliation decision' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'expected reconciliation revision is invalid' USING ERRCODE = '22023';
  END IF;
  IF char_length(BTRIM(COALESCE(p_reason, ''))) NOT BETWEEN 16 AND 2000 THEN
    RAISE EXCEPTION 'reconciliation reason must contain 16 to 2000 characters' USING ERRCODE = '22023';
  END IF;
  IF char_length(BTRIM(COALESCE(p_evidence_ref, ''))) NOT BETWEEN 3 AND 512
     OR BTRIM(COALESCE(p_evidence_ref, '')) !~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]+$' THEN
    RAISE EXCEPTION 'reconciliation evidence reference is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO existing_action
  FROM phase17_reconciliation_actions
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF existing_action.item_type <> p_item_type
       OR existing_action.item_id <> p_item_id
       OR existing_action.decision <> p_decision
       OR existing_action.before_revision <> p_expected_revision
       OR existing_action.reason <> BTRIM(p_reason)
       OR existing_action.evidence_ref <> BTRIM(p_evidence_ref) THEN
      RAISE EXCEPTION 'reconciliation request id was already used with different input' USING ERRCODE = '22023';
    END IF;
    RETURN existing_action;
  END IF;

  after_status := CASE WHEN p_decision = 'RETRY' THEN 'RETRY_WAIT' ELSE 'DEAD_LETTER' END;

  IF p_item_type = 'ROLE_JOB' THEN
    SELECT * INTO job_row
    FROM role_jobs
    WHERE id = p_item_id
      AND status IN ('NEEDS_RECONCILIATION', 'DEAD_LETTER')
      AND reconciliation_revision = p_expected_revision
    FOR UPDATE;
    IF NOT FOUND THEN
      SELECT * INTO existing_action FROM phase17_reconciliation_actions WHERE request_id = p_request_id;
      IF FOUND THEN
        IF existing_action.item_type <> p_item_type
           OR existing_action.item_id <> p_item_id
           OR existing_action.decision <> p_decision
           OR existing_action.before_revision <> p_expected_revision
           OR existing_action.reason <> BTRIM(p_reason)
           OR existing_action.evidence_ref <> BTRIM(p_evidence_ref) THEN
          RAISE EXCEPTION 'reconciliation request id was already used with different input' USING ERRCODE = '22023';
        END IF;
        RETURN existing_action;
      END IF;
      RAISE EXCEPTION 'role job reconciliation compare-and-set failed' USING ERRCODE = '55000';
    END IF;

    IF p_decision = 'RETRY' THEN
      IF job_row.output_artifact_id IS NOT NULL THEN
        RAISE EXCEPTION 'role job with an output artifact cannot be retried by operator recovery' USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM tasks
        WHERE id = job_row.task_id AND control_state = 'RUNNING'
      ) THEN
        RAISE EXCEPTION 'role job task control state must be RUNNING before retry' USING ERRCODE = '55000';
      END IF;
      SELECT COUNT(*)::int INTO unresolved_siblings
      FROM role_jobs sibling
      WHERE sibling.workflow_run_id = job_row.workflow_run_id
        AND sibling.id <> job_row.id
        AND sibling.status IN ('NEEDS_RECONCILIATION', 'DEAD_LETTER')
        AND NOT EXISTS (
          SELECT 1 FROM phase17_reconciliation_actions action
          WHERE action.item_type = 'ROLE_JOB'
            AND action.item_id = sibling.id
            AND action.after_status = sibling.status
            AND action.after_revision = sibling.reconciliation_revision
        );
      IF unresolved_siblings > 0 THEN
        RAISE EXCEPTION 'role job retry is blocked by another unresolved workflow job' USING ERRCODE = '55000';
      END IF;

      UPDATE role_jobs
      SET status = 'RETRY_WAIT',
          available_at = clock_timestamp(),
          max_attempts = GREATEST(max_attempts, attempt_count + 1),
          claimed_by_instance_id = NULL,
          claim_token = NULL,
          claimed_at = NULL,
          heartbeat_at = NULL,
          lease_expires_at = NULL,
          last_error_code = 'OPERATOR_RETRY_AUTHORIZED',
          last_error_detail_redacted = NULL,
          failure_fingerprint = NULL,
          updated_at = clock_timestamp()
      WHERE id = job_row.id
      RETURNING reconciliation_revision INTO after_revision;
      UPDATE bot_instances
      SET status = CASE WHEN status = 'BUSY' THEN 'ONLINE' ELSE status END,
          current_job_id = NULL,
          updated_at = clock_timestamp()
      WHERE current_job_id = job_row.id;
      UPDATE workflow_nodes
      SET status = 'READY', completed_at = NULL, row_version = row_version + 1, updated_at = clock_timestamp()
      WHERE id = job_row.workflow_node_id AND status IN ('NEEDS_RECONCILIATION', 'FAILED');
      UPDATE workflow_runs
      SET status = 'RUNNING', completed_at = NULL, row_version = row_version + 1, updated_at = clock_timestamp()
      WHERE id = job_row.workflow_run_id AND status IN ('NEEDS_RECONCILIATION', 'FAILED');
      UPDATE tasks
      SET lifecycle_status = 'RUNNING', row_version = row_version + 1, updated_at = clock_timestamp()
      WHERE id = job_row.task_id AND lifecycle_status IN ('RUNNING', 'FAILED', 'NEEDS_RECONCILIATION');
    ELSE
      UPDATE role_jobs
      SET status = 'DEAD_LETTER',
          claimed_by_instance_id = NULL,
          claim_token = NULL,
          claimed_at = NULL,
          heartbeat_at = NULL,
          lease_expires_at = NULL,
          last_error_code = COALESCE(last_error_code, 'OPERATOR_DEAD_LETTER'),
          updated_at = clock_timestamp()
      WHERE id = job_row.id
      RETURNING reconciliation_revision INTO after_revision;
      UPDATE bot_instances
      SET status = CASE WHEN status = 'BUSY' THEN 'ONLINE' ELSE status END,
          current_job_id = NULL,
          updated_at = clock_timestamp()
      WHERE current_job_id = job_row.id;
      UPDATE workflow_nodes
      SET status = 'FAILED', completed_at = COALESCE(completed_at, clock_timestamp()),
          row_version = row_version + 1, updated_at = clock_timestamp()
      WHERE id = job_row.workflow_node_id AND status IN ('NEEDS_RECONCILIATION', 'FAILED');

      SELECT COUNT(*)::int INTO unresolved_siblings
      FROM role_jobs sibling
      WHERE sibling.workflow_run_id = job_row.workflow_run_id
        AND sibling.id <> job_row.id
        AND sibling.status IN ('NEEDS_RECONCILIATION', 'DEAD_LETTER')
        AND NOT EXISTS (
          SELECT 1 FROM phase17_reconciliation_actions action
          WHERE action.item_type = 'ROLE_JOB'
            AND action.item_id = sibling.id
            AND action.after_status = sibling.status
            AND action.after_revision = sibling.reconciliation_revision
        );
      IF unresolved_siblings = 0 THEN
        UPDATE workflow_runs
        SET status = 'FAILED', completed_at = COALESCE(completed_at, clock_timestamp()),
            row_version = row_version + 1, updated_at = clock_timestamp()
        WHERE id = job_row.workflow_run_id AND status IN ('RUNNING', 'NEEDS_RECONCILIATION', 'FAILED');
        UPDATE tasks
        SET lifecycle_status = 'FAILED', row_version = row_version + 1, updated_at = clock_timestamp()
        WHERE id = job_row.task_id AND lifecycle_status IN ('RUNNING', 'FAILED', 'NEEDS_RECONCILIATION');
      END IF;
    END IF;

    INSERT INTO job_events(
      role_job_id, workflow_run_id, workflow_node_id, event_type, event_payload
    ) VALUES (
      job_row.id, job_row.workflow_run_id, job_row.workflow_node_id,
      CASE WHEN p_decision = 'RETRY' THEN 'OPERATOR_RETRY_AUTHORIZED' ELSE 'OPERATOR_DEAD_LETTER' END,
      jsonb_build_object('requestId', p_request_id, 'evidenceRef', BTRIM(p_evidence_ref))
    );
    INSERT INTO workflow_events(
      workflow_run_id, workflow_node_id, task_id, event_type, correlation_id, event_payload
    ) VALUES (
      job_row.workflow_run_id, job_row.workflow_node_id, job_row.task_id,
      'OPERATOR_RECONCILIATION', job_row.correlation_id,
      jsonb_build_object('requestId', p_request_id, 'decision', p_decision, 'evidenceRef', BTRIM(p_evidence_ref))
    );

    INSERT INTO phase17_reconciliation_actions(
      request_id, item_type, item_id, decision, actor_principal, reason, evidence_ref,
      before_status, after_status, before_revision, after_revision, snapshot_json
    ) VALUES (
      p_request_id, p_item_type, p_item_id, p_decision, SESSION_USER, BTRIM(p_reason), BTRIM(p_evidence_ref),
      job_row.status, after_status, job_row.reconciliation_revision, after_revision,
      jsonb_build_object(
        'targetRole', job_row.target_role,
        'jobType', job_row.job_type,
        'attemptCount', job_row.attempt_count,
        'maxAttempts', job_row.max_attempts,
        'safeToRetry', job_row.safe_to_retry,
        'lastErrorCode', job_row.last_error_code
      )
    )
    RETURNING * INTO action_row;
  ELSE
    SELECT * INTO outbox_row
    FROM outbox_events
    WHERE id = p_item_id
      AND status IN ('NEEDS_RECONCILIATION', 'DEAD_LETTER')
      AND reconciliation_revision = p_expected_revision
    FOR UPDATE;
    IF NOT FOUND THEN
      SELECT * INTO existing_action FROM phase17_reconciliation_actions WHERE request_id = p_request_id;
      IF FOUND THEN
        IF existing_action.item_type <> p_item_type
           OR existing_action.item_id <> p_item_id
           OR existing_action.decision <> p_decision
           OR existing_action.before_revision <> p_expected_revision
           OR existing_action.reason <> BTRIM(p_reason)
           OR existing_action.evidence_ref <> BTRIM(p_evidence_ref) THEN
          RAISE EXCEPTION 'reconciliation request id was already used with different input' USING ERRCODE = '22023';
        END IF;
        RETURN existing_action;
      END IF;
      RAISE EXCEPTION 'outbox reconciliation compare-and-set failed' USING ERRCODE = '55000';
    END IF;

    IF p_decision = 'RETRY' THEN
      UPDATE outbox_events
      SET status = 'RETRY_WAIT',
          available_at = clock_timestamp(),
          max_attempts = GREATEST(max_attempts, attempt_count + 1),
          claimed_by_instance_id = NULL,
          claim_token = NULL,
          lease_expires_at = NULL,
          last_error_code = 'OPERATOR_RETRY_AUTHORIZED',
          last_error_detail_redacted = NULL,
          updated_at = clock_timestamp()
      WHERE id = outbox_row.id
      RETURNING reconciliation_revision INTO after_revision;
      UPDATE discord_publications
      SET status = CASE WHEN status IN ('POSTED', 'SHADOWED') THEN status ELSE 'PENDING' END,
          updated_at = clock_timestamp()
      WHERE outbox_event_id = outbox_row.id;
    ELSE
      UPDATE outbox_events
      SET status = 'DEAD_LETTER',
          claimed_by_instance_id = NULL,
          claim_token = NULL,
          lease_expires_at = NULL,
          last_error_code = COALESCE(last_error_code, 'OPERATOR_DEAD_LETTER'),
          updated_at = clock_timestamp()
      WHERE id = outbox_row.id
      RETURNING reconciliation_revision INTO after_revision;
      UPDATE discord_publications
      SET status = CASE WHEN status IN ('POSTED', 'SHADOWED') THEN status ELSE 'DEAD_LETTER' END,
          updated_at = clock_timestamp()
      WHERE outbox_event_id = outbox_row.id;
    END IF;

    INSERT INTO phase17_reconciliation_actions(
      request_id, item_type, item_id, decision, actor_principal, reason, evidence_ref,
      before_status, after_status, before_revision, after_revision, snapshot_json
    ) VALUES (
      p_request_id, p_item_type, p_item_id, p_decision, SESSION_USER, BTRIM(p_reason), BTRIM(p_evidence_ref),
      outbox_row.status, after_status, outbox_row.reconciliation_revision, after_revision,
      jsonb_build_object(
        'targetRole', outbox_row.target_role,
        'eventType', outbox_row.event_type,
        'attemptCount', outbox_row.attempt_count,
        'maxAttempts', outbox_row.max_attempts,
        'lastErrorCode', outbox_row.last_error_code,
        'hasPublication', EXISTS (
          SELECT 1 FROM discord_publications publication WHERE publication.outbox_event_id = outbox_row.id
        )
      )
    )
    RETURNING * INTO action_row;
  END IF;

  RETURN action_row;
END;
$$;

REVOKE ALL ON TABLE phase17_reconciliation_actions FROM PUBLIC;
REVOKE ALL ON SEQUENCE phase17_reconciliation_actions_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION phase17_bump_reconciliation_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_phase17_item(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC;
