-- Phase 17: requester-bound Discord approvals and candidate finalization handoff.

UPDATE workflow_definitions
SET graph_json = jsonb_set(graph_json, '{nodes,0,requiresApprovalAfter}', 'true'::jsonb, false)
WHERE id = 'phase17-coder-v1'
  AND graph_json->'nodes'->0->>'role' = 'coder';

CREATE OR REPLACE FUNCTION resolve_discord_workflow_approval(
  p_workflow_run_id TEXT,
  p_workflow_node_id TEXT,
  p_manager_instance_id TEXT,
  p_discord_user_id TEXT,
  p_channel_id TEXT,
  p_approved BOOLEAN,
  p_reason TEXT DEFAULT NULL
)
RETURNS workflow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manager_row bot_instances%ROWTYPE;
  run_row workflow_runs%ROWTYPE;
  node_row workflow_nodes%ROWTYPE;
  approval_row approvals%ROWTYPE;
  candidate_row approvals%ROWTYPE;
  task_row tasks%ROWTYPE;
  terminal_node BOOLEAN;
  candidate_workspace_status TEXT;
  candidate_finalization_status TEXT;
BEGIN
  IF NULLIF(BTRIM(p_discord_user_id), '') IS NULL
     OR NULLIF(BTRIM(p_channel_id), '') IS NULL THEN
    RAISE EXCEPTION 'Discord approval identity and channel are required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_approved AND NULLIF(BTRIM(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'workflow rejection requires a reason' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO manager_row
  FROM bot_instances
  WHERE instance_id = p_manager_instance_id
    AND bot_role = 'manager'
    AND db_principal = SESSION_USER
    AND status IN ('ONLINE', 'BUSY', 'DEGRADED')
    AND phase17_instance_authorized(p_manager_instance_id, 'manager')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow approval requires an active Manager' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO run_row
  FROM workflow_runs
  WHERE id = p_workflow_run_id AND status = 'WAITING_APPROVAL'
  FOR UPDATE;
  SELECT * INTO node_row
  FROM workflow_nodes
  WHERE id = p_workflow_node_id AND workflow_run_id = p_workflow_run_id
  FOR UPDATE;
  SELECT * INTO approval_row
  FROM approvals
  WHERE workflow_run_id = p_workflow_run_id
    AND workflow_node_id = p_workflow_node_id
    AND status = 'PENDING'
  FOR UPDATE;
  IF run_row.id IS NULL OR node_row.id IS NULL OR approval_row.id IS NULL THEN
    RAISE EXCEPTION 'pending workflow approval binding was not found' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO task_row
  FROM tasks
  WHERE id = run_row.task_id
    AND created_by = p_discord_user_id
    AND channel_id = p_channel_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow approval requester or channel binding changed' USING ERRCODE = '42501';
  END IF;

  IF task_row.row_version IS DISTINCT FROM approval_row.expected_task_version THEN
    SELECT NULLIF(node->>'next', '') IS NULL INTO terminal_node
    FROM workflow_definitions d,
         LATERAL jsonb_array_elements(d.graph_json->'nodes') node
    WHERE d.id = run_row.workflow_definition_id
      AND node->>'key' = node_row.node_key;
    IF NOT COALESCE(terminal_node, FALSE)
       OR task_row.row_version IS DISTINCT FROM approval_row.expected_task_version + 1 THEN
      RAISE EXCEPTION 'workflow approval task version changed' USING ERRCODE = '55000';
    END IF;

    SELECT * INTO candidate_row
    FROM approvals
    WHERE task_id = run_row.task_id
      AND action = 'commit_approval_phase16'
      AND artifact_id IS NOT NULL
      AND expected_task_state IS NOT DISTINCT FROM approval_row.expected_task_state
      AND expected_task_version IS NOT DISTINCT FROM approval_row.expected_task_version
    ORDER BY id DESC
    LIMIT 1;
    IF candidate_row.id IS NULL THEN
      RAISE EXCEPTION 'terminal workflow approval candidate binding was not found' USING ERRCODE = '55000';
    END IF;

    SELECT w.status INTO candidate_workspace_status
    FROM artifacts a
    JOIN isolated_workspaces w ON w.id = a.isolated_workspace_id
    WHERE a.id = candidate_row.artifact_id;

    IF p_approved THEN
      SELECT f.status INTO candidate_finalization_status
      FROM workspace_finalizations f
      WHERE f.approval_id = candidate_row.id
      ORDER BY f.claimed_at DESC
      LIMIT 1;
      IF candidate_row.status <> 'APPROVED'
         OR candidate_finalization_status IS DISTINCT FROM 'SUCCEEDED'
         OR candidate_workspace_status IS DISTINCT FROM 'CLEANED'
         OR task_row.status IS DISTINCT FROM 'DONE' THEN
        RAISE EXCEPTION 'approved candidate is not safely finalized' USING ERRCODE = '55000';
      END IF;
    ELSE
      IF candidate_row.status <> 'REJECTED'
         OR candidate_workspace_status IS DISTINCT FROM 'CLEANED'
         OR task_row.status IS DISTINCT FROM 'REJECTED'
         OR EXISTS (
           SELECT 1 FROM workspace_finalizations f
           WHERE f.approval_id = candidate_row.id AND f.status = 'SUCCEEDED'
         ) THEN
        RAISE EXCEPTION 'rejected candidate is not safely settled' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  UPDATE approvals
  SET status = CASE WHEN p_approved THEN 'APPROVED' ELSE 'REJECTED' END,
      approved_by = p_discord_user_id,
      reason = p_reason,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = approval_row.id;
  INSERT INTO workflow_events(
    workflow_run_id, workflow_node_id, task_id, event_type,
    actor_instance_id, correlation_id, event_payload
  ) VALUES (
    run_row.id, node_row.id, run_row.task_id,
    CASE WHEN p_approved THEN 'APPROVAL_GRANTED' ELSE 'APPROVAL_REJECTED' END,
    p_manager_instance_id, run_row.correlation_id,
    jsonb_build_object('reason', p_reason, 'resolvedByDiscordUserId', p_discord_user_id)
  );

  IF p_approved THEN
    UPDATE tasks
    SET lifecycle_status = 'RUNNING', row_version = row_version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.task_id;
    PERFORM phase17_schedule_next_node(
      run_row.id, node_row.id, p_manager_instance_id, node_row.output_artifact_id
    );
  ELSE
    UPDATE workflow_runs
    SET status = 'REJECTED', completed_at = CURRENT_TIMESTAMP,
        row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.id
    RETURNING * INTO run_row;
    UPDATE tasks
    SET lifecycle_status = 'REJECTED', row_version = row_version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.task_id;
  END IF;
  SELECT * INTO run_row FROM workflow_runs WHERE id = p_workflow_run_id;
  RETURN run_row;
END;
$$;

REVOKE ALL ON FUNCTION resolve_discord_workflow_approval(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;

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
      'REVOKE EXECUTE ON FUNCTION resolve_workflow_approval(TEXT,TEXT,TEXT,BOOLEAN,TEXT) FROM %I',
      principal_row.db_principal
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION resolve_discord_workflow_approval(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TEXT) TO %I',
      principal_row.db_principal
    );
    EXECUTE format(
      'GRANT SELECT ON workflow_definitions, workspace_finalizations TO %I',
      principal_row.db_principal
    );
  END LOOP;
END;
$$;
