-- Phase 16 rollback. Disable isolated write activation before applying.

DROP FUNCTION IF EXISTS complete_candidate_finalization(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS claim_candidate_finalization(TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS release_workspace_lease(TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS heartbeat_workspace_lease(TEXT, TEXT, TEXT, BIGINT, INTEGER);
DROP FUNCTION IF EXISTS acquire_workspace_lease(TEXT, TEXT, TEXT, VARCHAR, TEXT, TEXT, TEXT, INTEGER, JSONB);

DROP TRIGGER IF EXISTS trg_phase16_stale_superseded_approvals ON artifacts;
DROP FUNCTION IF EXISTS phase16_stale_superseded_approvals();
DROP TRIGGER IF EXISTS trg_phase16_event_append_only ON workspace_safety_events;
DROP FUNCTION IF EXISTS phase16_append_only_event();
DROP TRIGGER IF EXISTS trg_phase16_artifact_immutable ON artifacts;
DROP FUNCTION IF EXISTS phase16_immutable_artifact();

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS ck_approval_delegation_scope;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS ck_approval_expected_task_version;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS ck_approval_candidate_sha;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS ck_approval_base_sha;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS ck_approval_context_hash;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS ck_approval_artifact_hash;

ALTER TABLE approvals DROP COLUMN IF EXISTS expires_at;
ALTER TABLE approvals DROP COLUMN IF EXISTS expected_task_version;
ALTER TABLE approvals DROP COLUMN IF EXISTS expected_task_state;
ALTER TABLE approvals DROP COLUMN IF EXISTS delegation_scope;
ALTER TABLE approvals DROP COLUMN IF EXISTS fencing_token;
ALTER TABLE approvals DROP COLUMN IF EXISTS lease_owner_operation_id;
ALTER TABLE approvals DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE approvals DROP COLUMN IF EXISTS candidate_commit_sha;
ALTER TABLE approvals DROP COLUMN IF EXISTS base_commit_sha;
ALTER TABLE approvals DROP COLUMN IF EXISTS context_manifest_hash;
ALTER TABLE approvals DROP COLUMN IF EXISTS artifact_hash;
ALTER TABLE approvals DROP COLUMN IF EXISTS artifact_id;

ALTER TABLE tasks DROP COLUMN IF EXISTS row_version;
ALTER TABLE tasks DROP COLUMN IF EXISTS control_state;

DROP TABLE IF EXISTS workspace_safety_events;
DROP TABLE IF EXISTS workspace_finalizations;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS isolated_workspaces;
DROP TABLE IF EXISTS workspace_leases;
DROP TABLE IF EXISTS workspace_lock_heads;
