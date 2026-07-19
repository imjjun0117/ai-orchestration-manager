-- Restore the Phase 16 round-1 behavior. Apply only after isolated writes are disabled.

DROP FUNCTION IF EXISTS reconcile_candidate_finalization(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT);
DROP TRIGGER IF EXISTS trg_phase16_guard_claimed_task_state ON tasks;
DROP FUNCTION IF EXISTS phase16_guard_claimed_task_state();
DROP TRIGGER IF EXISTS trg_phase16_validate_finalization_task_state ON workspace_finalizations;
DROP FUNCTION IF EXISTS phase16_validate_finalization_task_state();

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

REVOKE ALL ON FUNCTION phase16_stale_superseded_approvals() FROM PUBLIC;
