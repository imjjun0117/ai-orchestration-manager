DO $$
DECLARE
  principal_row RECORD;
BEGIN
  FOR principal_row IN
    SELECT p.db_principal
    FROM bot_role_principals p
    JOIN pg_roles r ON r.rolname = p.db_principal
    WHERE p.bot_role = 'manager' AND p.enabled
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION resolve_discord_workflow_approval(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TEXT) FROM %I',
      principal_row.db_principal
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION resolve_workflow_approval(TEXT,TEXT,TEXT,BOOLEAN,TEXT) TO %I',
      principal_row.db_principal
    );
    EXECUTE format(
      'REVOKE SELECT ON workflow_definitions, workspace_finalizations FROM %I',
      principal_row.db_principal
    );
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS resolve_discord_workflow_approval(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT);

UPDATE workflow_definitions
SET graph_json = jsonb_set(graph_json, '{nodes,0,requiresApprovalAfter}', 'false'::jsonb, false)
WHERE id = 'phase17-coder-v1'
  AND graph_json->'nodes'->0->>'role' = 'coder';
