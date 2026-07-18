-- Phase 15 hardening: SECURITY DEFINER governance functions are not public APIs.

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
        'phase15_assert_assignment',
        'phase15_assert_dependencies_accepted',
        'start_delivery_phase',
        'seal_phase_submission',
        'start_phase_validation',
        'complete_phase_validation',
        'fail_phase_validation_attempt',
        'start_phase_rework',
        'resolve_phase_finding',
        'register_phase_debt',
        'approve_phase_debt',
        'gate_delivery_phase'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_record.function_signature);
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE
  delivery_actors,
  delivery_phases,
  phase_dependencies,
  phase_assignments,
  phase_submissions,
  phase_validations,
  phase_validation_findings,
  phase_debts,
  phase_debt_approvals,
  phase_gate_events
FROM PUBLIC;

REVOKE ALL ON SEQUENCE
  phase_assignments_id_seq,
  phase_gate_events_id_seq
FROM PUBLIC;

