-- Phase 15 rollback. Run only against a verified disposable or approved target DB.

DROP FUNCTION IF EXISTS gate_delivery_phase(TEXT, TEXT, TEXT, BIGINT, BOOLEAN);
DROP FUNCTION IF EXISTS approve_phase_debt(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS register_phase_debt(TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS resolve_phase_finding(TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS start_phase_rework(TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS fail_phase_validation_attempt(TEXT, TEXT, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS complete_phase_validation(TEXT, TEXT, JSONB, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS start_phase_validation(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS seal_phase_submission(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS start_delivery_phase(TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS phase15_assert_dependencies_accepted(TEXT);
DROP FUNCTION IF EXISTS phase15_assert_assignment(TEXT, TEXT, TEXT, TEXT);

DROP TRIGGER IF EXISTS trg_phase_assignment_separation ON phase_assignments;
DROP TRIGGER IF EXISTS trg_phase_validation_immutable ON phase_validations;
DROP TRIGGER IF EXISTS trg_phase_submission_immutable ON phase_submissions;
DROP TRIGGER IF EXISTS trg_phase_gate_events_append_only ON phase_gate_events;

DROP FUNCTION IF EXISTS phase15_check_assignment_separation();
DROP FUNCTION IF EXISTS phase15_protect_terminal_validation();
DROP FUNCTION IF EXISTS phase15_protect_sealed_submission();
DROP FUNCTION IF EXISTS phase15_reject_event_mutation();

ALTER TABLE IF EXISTS delivery_phases
  DROP CONSTRAINT IF EXISTS fk_delivery_phase_latest_submission;

DROP TABLE IF EXISTS phase_gate_events;
DROP TABLE IF EXISTS phase_debt_approvals;
DROP TABLE IF EXISTS phase_debts;
DROP TABLE IF EXISTS phase_validation_findings;
DROP TABLE IF EXISTS phase_validations;
DROP TABLE IF EXISTS phase_submissions;
DROP TABLE IF EXISTS phase_assignments;
DROP TABLE IF EXISTS phase_dependencies;
DROP TABLE IF EXISTS delivery_phases;
DROP TABLE IF EXISTS delivery_actors;

