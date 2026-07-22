-- Phase 17 canary hardening: bounded role audit/process APIs and terminal-state consistency.

CREATE OR REPLACE FUNCTION phase17_instance_owns_running_task(
  p_instance_id TEXT,
  p_task_id VARCHAR
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bot_instances i
    JOIN role_jobs j
      ON j.claimed_by_instance_id = i.instance_id
     AND j.task_id = p_task_id
     AND j.status = 'RUNNING'
     AND j.lease_expires_at > CURRENT_TIMESTAMP
    WHERE i.instance_id = p_instance_id
      AND i.db_principal = SESSION_USER
      AND i.status IN ('ONLINE', 'BUSY', 'DEGRADED')
      AND phase17_instance_authorized(p_instance_id)
  )
$$;

CREATE OR REPLACE FUNCTION get_phase17_task_skill(
  p_instance_id TEXT,
  p_task_id VARCHAR
)
RETURNS TABLE(id VARCHAR, allowed_commands TEXT[], blocked_commands TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT phase17_instance_owns_running_task(p_instance_id, p_task_id) THEN
    RAISE EXCEPTION 'task skill lookup requires the active claimed task' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT s.id, s.allowed_commands, s.blocked_commands
    FROM tasks t
    JOIN skills s ON s.id = t.selected_skill_id
    WHERE t.id = p_task_id;
END;
$$;

CREATE OR REPLACE FUNCTION record_phase17_task_process(
  p_instance_id TEXT,
  p_task_id VARCHAR,
  p_pid INTEGER,
  p_pgid INTEGER,
  p_host_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_pid IS NULL OR p_pid <= 0 OR NULLIF(BTRIM(p_host_id), '') IS NULL THEN
    RAISE EXCEPTION 'task process identity is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT phase17_instance_owns_running_task(p_instance_id, p_task_id) THEN
    RAISE EXCEPTION 'task process record requires the active claimed task' USING ERRCODE = '42501';
  END IF;
  UPDATE tasks
  SET current_pid = p_pid,
      current_pgid = p_pgid,
      current_host_id = LEFT(p_host_id, 255),
      current_owner_instance_id = p_instance_id,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_task_id
    AND (
      current_owner_instance_id IS NULL
      OR current_owner_instance_id = p_instance_id
      OR NOT EXISTS (
        SELECT 1
        FROM role_jobs owner_job
        WHERE owner_job.task_id = p_task_id
          AND owner_job.claimed_by_instance_id = tasks.current_owner_instance_id
          AND owner_job.status = 'RUNNING'
          AND owner_job.lease_expires_at > CURRENT_TIMESTAMP
      )
    );
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION clear_phase17_task_process(
  p_instance_id TEXT,
  p_task_id VARCHAR,
  p_pid INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_pid IS NULL OR p_pid <= 0 THEN
    RAISE EXCEPTION 'task process pid is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT phase17_instance_owns_running_task(p_instance_id, p_task_id) THEN
    RAISE EXCEPTION 'task process cleanup requires the active claimed task' USING ERRCODE = '42501';
  END IF;
  UPDATE tasks
  SET current_pid = NULL,
      current_pgid = NULL,
      current_host_id = NULL,
      current_owner_instance_id = NULL,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_task_id
    AND current_pid = p_pid
    AND current_owner_instance_id = p_instance_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION append_phase17_command_log(
  p_instance_id TEXT,
  p_task_id VARCHAR,
  p_agent_name TEXT,
  p_command TEXT,
  p_stdout TEXT,
  p_stderr TEXT,
  p_exit_code INTEGER,
  p_blocked BOOLEAN,
  p_duration_ms INTEGER,
  p_timed_out BOOLEAN,
  p_killed BOOLEAN
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE log_id BIGINT;
BEGIN
  IF NULLIF(BTRIM(p_command), '') IS NULL THEN
    RAISE EXCEPTION 'command log command is required' USING ERRCODE = '22023';
  END IF;
  IF NOT phase17_instance_owns_running_task(p_instance_id, p_task_id) THEN
    RAISE EXCEPTION 'command log requires the active claimed task' USING ERRCODE = '42501';
  END IF;
  INSERT INTO command_logs(
    task_id, agent_name, command, stdout, stderr, exit_code,
    blocked, duration_ms, timed_out, killed
  ) VALUES (
    p_task_id,
    LEFT(NULLIF(BTRIM(p_agent_name), ''), 50),
    LEFT(p_command, 262144),
    LEFT(p_stdout, 1048576),
    LEFT(p_stderr, 1048576),
    p_exit_code,
    COALESCE(p_blocked, FALSE),
    p_duration_ms,
    COALESCE(p_timed_out, FALSE),
    COALESCE(p_killed, FALSE)
  )
  RETURNING id INTO log_id;
  RETURN log_id;
END;
$$;

CREATE OR REPLACE FUNCTION phase17_sync_rejected_task_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'REJECTED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE tasks
    SET status = 'REJECTED',
        lifecycle_status = 'REJECTED',
        row_version = row_version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.task_id
      AND (status <> 'REJECTED' OR lifecycle_status <> 'REJECTED');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_phase17_sync_rejected_task_status
AFTER UPDATE OF status ON workflow_runs
FOR EACH ROW EXECUTE FUNCTION phase17_sync_rejected_task_status();

UPDATE tasks t
SET status = 'REJECTED',
    lifecycle_status = 'REJECTED',
    row_version = t.row_version + 1,
    updated_at = CURRENT_TIMESTAMP
FROM workflow_runs r
WHERE r.task_id = t.id
  AND r.status = 'REJECTED'
  AND (t.status <> 'REJECTED' OR t.lifecycle_status <> 'REJECTED');

REVOKE ALL ON FUNCTION phase17_instance_owns_running_task(TEXT, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_phase17_task_skill(TEXT, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_phase17_task_process(TEXT, VARCHAR, INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION clear_phase17_task_process(TEXT, VARCHAR, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION append_phase17_command_log(TEXT, VARCHAR, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION phase17_sync_rejected_task_status() FROM PUBLIC;

DO $$
DECLARE principal_row RECORD;
BEGIN
  FOR principal_row IN
    SELECT p.db_principal
    FROM bot_role_principals p
    JOIN pg_roles r ON r.rolname = p.db_principal
    WHERE p.enabled
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION get_phase17_task_skill(TEXT,VARCHAR) TO %I', principal_row.db_principal);
    EXECUTE format('GRANT EXECUTE ON FUNCTION record_phase17_task_process(TEXT,VARCHAR,INTEGER,INTEGER,TEXT) TO %I', principal_row.db_principal);
    EXECUTE format('GRANT EXECUTE ON FUNCTION clear_phase17_task_process(TEXT,VARCHAR,INTEGER) TO %I', principal_row.db_principal);
    EXECUTE format('GRANT EXECUTE ON FUNCTION append_phase17_command_log(TEXT,VARCHAR,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN,INTEGER,BOOLEAN,BOOLEAN) TO %I', principal_row.db_principal);
  END LOOP;
END;
$$;
