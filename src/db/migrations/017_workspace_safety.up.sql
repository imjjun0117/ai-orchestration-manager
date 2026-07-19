-- Phase 16: task-isolated workspace safety, artifact-bound approvals, and fenced finalization.

CREATE TABLE workspace_lock_heads (
  workspace_id TEXT PRIMARY KEY,
  current_fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (current_fencing_token >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspace_leases (
  lease_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace_lock_heads(workspace_id) ON DELETE CASCADE,
  lease_owner_instance_id TEXT NOT NULL,
  lease_owner_task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE SET NULL,
  lease_owner_operation_id TEXT NOT NULL,
  lease_owner_job_id TEXT,
  fencing_token BIGINT NOT NULL CHECK (fencing_token >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('READ_SHARED', 'WRITE_EXCLUSIVE', 'FINALIZE_EXCLUSIVE')),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object')
);

CREATE UNIQUE INDEX uq_workspace_lease_active_operation
  ON workspace_leases(workspace_id, lease_owner_operation_id)
  WHERE released_at IS NULL;

CREATE INDEX ix_workspace_lease_active
  ON workspace_leases(workspace_id, mode, expires_at)
  WHERE released_at IS NULL;

CREATE TABLE isolated_workspaces (
  id TEXT PRIMARY KEY,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL,
  lease_id TEXT REFERENCES workspace_leases(lease_id) ON DELETE SET NULL,
  lease_owner_operation_id TEXT NOT NULL,
  canonical_repository_path TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL CHECK (base_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  candidate_commit_sha TEXT CHECK (candidate_commit_sha IS NULL OR candidate_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  status TEXT NOT NULL DEFAULT 'CREATING' CHECK (
    status IN ('CREATING', 'READY', 'ACTIVE', 'CANDIDATE_READY', 'CLEANUP_PENDING', 'CLEANED', 'NEEDS_RECONCILIATION')
  ),
  cleanup_error TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleaned_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_isolated_workspace_operation
  ON isolated_workspaces(workspace_id, lease_owner_operation_id);

CREATE INDEX ix_isolated_workspace_reconciliation
  ON isolated_workspaces(status, updated_at)
  WHERE status IN ('CLEANUP_PENDING', 'NEEDS_RECONCILIATION');

ALTER TABLE tasks ADD COLUMN control_state TEXT NOT NULL DEFAULT 'RUNNING'
  CHECK (control_state IN ('RUNNING', 'PAUSED', 'CANCEL_REQUESTED', 'CANCELLED', 'NEEDS_RECONCILIATION'));
ALTER TABLE tasks ADD COLUMN row_version BIGINT NOT NULL DEFAULT 0 CHECK (row_version >= 0);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE SET NULL,
  workspace_id TEXT,
  isolated_workspace_id TEXT REFERENCES isolated_workspaces(id) ON DELETE SET NULL,
  artifact_type TEXT NOT NULL,
  artifact_hash TEXT NOT NULL CHECK (artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  diff_hash TEXT CHECK (diff_hash IS NULL OR diff_hash ~ '^sha256:[0-9a-f]{64}$'),
  context_manifest_hash TEXT CHECK (context_manifest_hash IS NULL OR context_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  base_commit_sha TEXT CHECK (base_commit_sha IS NULL OR base_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  candidate_commit_sha TEXT CHECK (candidate_commit_sha IS NULL OR candidate_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  manifest_json JSONB NOT NULL CHECK (jsonb_typeof(manifest_json) = 'object'),
  file_manifest_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(file_manifest_json) = 'array'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ix_artifacts_task_type
  ON artifacts(task_id, artifact_type, created_at DESC);

ALTER TABLE approvals ADD COLUMN artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT;
ALTER TABLE approvals ADD COLUMN artifact_hash TEXT;
ALTER TABLE approvals ADD COLUMN context_manifest_hash TEXT;
ALTER TABLE approvals ADD COLUMN base_commit_sha TEXT;
ALTER TABLE approvals ADD COLUMN candidate_commit_sha TEXT;
ALTER TABLE approvals ADD COLUMN workspace_id TEXT;
ALTER TABLE approvals ADD COLUMN lease_owner_operation_id TEXT;
ALTER TABLE approvals ADD COLUMN fencing_token BIGINT;
ALTER TABLE approvals ADD COLUMN delegation_scope JSONB;
ALTER TABLE approvals ADD COLUMN expected_task_state TEXT;
ALTER TABLE approvals ADD COLUMN expected_task_version BIGINT;
ALTER TABLE approvals ADD COLUMN expires_at TIMESTAMPTZ;

ALTER TABLE approvals ADD CONSTRAINT ck_approval_artifact_hash
  CHECK (artifact_hash IS NULL OR artifact_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE approvals ADD CONSTRAINT ck_approval_context_hash
  CHECK (context_manifest_hash IS NULL OR context_manifest_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE approvals ADD CONSTRAINT ck_approval_base_sha
  CHECK (base_commit_sha IS NULL OR base_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');
ALTER TABLE approvals ADD CONSTRAINT ck_approval_candidate_sha
  CHECK (candidate_commit_sha IS NULL OR candidate_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');
ALTER TABLE approvals ADD CONSTRAINT ck_approval_delegation_scope
  CHECK (delegation_scope IS NULL OR jsonb_typeof(delegation_scope) = 'object');
ALTER TABLE approvals ADD CONSTRAINT ck_approval_expected_task_version
  CHECK (expected_task_version IS NULL OR expected_task_version >= 0);

CREATE TABLE workspace_finalizations (
  id TEXT PRIMARY KEY,
  approval_id BIGINT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE SET NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES workspace_leases(lease_id) ON DELETE RESTRICT,
  lease_owner_operation_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL,
  base_commit_sha TEXT NOT NULL CHECK (base_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  candidate_commit_sha TEXT NOT NULL CHECK (candidate_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  artifact_hash TEXT NOT NULL CHECK (artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  context_manifest_hash TEXT NOT NULL CHECK (context_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_ref TEXT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED', 'SUCCEEDED', 'NEEDS_RECONCILIATION', 'FAILED')),
  claimed_by TEXT NOT NULL,
  integrated_commit_sha TEXT,
  error_message TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, target_ref, candidate_commit_sha)
);

CREATE TABLE workspace_safety_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id VARCHAR(50),
  isolated_workspace_id TEXT,
  finalization_id TEXT,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ix_workspace_safety_events_workspace
  ON workspace_safety_events(workspace_id, created_at DESC);

CREATE OR REPLACE FUNCTION phase16_immutable_artifact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artifact rows are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_phase16_artifact_immutable
BEFORE UPDATE OR DELETE ON artifacts
FOR EACH ROW EXECUTE FUNCTION phase16_immutable_artifact();

CREATE OR REPLACE FUNCTION phase16_append_only_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace safety events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_phase16_event_append_only
BEFORE UPDATE OR DELETE ON workspace_safety_events
FOR EACH ROW EXECUTE FUNCTION phase16_append_only_event();

CREATE OR REPLACE FUNCTION phase16_stale_superseded_approvals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND NEW.artifact_type = 'CANDIDATE_COMMIT' THEN
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

CREATE TRIGGER trg_phase16_stale_superseded_approvals
AFTER INSERT ON artifacts
FOR EACH ROW EXECUTE FUNCTION phase16_stale_superseded_approvals();

CREATE OR REPLACE FUNCTION acquire_workspace_lease(
  p_lease_id TEXT,
  p_workspace_id TEXT,
  p_owner_instance_id TEXT,
  p_owner_task_id VARCHAR,
  p_owner_operation_id TEXT,
  p_owner_job_id TEXT,
  p_mode TEXT,
  p_ttl_ms INTEGER,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS workspace_leases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  head_row workspace_lock_heads%ROWTYPE;
  lease_row workspace_leases%ROWTYPE;
  issued_token BIGINT;
BEGIN
  IF p_mode NOT IN ('READ_SHARED', 'WRITE_EXCLUSIVE', 'FINALIZE_EXCLUSIVE') THEN
    RAISE EXCEPTION 'unsupported workspace lease mode %', p_mode USING ERRCODE = '22023';
  END IF;
  IF p_ttl_ms IS NULL OR p_ttl_ms <= 0 THEN
    RAISE EXCEPTION 'workspace lease ttl must be positive' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(BTRIM(p_owner_operation_id), '') IS NULL THEN
    RAISE EXCEPTION 'lease owner operation id is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO workspace_lock_heads(workspace_id) VALUES (p_workspace_id)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT * INTO head_row
  FROM workspace_lock_heads
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  UPDATE workspace_leases
  SET released_at = COALESCE(released_at, CURRENT_TIMESTAMP)
  WHERE workspace_id = p_workspace_id
    AND released_at IS NULL
    AND expires_at <= CURRENT_TIMESTAMP;

  IF p_mode = 'READ_SHARED' THEN
    IF EXISTS (
      SELECT 1 FROM workspace_leases
      WHERE workspace_id = p_workspace_id
        AND released_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
        AND mode <> 'READ_SHARED'
    ) THEN
      RAISE EXCEPTION 'workspace % has an active exclusive lease', p_workspace_id USING ERRCODE = '55P03';
    END IF;
    issued_token := head_row.current_fencing_token;
  ELSE
    IF EXISTS (
      SELECT 1 FROM workspace_leases
      WHERE workspace_id = p_workspace_id
        AND released_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
    ) THEN
      RAISE EXCEPTION 'workspace % has active lease holders', p_workspace_id USING ERRCODE = '55P03';
    END IF;
    UPDATE workspace_lock_heads
    SET current_fencing_token = current_fencing_token + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = p_workspace_id
    RETURNING current_fencing_token INTO issued_token;
  END IF;

  INSERT INTO workspace_leases(
    lease_id, workspace_id, lease_owner_instance_id, lease_owner_task_id,
    lease_owner_operation_id, lease_owner_job_id, fencing_token, mode,
    expires_at, metadata_json
  ) VALUES (
    p_lease_id, p_workspace_id, p_owner_instance_id, p_owner_task_id,
    p_owner_operation_id, p_owner_job_id, issued_token, p_mode,
    CURRENT_TIMESTAMP + (p_ttl_ms * INTERVAL '1 millisecond'), COALESCE(p_metadata, '{}'::jsonb)
  ) RETURNING * INTO lease_row;

  INSERT INTO workspace_safety_events(workspace_id, task_id, event_type, actor_id, event_payload)
  VALUES (
    p_workspace_id,
    p_owner_task_id,
    'WORKSPACE_LEASE_ACQUIRED',
    p_owner_instance_id,
    jsonb_build_object('leaseId', p_lease_id, 'operationId', p_owner_operation_id, 'mode', p_mode, 'fencingToken', issued_token)
  );

  RETURN lease_row;
END;
$$;

CREATE OR REPLACE FUNCTION heartbeat_workspace_lease(
  p_lease_id TEXT,
  p_owner_instance_id TEXT,
  p_owner_operation_id TEXT,
  p_fencing_token BIGINT,
  p_ttl_ms INTEGER
)
RETURNS workspace_leases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  lease_row workspace_leases%ROWTYPE;
BEGIN
  IF p_ttl_ms IS NULL OR p_ttl_ms <= 0 THEN
    RAISE EXCEPTION 'workspace lease ttl must be positive' USING ERRCODE = '22023';
  END IF;
  UPDATE workspace_leases l
  SET heartbeat_at = CURRENT_TIMESTAMP,
      expires_at = CURRENT_TIMESTAMP + (p_ttl_ms * INTERVAL '1 millisecond')
  FROM workspace_lock_heads h
  WHERE l.lease_id = p_lease_id
    AND h.workspace_id = l.workspace_id
    AND l.lease_owner_instance_id = p_owner_instance_id
    AND l.lease_owner_operation_id = p_owner_operation_id
    AND l.fencing_token = p_fencing_token
    AND l.released_at IS NULL
    AND l.expires_at > CURRENT_TIMESTAMP
    AND (l.mode = 'READ_SHARED' OR h.current_fencing_token = p_fencing_token)
  RETURNING l.* INTO lease_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace lease heartbeat rejected' USING ERRCODE = '55000';
  END IF;
  RETURN lease_row;
END;
$$;

CREATE OR REPLACE FUNCTION release_workspace_lease(
  p_lease_id TEXT,
  p_owner_instance_id TEXT,
  p_owner_operation_id TEXT,
  p_fencing_token BIGINT
)
RETURNS workspace_leases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  lease_row workspace_leases%ROWTYPE;
BEGIN
  UPDATE workspace_leases
  SET released_at = CURRENT_TIMESTAMP
  WHERE lease_id = p_lease_id
    AND lease_owner_instance_id = p_owner_instance_id
    AND lease_owner_operation_id = p_owner_operation_id
    AND fencing_token = p_fencing_token
    AND released_at IS NULL
  RETURNING * INTO lease_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace lease release rejected' USING ERRCODE = '55000';
  END IF;

  INSERT INTO workspace_safety_events(workspace_id, task_id, event_type, actor_id, event_payload)
  VALUES (
    lease_row.workspace_id,
    lease_row.lease_owner_task_id,
    'WORKSPACE_LEASE_RELEASED',
    p_owner_instance_id,
    jsonb_build_object('leaseId', p_lease_id, 'operationId', p_owner_operation_id, 'fencingToken', p_fencing_token)
  );
  RETURN lease_row;
END;
$$;

CREATE OR REPLACE FUNCTION claim_candidate_finalization(
  p_finalization_id TEXT,
  p_approval_id BIGINT,
  p_artifact_id TEXT,
  p_workspace_id TEXT,
  p_lease_id TEXT,
  p_owner_operation_id TEXT,
  p_fencing_token BIGINT,
  p_base_commit_sha TEXT,
  p_candidate_commit_sha TEXT,
  p_artifact_hash TEXT,
  p_context_manifest_hash TEXT,
  p_target_ref TEXT,
  p_claim_token TEXT,
  p_actor_id TEXT
)
RETURNS workspace_finalizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  head_row workspace_lock_heads%ROWTYPE;
  lease_row workspace_leases%ROWTYPE;
  approval_row approvals%ROWTYPE;
  artifact_row artifacts%ROWTYPE;
  task_status TEXT;
  task_version BIGINT;
  finalization_row workspace_finalizations%ROWTYPE;
BEGIN
  SELECT * INTO head_row FROM workspace_lock_heads WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR head_row.current_fencing_token <> p_fencing_token THEN
    RAISE EXCEPTION 'stale workspace fencing token' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO lease_row FROM workspace_leases WHERE lease_id = p_lease_id FOR UPDATE;
  IF NOT FOUND
     OR lease_row.workspace_id <> p_workspace_id
     OR lease_row.mode <> 'FINALIZE_EXCLUSIVE'
     OR lease_row.lease_owner_operation_id <> p_owner_operation_id
     OR lease_row.fencing_token <> p_fencing_token
     OR lease_row.released_at IS NOT NULL
     OR lease_row.expires_at <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'finalizer does not own a live FINALIZE_EXCLUSIVE lease' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO approval_row FROM approvals WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND OR approval_row.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'finalization requires an approved approval' USING ERRCODE = '55000';
  END IF;
  IF approval_row.expires_at IS NULL OR approval_row.expires_at <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'approval has expired' USING ERRCODE = '55000';
  END IF;
  IF approval_row.expected_task_state IS NULL OR approval_row.expected_task_version IS NULL THEN
    RAISE EXCEPTION 'finalization approval must bind expected task state and version' USING ERRCODE = '55000';
  END IF;
  IF approval_row.delegation_scope IS NULL
     OR NOT (
       approval_row.delegation_scope @> jsonb_build_object('allowedActorIds', jsonb_build_array(p_actor_id))
       AND approval_row.delegation_scope @> jsonb_build_object('allowedTargetRefs', jsonb_build_array(p_target_ref))
     ) THEN
    RAISE EXCEPTION 'finalizer actor or target ref is outside the approval delegation scope' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO artifact_row FROM artifacts WHERE id = p_artifact_id;
  IF NOT FOUND OR artifact_row.artifact_type <> 'CANDIDATE_COMMIT' THEN
    RAISE EXCEPTION 'candidate artifact does not exist' USING ERRCODE = '55000';
  END IF;

  IF approval_row.artifact_id IS DISTINCT FROM p_artifact_id
     OR approval_row.workspace_id IS DISTINCT FROM p_workspace_id
     OR approval_row.lease_owner_operation_id IS DISTINCT FROM p_owner_operation_id
     OR approval_row.fencing_token IS DISTINCT FROM p_fencing_token
     OR approval_row.base_commit_sha IS DISTINCT FROM p_base_commit_sha
     OR approval_row.candidate_commit_sha IS DISTINCT FROM p_candidate_commit_sha
     OR approval_row.artifact_hash IS DISTINCT FROM p_artifact_hash
     OR approval_row.context_manifest_hash IS DISTINCT FROM p_context_manifest_hash THEN
    RAISE EXCEPTION 'approval binding does not match finalization input' USING ERRCODE = '55000';
  END IF;

  IF artifact_row.base_commit_sha IS DISTINCT FROM p_base_commit_sha
     OR artifact_row.candidate_commit_sha IS DISTINCT FROM p_candidate_commit_sha
     OR artifact_row.artifact_hash IS DISTINCT FROM p_artifact_hash
     OR artifact_row.context_manifest_hash IS DISTINCT FROM p_context_manifest_hash THEN
    RAISE EXCEPTION 'artifact binding does not match finalization input' USING ERRCODE = '55000';
  END IF;

  IF approval_row.expected_task_state IS NOT NULL AND approval_row.task_id IS NOT NULL THEN
    SELECT status, row_version INTO task_status, task_version FROM tasks WHERE id = approval_row.task_id;
    IF task_status IS DISTINCT FROM approval_row.expected_task_state
       OR task_version IS DISTINCT FROM approval_row.expected_task_version THEN
      RAISE EXCEPTION 'task state or version does not match approval expectation' USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO workspace_finalizations(
    id, approval_id, task_id, artifact_id, workspace_id, lease_id,
    lease_owner_operation_id, fencing_token, base_commit_sha, candidate_commit_sha,
    artifact_hash, context_manifest_hash, target_ref, claim_token, claimed_by
  ) VALUES (
    p_finalization_id, p_approval_id, approval_row.task_id, p_artifact_id, p_workspace_id, p_lease_id,
    p_owner_operation_id, p_fencing_token, p_base_commit_sha, p_candidate_commit_sha,
    p_artifact_hash, p_context_manifest_hash, p_target_ref, p_claim_token, p_actor_id
  ) RETURNING * INTO finalization_row;

  INSERT INTO workspace_safety_events(workspace_id, task_id, finalization_id, event_type, actor_id, event_payload)
  VALUES (
    p_workspace_id,
    approval_row.task_id,
    p_finalization_id,
    'FINALIZATION_CLAIMED',
    p_actor_id,
    jsonb_build_object('approvalId', p_approval_id, 'artifactId', p_artifact_id, 'candidateCommitSha', p_candidate_commit_sha, 'fencingToken', p_fencing_token)
  );
  RETURN finalization_row;
END;
$$;

CREATE OR REPLACE FUNCTION complete_candidate_finalization(
  p_finalization_id TEXT,
  p_claim_token TEXT,
  p_status TEXT,
  p_integrated_commit_sha TEXT,
  p_error_message TEXT,
  p_actor_id TEXT
)
RETURNS workspace_finalizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  finalization_row workspace_finalizations%ROWTYPE;
  head_token BIGINT;
  lease_row workspace_leases%ROWTYPE;
BEGIN
  IF p_status NOT IN ('SUCCEEDED', 'NEEDS_RECONCILIATION', 'FAILED') THEN
    RAISE EXCEPTION 'unsupported finalization terminal status %', p_status USING ERRCODE = '22023';
  END IF;
  SELECT * INTO finalization_row
  FROM workspace_finalizations
  WHERE id = p_finalization_id AND claim_token = p_claim_token
  FOR UPDATE;
  IF NOT FOUND OR finalization_row.status <> 'CLAIMED' THEN
    RAISE EXCEPTION 'finalization claim is not active' USING ERRCODE = '55000';
  END IF;

  IF p_status = 'SUCCEEDED' THEN
    SELECT current_fencing_token INTO head_token
    FROM workspace_lock_heads
    WHERE workspace_id = finalization_row.workspace_id
    FOR UPDATE;
    SELECT * INTO lease_row FROM workspace_leases WHERE lease_id = finalization_row.lease_id FOR UPDATE;
    IF head_token IS DISTINCT FROM finalization_row.fencing_token
       OR lease_row.released_at IS NOT NULL
       OR lease_row.expires_at <= CURRENT_TIMESTAMP
       OR lease_row.fencing_token <> finalization_row.fencing_token
       OR lease_row.mode <> 'FINALIZE_EXCLUSIVE' THEN
      RAISE EXCEPTION 'finalization fence is no longer valid' USING ERRCODE = '55000';
    END IF;
    IF p_integrated_commit_sha IS DISTINCT FROM finalization_row.candidate_commit_sha THEN
      RAISE EXCEPTION 'integrated commit does not match approved candidate' USING ERRCODE = '55000';
    END IF;
  END IF;

  UPDATE workspace_finalizations
  SET status = p_status,
      integrated_commit_sha = p_integrated_commit_sha,
      error_message = p_error_message,
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_finalization_id
  RETURNING * INTO finalization_row;

  UPDATE workspace_leases
  SET released_at = COALESCE(released_at, CURRENT_TIMESTAMP)
  WHERE lease_id = finalization_row.lease_id;

  INSERT INTO workspace_safety_events(workspace_id, task_id, finalization_id, event_type, actor_id, event_payload)
  VALUES (
    finalization_row.workspace_id,
    finalization_row.task_id,
    finalization_row.id,
    CASE WHEN p_status = 'SUCCEEDED' THEN 'FINALIZATION_SUCCEEDED' ELSE 'FINALIZATION_' || p_status END,
    p_actor_id,
    jsonb_build_object('candidateCommitSha', finalization_row.candidate_commit_sha, 'integratedCommitSha', p_integrated_commit_sha, 'error', p_error_message)
  );
  RETURN finalization_row;
END;
$$;

REVOKE ALL ON TABLE workspace_lock_heads, workspace_leases, isolated_workspaces, artifacts,
  workspace_finalizations, workspace_safety_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE workspace_safety_events_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION acquire_workspace_lease(TEXT, TEXT, TEXT, VARCHAR, TEXT, TEXT, TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION heartbeat_workspace_lease(TEXT, TEXT, TEXT, BIGINT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workspace_lease(TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_candidate_finalization(TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_candidate_finalization(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION phase16_immutable_artifact() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase16_append_only_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase16_stale_superseded_approvals() FROM PUBLIC;
