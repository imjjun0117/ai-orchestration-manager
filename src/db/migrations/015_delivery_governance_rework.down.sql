-- Remove Phase 15 rework objects before the destructive core rollback.

DROP FUNCTION IF EXISTS gate_delivery_phase(TEXT, TEXT, TEXT, BIGINT, BOOLEAN);
DROP FUNCTION IF EXISTS accept_phase_debt_risk(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS approve_phase_debt(TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS cancel_delivery_phase(TEXT, TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS start_phase_rework(TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS fail_phase_validation_attempt(TEXT, TEXT, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS complete_phase_validation(TEXT, TEXT, JSONB, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS start_phase_validation(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS phase15_assert_dependencies_accepted(TEXT);
DROP FUNCTION IF EXISTS phase15_refresh_validation_projection(TEXT);
DROP FUNCTION IF EXISTS phase15_assert_not_submission_worker(TEXT, TEXT);

DROP TABLE IF EXISTS phase_dependency_activations;

ALTER TABLE IF EXISTS phase_debt_approvals
  DROP CONSTRAINT IF EXISTS ck_phase_debt_successor_safety,
  DROP COLUMN IF EXISTS safety_rationale,
  DROP COLUMN IF EXISTS successor_safe;

ALTER TABLE IF EXISTS phase_debts
  DROP CONSTRAINT IF EXISTS ck_phase_debt_risk_acceptance,
  DROP COLUMN IF EXISTS risk_accepted_at,
  DROP COLUMN IF EXISTS risk_accepted_by_actor_id;

ALTER TABLE IF EXISTS phase_submissions
  DROP CONSTRAINT IF EXISTS ck_phase_submission_candidate_commit_sha,
  DROP CONSTRAINT IF EXISTS ck_phase_submission_base_commit_sha;

DROP INDEX IF EXISTS uq_phase_assignment_active_actor;
