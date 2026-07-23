-- Revert only the additional Phase 18 task-column privileges.

DO $$
DECLARE principal_row RECORD;
BEGIN
  FOR principal_row IN
    SELECT p.db_principal
    FROM bot_role_principals p
    JOIN pg_roles r ON r.rolname = p.db_principal
    WHERE p.enabled
      AND p.bot_role IN ('planner', 'coder', 'reviewer', 'qa', 'summarizer')
  LOOP
    EXECUTE format(
      'REVOKE SELECT (title, memory_project_key) ON TABLE tasks FROM %I',
      principal_row.db_principal
    );
  END LOOP;
END;
$$;
