-- Phase 17: multi-bot durable control plane, role queue, and transactional outbox.

ALTER TABLE tasks ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'CREATED'
  CHECK (lifecycle_status IN (
    'CREATED', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'REJECTED',
    'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION'
  ));
ALTER TABLE tasks ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1
  CHECK (workflow_version > 0);

CREATE TABLE bot_instances (
  instance_id TEXT PRIMARY KEY,
  bot_role TEXT NOT NULL CHECK (bot_role IN ('manager', 'planner', 'coder', 'reviewer', 'qa', 'summarizer')),
  agent_engine TEXT NOT NULL,
  db_principal TEXT NOT NULL,
  discord_user_id TEXT,
  discord_application_id TEXT,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK (pid > 0),
  process_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'STARTING' CHECK (
    status IN ('STARTING', 'ONLINE', 'DEGRADED', 'BUSY', 'PAUSED', 'DRAINING', 'OFFLINE', 'STALE')
  ),
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  current_job_id TEXT,
  cli_health_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cli_health_json) = 'object'),
  db_health TEXT NOT NULL DEFAULT 'UNKNOWN',
  workspace_health_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(workspace_health_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bot_role_principals (
  db_principal TEXT PRIMARY KEY,
  bot_role TEXT NOT NULL CHECK (bot_role IN ('manager', 'planner', 'coder', 'reviewer', 'qa', 'summarizer')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  provisioned_by TEXT NOT NULL DEFAULT SESSION_USER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ix_bot_instances_role_status ON bot_instances(bot_role, status, last_heartbeat_at);
CREATE UNIQUE INDEX uq_bot_instances_discord_user
  ON bot_instances(discord_user_id) WHERE discord_user_id IS NOT NULL;

CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  graph_json JSONB NOT NULL CHECK (jsonb_typeof(graph_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'SHADOW' CHECK (status IN ('SHADOW', 'ACTIVE', 'RETIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (name, version)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  task_id VARCHAR(50) NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  workflow_definition_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (
    status IN ('RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'REJECTED', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION')
  ),
  correlation_id TEXT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_id, workflow_version)
);

CREATE INDEX ix_workflow_runs_status ON workflow_runs(status, updated_at);

CREATE TABLE workflow_nodes (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  task_id VARCHAR(50) NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  node_key TEXT NOT NULL,
  target_role TEXT NOT NULL CHECK (target_role IN ('manager', 'planner', 'coder', 'reviewer', 'qa', 'summarizer')),
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY' CHECK (
    status IN ('READY', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION')
  ),
  input_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  output_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  row_version BIGINT NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workflow_run_id, node_key)
);

CREATE INDEX ix_workflow_nodes_run_status ON workflow_nodes(workflow_run_id, status, created_at);

CREATE TABLE workflow_events (
  id BIGSERIAL PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  workflow_node_id TEXT REFERENCES workflow_nodes(id) ON DELETE RESTRICT,
  task_id VARCHAR(50) NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_instance_id TEXT,
  correlation_id TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ix_workflow_events_run ON workflow_events(workflow_run_id, id);

CREATE TABLE role_jobs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  workflow_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE RESTRICT,
  task_id VARCHAR(50) NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  target_role TEXT NOT NULL CHECK (target_role IN ('manager', 'planner', 'coder', 'reviewer', 'qa', 'summarizer')),
  target_instance_id TEXT REFERENCES bot_instances(instance_id) ON DELETE RESTRICT,
  job_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN (
      'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RETRY_WAIT', 'CANCEL_REQUESTED',
      'CANCELLED', 'TIMED_OUT', 'NEEDS_RECONCILIATION', 'DEAD_LETTER'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  claimed_by_instance_id TEXT REFERENCES bot_instances(instance_id) ON DELETE RESTRICT,
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  input_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  input_artifact_hash TEXT CHECK (input_artifact_hash IS NULL OR input_artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  output_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  safe_to_retry BOOLEAN NOT NULL DEFAULT TRUE,
  requires_workspace_lock BOOLEAN NOT NULL DEFAULT FALSE,
  last_error_code TEXT,
  last_error_detail_redacted TEXT,
  failure_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (attempt_count <= max_attempts),
  CHECK (
    (status = 'RUNNING' AND claimed_by_instance_id IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'RUNNING'
  )
);

CREATE INDEX ix_role_job_claim
  ON role_jobs(target_role, status, available_at, priority DESC, created_at);
CREATE INDEX ix_role_job_lease ON role_jobs(status, lease_expires_at) WHERE status = 'RUNNING';

ALTER TABLE bot_instances
  ADD CONSTRAINT fk_bot_instance_current_job
  FOREIGN KEY (current_job_id) REFERENCES role_jobs(id) ON DELETE SET NULL;

CREATE TABLE job_events (
  id BIGSERIAL PRIMARY KEY,
  role_job_id TEXT NOT NULL REFERENCES role_jobs(id) ON DELETE RESTRICT,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  workflow_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_instance_id TEXT,
  claim_token TEXT,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ix_job_events_job ON job_events(role_job_id, id);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'DISPATCHING', 'POSTED', 'SHADOWED', 'RETRY_WAIT', 'NEEDS_RECONCILIATION', 'DEAD_LETTER')
  ),
  target_role TEXT CHECK (target_role IS NULL OR target_role IN ('manager', 'planner', 'coder', 'reviewer', 'qa', 'summarizer')),
  target_instance_id TEXT REFERENCES bot_instances(instance_id) ON DELETE RESTRICT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  claimed_by_instance_id TEXT REFERENCES bot_instances(instance_id) ON DELETE RESTRICT,
  claim_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  last_error_code TEXT,
  last_error_detail_redacted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at TIMESTAMPTZ
);

CREATE INDEX ix_outbox_dispatch ON outbox_events(status, available_at, created_at);
CREATE INDEX ix_outbox_lease ON outbox_events(status, lease_expires_at) WHERE status = 'DISPATCHING';

CREATE TABLE discord_event_receipts (
  id BIGSERIAL PRIMARY KEY,
  source_message_id TEXT NOT NULL UNIQUE,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  received_by_instance_id TEXT NOT NULL REFERENCES bot_instances(instance_id) ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL,
  task_id VARCHAR(50) NOT NULL,
  workflow_run_id TEXT NOT NULL,
  role_job_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ix_discord_event_receipts_correlation ON discord_event_receipts(correlation_id);

CREATE TABLE discord_publications (
  id TEXT PRIMARY KEY,
  outbox_event_id TEXT NOT NULL UNIQUE REFERENCES outbox_events(id) ON DELETE RESTRICT,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE RESTRICT,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  workflow_node_id TEXT REFERENCES workflow_nodes(id) ON DELETE RESTRICT,
  publication_key TEXT NOT NULL UNIQUE,
  target_role TEXT NOT NULL CHECK (target_role IN ('manager', 'planner', 'coder', 'reviewer', 'qa', 'summarizer')),
  target_instance_id TEXT REFERENCES bot_instances(instance_id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  correlation_marker TEXT NOT NULL UNIQUE,
  discord_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'DISPATCHING', 'POSTED', 'SHADOWED', 'RETRY_WAIT', 'NEEDS_RECONCILIATION', 'DEAD_LETTER')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at TIMESTAMPTZ
);

ALTER TABLE approvals ADD COLUMN workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE RESTRICT;
ALTER TABLE approvals ADD COLUMN workflow_node_id TEXT REFERENCES workflow_nodes(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_pending_approval_per_workflow_node_action
  ON approvals(task_id, workflow_node_id, action)
  WHERE status = 'PENDING' AND workflow_node_id IS NOT NULL;

CREATE OR REPLACE FUNCTION phase17_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_phase17_workflow_events_append_only
BEFORE UPDATE OR DELETE ON workflow_events
FOR EACH ROW EXECUTE FUNCTION phase17_append_only();

CREATE TRIGGER trg_phase17_job_events_append_only
BEFORE UPDATE OR DELETE ON job_events
FOR EACH ROW EXECUTE FUNCTION phase17_append_only();

CREATE OR REPLACE FUNCTION phase17_job_type_allowed(p_role TEXT, p_job_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'manager' THEN p_job_type IN ('CONTROL', 'PHASE_GATE')
    WHEN 'planner' THEN p_job_type IN ('TASK_PLAN', 'PHASE_VALIDATE_PLANNING')
    WHEN 'coder' THEN p_job_type IN ('TASK_CODE', 'PHASE_IMPLEMENT', 'PHASE_REWORK')
    WHEN 'reviewer' THEN p_job_type IN ('TASK_REVIEW', 'PHASE_VALIDATE_DEVELOPMENT')
    WHEN 'qa' THEN p_job_type IN ('TASK_QA', 'PHASE_QA_EVIDENCE')
    WHEN 'summarizer' THEN p_job_type = 'TASK_SUMMARIZE'
    ELSE FALSE
  END
$$;

ALTER TABLE role_jobs ADD CONSTRAINT ck_role_job_capability
  CHECK (phase17_job_type_allowed(target_role, job_type));

CREATE OR REPLACE FUNCTION phase17_instance_authorized(p_instance_id TEXT, p_required_role TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bot_instances i
    JOIN bot_role_principals p
      ON p.db_principal = i.db_principal AND p.bot_role = i.bot_role AND p.enabled
    WHERE i.instance_id = p_instance_id
      AND i.db_principal = SESSION_USER
      AND (p_required_role IS NULL OR i.bot_role = p_required_role)
  )
$$;

CREATE OR REPLACE FUNCTION register_bot_instance(
  p_instance_id TEXT,
  p_bot_role TEXT,
  p_agent_engine TEXT,
  p_discord_user_id TEXT,
  p_discord_application_id TEXT,
  p_hostname TEXT,
  p_pid INTEGER,
  p_process_version TEXT,
  p_cli_health JSONB DEFAULT '{}'::jsonb,
  p_workspace_health JSONB DEFAULT '{}'::jsonb
)
RETURNS bot_instances
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  instance_row bot_instances%ROWTYPE;
BEGIN
  IF p_bot_role NOT IN ('manager', 'planner', 'coder', 'reviewer', 'qa', 'summarizer') THEN
    RAISE EXCEPTION 'unsupported bot role %', p_bot_role USING ERRCODE = '22023';
  END IF;
  IF NULLIF(BTRIM(p_instance_id), '') IS NULL OR NULLIF(BTRIM(p_agent_engine), '') IS NULL THEN
    RAISE EXCEPTION 'instance id and agent engine are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bot_role_principals
    WHERE db_principal = SESSION_USER AND bot_role = p_bot_role AND enabled
  ) THEN
    RAISE EXCEPTION 'DB principal % is not provisioned for role %', SESSION_USER, p_bot_role USING ERRCODE = '42501';
  END IF;
  INSERT INTO bot_instances(
    instance_id, bot_role, agent_engine, db_principal, discord_user_id,
    discord_application_id, hostname, pid, process_version, status,
    cli_health_json, db_health, workspace_health_json
  ) VALUES (
    p_instance_id, p_bot_role, p_agent_engine, SESSION_USER, p_discord_user_id,
    p_discord_application_id, p_hostname, p_pid, p_process_version, 'ONLINE',
    COALESCE(p_cli_health, '{}'::jsonb), 'HEALTHY', COALESCE(p_workspace_health, '{}'::jsonb)
  )
  ON CONFLICT (instance_id) DO UPDATE SET
    agent_engine = EXCLUDED.agent_engine,
    discord_user_id = EXCLUDED.discord_user_id,
    discord_application_id = EXCLUDED.discord_application_id,
    hostname = EXCLUDED.hostname,
    pid = EXCLUDED.pid,
    process_version = EXCLUDED.process_version,
    status = 'ONLINE',
    started_at = CURRENT_TIMESTAMP,
    last_heartbeat_at = CURRENT_TIMESTAMP,
    cli_health_json = EXCLUDED.cli_health_json,
    db_health = 'HEALTHY',
    workspace_health_json = EXCLUDED.workspace_health_json,
    updated_at = CURRENT_TIMESTAMP
  WHERE bot_instances.bot_role = EXCLUDED.bot_role
    AND bot_instances.db_principal = SESSION_USER
  RETURNING * INTO instance_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instance identity, role, or DB principal binding changed' USING ERRCODE = '42501';
  END IF;
  RETURN instance_row;
END;
$$;

CREATE OR REPLACE FUNCTION heartbeat_bot_instance(
  p_instance_id TEXT,
  p_status TEXT,
  p_cli_health JSONB DEFAULT '{}'::jsonb,
  p_workspace_health JSONB DEFAULT '{}'::jsonb
)
RETURNS bot_instances
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  instance_row bot_instances%ROWTYPE;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('ONLINE', 'DEGRADED', 'BUSY', 'PAUSED', 'DRAINING') THEN
    RAISE EXCEPTION 'unsupported live instance status %', p_status USING ERRCODE = '22023';
  END IF;
  UPDATE bot_instances
  SET status = COALESCE(p_status, status),
      last_heartbeat_at = CURRENT_TIMESTAMP,
      cli_health_json = COALESCE(p_cli_health, '{}'::jsonb),
      workspace_health_json = COALESCE(p_workspace_health, '{}'::jsonb),
      db_health = 'HEALTHY',
      updated_at = CURRENT_TIMESTAMP
  WHERE instance_id = p_instance_id AND db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
  RETURNING * INTO instance_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instance heartbeat rejected' USING ERRCODE = '42501';
  END IF;
  RETURN instance_row;
END;
$$;

CREATE OR REPLACE FUNCTION mark_bot_instance_offline(p_instance_id TEXT)
RETURNS bot_instances
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE instance_row bot_instances%ROWTYPE;
BEGIN
  UPDATE bot_instances SET status = 'OFFLINE', current_job_id = NULL,
      last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  WHERE instance_id = p_instance_id AND db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
  RETURNING * INTO instance_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'instance offline transition rejected' USING ERRCODE = '42501'; END IF;
  RETURN instance_row;
END;
$$;

CREATE OR REPLACE FUNCTION get_phase17_channel_credential(p_instance_id TEXT, p_channel_type TEXT DEFAULT 'discord')
RETURNS TABLE(encrypted_token TEXT, nonce TEXT, auth_tag TEXT, key_version INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bot_instances
    WHERE instance_id = p_instance_id AND db_principal = SESSION_USER
      AND phase17_instance_authorized(p_instance_id)
  ) THEN
    RAISE EXCEPTION 'channel credential requires a principal-bound instance' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.encrypted_token, c.nonce, c.auth_tag, c.key_version
  FROM channel_credentials c
  WHERE c.bot_instance_id = p_instance_id AND c.channel_type = p_channel_type AND c.status = 'ACTIVE';
END;
$$;

INSERT INTO workflow_definitions(id, name, version, graph_json, status)
VALUES (
  'phase17-default-v1',
  'default-six-role-workflow',
  1,
  '{"nodes":[
    {"key":"planner","role":"planner","jobType":"TASK_PLAN","next":"coder","requiresApprovalAfter":true},
    {"key":"coder","role":"coder","jobType":"TASK_CODE","next":"reviewer","requiresApprovalAfter":false},
    {"key":"reviewer","role":"reviewer","jobType":"TASK_REVIEW","next":"qa","requiresApprovalAfter":false},
    {"key":"qa","role":"qa","jobType":"TASK_QA","next":"summarizer","requiresApprovalAfter":false},
    {"key":"summarizer","role":"summarizer","jobType":"TASK_SUMMARIZE","next":null,"requiresApprovalAfter":true}
  ]}'::jsonb,
  'SHADOW'
),
('phase17-planner-v1', 'planner-single-role', 1,
 '{"nodes":[{"key":"planner","role":"planner","jobType":"TASK_PLAN","next":null,"requiresApprovalAfter":true}]}'::jsonb, 'SHADOW'),
('phase17-coder-v1', 'coder-single-role', 1,
 '{"nodes":[{"key":"coder","role":"coder","jobType":"TASK_CODE","next":null,"requiresApprovalAfter":false}]}'::jsonb, 'SHADOW'),
('phase17-reviewer-v1', 'reviewer-single-role', 1,
 '{"nodes":[{"key":"reviewer","role":"reviewer","jobType":"TASK_REVIEW","next":null,"requiresApprovalAfter":false}]}'::jsonb, 'SHADOW'),
('phase17-qa-v1', 'qa-single-role', 1,
 '{"nodes":[{"key":"qa","role":"qa","jobType":"TASK_QA","next":null,"requiresApprovalAfter":false}]}'::jsonb, 'SHADOW'),
('phase17-summarizer-v1', 'summarizer-single-role', 1,
 '{"nodes":[{"key":"summarizer","role":"summarizer","jobType":"TASK_SUMMARIZE","next":null,"requiresApprovalAfter":true}]}'::jsonb, 'SHADOW');

CREATE OR REPLACE FUNCTION receive_discord_command(
  p_source_message_id TEXT,
  p_guild_id TEXT,
  p_channel_id TEXT,
  p_manager_instance_id TEXT,
  p_correlation_id TEXT,
  p_task_id VARCHAR,
  p_title TEXT,
  p_original_request TEXT,
  p_created_by TEXT,
  p_workflow_run_id TEXT,
  p_workflow_node_id TEXT,
  p_role_job_id TEXT,
  p_workflow_definition_id TEXT DEFAULT 'phase17-default-v1'
)
RETURNS TABLE(
  receipt_id BIGINT,
  accepted_task_id VARCHAR,
  accepted_workflow_run_id TEXT,
  accepted_role_job_id TEXT,
  was_duplicate BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manager_row bot_instances%ROWTYPE;
  receipt_row discord_event_receipts%ROWTYPE;
  definition_row workflow_definitions%ROWTYPE;
  first_node JSONB;
BEGIN
  SELECT * INTO manager_row FROM bot_instances
  WHERE instance_id = p_manager_instance_id
    AND bot_role = 'manager'
    AND db_principal = SESSION_USER
    AND phase17_instance_authorized(p_manager_instance_id, 'manager')
    AND status IN ('ONLINE', 'BUSY', 'DEGRADED')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Manager-only ingress rejected for instance %', p_manager_instance_id USING ERRCODE = '42501';
  END IF;
  IF NULLIF(BTRIM(p_source_message_id), '') IS NULL OR NULLIF(BTRIM(p_original_request), '') IS NULL THEN
    RAISE EXCEPTION 'source message and original request are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO discord_event_receipts(
    source_message_id, guild_id, channel_id, received_by_instance_id, correlation_id,
    task_id, workflow_run_id, role_job_id
  ) VALUES (
    p_source_message_id, p_guild_id, p_channel_id, p_manager_instance_id, p_correlation_id,
    p_task_id, p_workflow_run_id, p_role_job_id
  )
  ON CONFLICT (source_message_id) DO NOTHING
  RETURNING * INTO receipt_row;
  IF NOT FOUND THEN
    SELECT * INTO receipt_row FROM discord_event_receipts WHERE source_message_id = p_source_message_id;
    RETURN QUERY SELECT receipt_row.id, receipt_row.task_id, receipt_row.workflow_run_id, receipt_row.role_job_id, TRUE;
    RETURN;
  END IF;

  SELECT * INTO definition_row FROM workflow_definitions
  WHERE id = p_workflow_definition_id AND status IN ('SHADOW', 'ACTIVE');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow definition % is unavailable', p_workflow_definition_id USING ERRCODE = '55000';
  END IF;
  first_node := definition_row.graph_json->'nodes'->0;
  IF first_node IS NULL OR first_node->>'key' IS NULL THEN
    RAISE EXCEPTION 'workflow definition has no first node' USING ERRCODE = '55000';
  END IF;

  INSERT INTO tasks(
    id, title, original_request, status, current_agent, risk_level, created_by, channel_id,
    lifecycle_status, workflow_version, control_state
  ) VALUES (
    p_task_id, p_title, p_original_request, 'CREATED', first_node->>'role', 'low', p_created_by, p_channel_id,
    'RUNNING', definition_row.version, 'RUNNING'
  );
  INSERT INTO workflow_runs(
    id, task_id, workflow_definition_id, workflow_version, status, correlation_id
  ) VALUES (
    p_workflow_run_id, p_task_id, definition_row.id, definition_row.version, 'RUNNING', p_correlation_id
  );
  INSERT INTO workflow_nodes(
    id, workflow_run_id, task_id, node_key, target_role, job_type, status
  ) VALUES (
    p_workflow_node_id, p_workflow_run_id, p_task_id, first_node->>'key', first_node->>'role', first_node->>'jobType', 'READY'
  );
  INSERT INTO role_jobs(
    id, workflow_run_id, workflow_node_id, task_id, target_role, job_type,
    payload_json, idempotency_key, correlation_id, safe_to_retry, requires_workspace_lock
  ) VALUES (
    p_role_job_id, p_workflow_run_id, p_workflow_node_id, p_task_id,
    first_node->>'role', first_node->>'jobType',
    jsonb_build_object('request', p_original_request, 'round', 1),
    p_workflow_run_id || ':' || (first_node->>'key') || ':round-1', p_correlation_id,
    (first_node->>'role') NOT IN ('coder', 'qa'),
    (first_node->>'role') IN ('coder', 'qa')
  );
  INSERT INTO workflow_events(
    workflow_run_id, workflow_node_id, task_id, event_type, actor_instance_id, correlation_id, event_payload
  ) VALUES (
    p_workflow_run_id, p_workflow_node_id, p_task_id, 'COMMAND_RECEIVED', p_manager_instance_id,
    p_correlation_id, jsonb_build_object('sourceMessageId', p_source_message_id, 'jobId', p_role_job_id)
  );
  INSERT INTO outbox_events(
    id, aggregate_type, aggregate_id, event_type, payload_json, target_role,
    idempotency_key, correlation_id
  ) VALUES (
    'outbox-' || gen_random_uuid()::text, 'workflow_run', p_workflow_run_id, 'ROLE_JOB_AVAILABLE',
    jsonb_build_object('taskId', p_task_id, 'workflowRunId', p_workflow_run_id, 'jobId', p_role_job_id),
    first_node->>'role', p_workflow_run_id || ':outbox:' || (first_node->>'key'), p_correlation_id
  );
  INSERT INTO outbox_events(
    id, aggregate_type, aggregate_id, event_type, payload_json, target_role,
    idempotency_key, correlation_id
  ) VALUES (
    'outbox-' || gen_random_uuid()::text, 'workflow_run', p_workflow_run_id, 'COMMAND_ACCEPTED',
    jsonb_build_object('taskId', p_task_id, 'workflowRunId', p_workflow_run_id, 'jobId', p_role_job_id),
    'manager', p_workflow_run_id || ':outbox:accepted', p_correlation_id
  );

  RETURN QUERY SELECT receipt_row.id, p_task_id, p_workflow_run_id, p_role_job_id, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION claim_role_job(
  p_instance_id TEXT,
  p_lease_ms INTEGER
)
RETURNS SETOF role_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  instance_row bot_instances%ROWTYPE;
  job_row role_jobs%ROWTYPE;
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 THEN
    RAISE EXCEPTION 'job lease must be positive' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO instance_row FROM bot_instances
  WHERE instance_id = p_instance_id
    AND db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
    AND status IN ('ONLINE', 'BUSY', 'DEGRADED')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job claim instance is not active or principal-bound' USING ERRCODE = '42501';
  END IF;

  SELECT j.* INTO job_row
  FROM role_jobs j
  JOIN tasks t ON t.id = j.task_id
  WHERE j.status IN ('QUEUED', 'RETRY_WAIT')
    AND j.target_role = instance_row.bot_role
    AND phase17_job_type_allowed(instance_row.bot_role, j.job_type)
    AND (j.target_instance_id IS NULL OR j.target_instance_id = p_instance_id)
    AND j.available_at <= CURRENT_TIMESTAMP
    AND j.attempt_count < j.max_attempts
    AND t.control_state = 'RUNNING'
  ORDER BY j.priority DESC, j.created_at ASC
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE role_jobs
  SET status = 'RUNNING',
      claimed_by_instance_id = p_instance_id,
      claim_token = gen_random_uuid()::text,
      claimed_at = CURRENT_TIMESTAMP,
      heartbeat_at = CURRENT_TIMESTAMP,
      lease_expires_at = CURRENT_TIMESTAMP + (p_lease_ms * INTERVAL '1 millisecond'),
      attempt_count = attempt_count + 1,
      last_error_code = NULL,
      last_error_detail_redacted = NULL,
      failure_fingerprint = NULL,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = job_row.id
  RETURNING * INTO job_row;
  UPDATE workflow_nodes
  SET status = 'RUNNING', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
  WHERE id = job_row.workflow_node_id AND status = 'READY';
  UPDATE bot_instances
  SET status = 'BUSY', current_job_id = job_row.id, last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  WHERE instance_id = p_instance_id;
  INSERT INTO job_events(role_job_id, workflow_run_id, workflow_node_id, event_type, actor_instance_id, claim_token, event_payload)
  VALUES (job_row.id, job_row.workflow_run_id, job_row.workflow_node_id, 'CLAIMED', p_instance_id, job_row.claim_token,
          jsonb_build_object('attempt', job_row.attempt_count, 'leaseExpiresAt', job_row.lease_expires_at));
  RETURN NEXT job_row;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_manager_notice(
  p_manager_instance_id TEXT,
  p_source_message_id TEXT,
  p_channel_id TEXT,
  p_event_type TEXT,
  p_content TEXT
)
RETURNS outbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE notice_row outbox_events%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bot_instances WHERE instance_id = p_manager_instance_id
      AND bot_role = 'manager' AND db_principal = SESSION_USER
      AND phase17_instance_authorized(p_manager_instance_id, 'manager')
      AND status IN ('ONLINE', 'BUSY', 'DEGRADED')
  ) THEN
    RAISE EXCEPTION 'manager notice requires an active Manager' USING ERRCODE = '42501';
  END IF;
  INSERT INTO outbox_events(
    id, aggregate_type, aggregate_id, event_type, payload_json, target_role,
    idempotency_key, correlation_id
  ) VALUES (
    'outbox-' || gen_random_uuid()::text, 'manager_notice', p_source_message_id, p_event_type,
    jsonb_build_object('channelId', p_channel_id, 'result', jsonb_build_object('text', LEFT(p_content, 12000))),
    'manager', 'manager-notice:' || p_source_message_id, 'discord:' || p_source_message_id
  )
  ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = outbox_events.updated_at
  RETURNING * INTO notice_row;
  RETURN notice_row;
END;
$$;

CREATE OR REPLACE FUNCTION heartbeat_role_job(
  p_job_id TEXT,
  p_instance_id TEXT,
  p_claim_token TEXT,
  p_lease_ms INTEGER
)
RETURNS role_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE job_row role_jobs%ROWTYPE;
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 THEN
    RAISE EXCEPTION 'job lease must be positive' USING ERRCODE = '22023';
  END IF;
  UPDATE role_jobs j
  SET heartbeat_at = CURRENT_TIMESTAMP,
      lease_expires_at = CURRENT_TIMESTAMP + (p_lease_ms * INTERVAL '1 millisecond'),
      updated_at = CURRENT_TIMESTAMP
  FROM bot_instances i
  WHERE j.id = p_job_id
    AND j.status = 'RUNNING'
    AND j.claimed_by_instance_id = p_instance_id
    AND j.claim_token = p_claim_token
    AND j.lease_expires_at > CURRENT_TIMESTAMP
    AND i.instance_id = p_instance_id
    AND i.db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
  RETURNING j.* INTO job_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'job heartbeat rejected' USING ERRCODE = '55000'; END IF;
  UPDATE bot_instances SET last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  WHERE instance_id = p_instance_id;
  RETURN job_row;
END;
$$;

CREATE OR REPLACE FUNCTION phase17_schedule_next_node(
  p_workflow_run_id TEXT,
  p_current_node_id TEXT,
  p_actor_instance_id TEXT,
  p_input_artifact_id TEXT
)
RETURNS role_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  run_row workflow_runs%ROWTYPE;
  current_node workflow_nodes%ROWTYPE;
  next_key TEXT;
  next_spec JSONB;
  next_node_id TEXT;
  next_job_id TEXT;
  next_job role_jobs%ROWTYPE;
BEGIN
  IF NOT phase17_instance_authorized(p_actor_instance_id, 'manager') THEN
    RAISE EXCEPTION 'workflow scheduling requires an authorized Manager' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO run_row FROM workflow_runs WHERE id = p_workflow_run_id FOR UPDATE;
  SELECT * INTO current_node FROM workflow_nodes WHERE id = p_current_node_id AND workflow_run_id = p_workflow_run_id FOR UPDATE;
  IF run_row.id IS NULL OR current_node.id IS NULL OR current_node.status <> 'SUCCEEDED'
     OR run_row.status NOT IN ('RUNNING', 'WAITING_APPROVAL') THEN
    RAISE EXCEPTION 'workflow scheduling state binding was not found' USING ERRCODE = '55000';
  END IF;
  SELECT node->>'next' INTO next_key
  FROM workflow_definitions d,
       LATERAL jsonb_array_elements(d.graph_json->'nodes') node
  WHERE d.id = run_row.workflow_definition_id AND node->>'key' = current_node.node_key;

  IF NULLIF(next_key, '') IS NULL THEN
    UPDATE workflow_runs
    SET status = 'SUCCEEDED', completed_at = CURRENT_TIMESTAMP, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.id;
    UPDATE tasks
    SET lifecycle_status = 'SUCCEEDED', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.task_id;
    INSERT INTO workflow_events(workflow_run_id, workflow_node_id, task_id, event_type, actor_instance_id, correlation_id, event_payload)
    VALUES (run_row.id, current_node.id, run_row.task_id, 'WORKFLOW_SUCCEEDED', p_actor_instance_id,
            run_row.correlation_id, jsonb_build_object('outputArtifactId', p_input_artifact_id));
    INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload_json, target_role, idempotency_key, correlation_id)
    VALUES ('outbox-' || gen_random_uuid()::text, 'workflow_run', run_row.id, 'WORKFLOW_SUCCEEDED',
            jsonb_build_object('taskId', run_row.task_id, 'workflowRunId', run_row.id), 'manager',
            run_row.id || ':outbox:succeeded', run_row.correlation_id)
    ON CONFLICT (idempotency_key) DO NOTHING;
    RETURN NULL;
  END IF;

  SELECT node INTO next_spec
  FROM workflow_definitions d,
       LATERAL jsonb_array_elements(d.graph_json->'nodes') node
  WHERE d.id = run_row.workflow_definition_id AND node->>'key' = next_key;
  IF next_spec IS NULL THEN RAISE EXCEPTION 'next workflow node % is undefined', next_key USING ERRCODE = '55000'; END IF;

  next_node_id := 'node-' || gen_random_uuid()::text;
  next_job_id := 'job-' || gen_random_uuid()::text;
  INSERT INTO workflow_nodes(
    id, workflow_run_id, task_id, node_key, target_role, job_type, status, input_artifact_id
  ) VALUES (
    next_node_id, run_row.id, run_row.task_id, next_key, next_spec->>'role', next_spec->>'jobType', 'READY', p_input_artifact_id
  );
  INSERT INTO role_jobs(
    id, workflow_run_id, workflow_node_id, task_id, target_role, job_type, payload_json,
    idempotency_key, correlation_id, input_artifact_id, safe_to_retry,
    requires_workspace_lock
  ) VALUES (
    next_job_id, run_row.id, next_node_id, run_row.task_id, next_spec->>'role', next_spec->>'jobType',
    jsonb_build_object('previousNodeId', current_node.id, 'inputArtifactId', p_input_artifact_id),
    run_row.id || ':' || next_key || ':round-1', run_row.correlation_id, p_input_artifact_id,
    (next_spec->>'role') NOT IN ('coder', 'qa'), (next_spec->>'role') IN ('coder', 'qa')
  ) RETURNING * INTO next_job;
  UPDATE workflow_runs SET status = 'RUNNING', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = run_row.id;
  UPDATE tasks SET current_agent = next_spec->>'role', updated_at = CURRENT_TIMESTAMP WHERE id = run_row.task_id;
  INSERT INTO workflow_events(workflow_run_id, workflow_node_id, task_id, event_type, actor_instance_id, correlation_id, event_payload)
  VALUES (run_row.id, next_node_id, run_row.task_id, 'NODE_SCHEDULED', p_actor_instance_id, run_row.correlation_id,
          jsonb_build_object('jobId', next_job_id, 'nodeKey', next_key));
  INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload_json, target_role, idempotency_key, correlation_id)
  VALUES ('outbox-' || gen_random_uuid()::text, 'role_job', next_job_id, 'ROLE_JOB_AVAILABLE',
          jsonb_build_object('taskId', run_row.task_id, 'workflowRunId', run_row.id, 'jobId', next_job_id),
          next_spec->>'role', run_row.id || ':outbox:' || next_key, run_row.correlation_id);
  RETURN next_job;
END;
$$;

CREATE OR REPLACE FUNCTION complete_role_job(
  p_job_id TEXT,
  p_instance_id TEXT,
  p_claim_token TEXT,
  p_input_artifact_hash TEXT,
  p_output_artifact_id TEXT,
  p_result JSONB DEFAULT '{}'::jsonb
)
RETURNS role_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row role_jobs%ROWTYPE;
  node_row workflow_nodes%ROWTYPE;
  run_row workflow_runs%ROWTYPE;
BEGIN
  SELECT j.* INTO job_row
  FROM role_jobs j JOIN bot_instances i ON i.instance_id = p_instance_id
  WHERE j.id = p_job_id
    AND j.status = 'RUNNING'
    AND j.claimed_by_instance_id = p_instance_id
    AND j.claim_token = p_claim_token
    AND j.lease_expires_at > CURRENT_TIMESTAMP
    AND j.input_artifact_hash IS NOT DISTINCT FROM p_input_artifact_hash
    AND i.db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
  FOR UPDATE OF j;
  IF NOT FOUND THEN RAISE EXCEPTION 'job completion rejected by lease, claim, or input binding' USING ERRCODE = '55000'; END IF;
  IF p_output_artifact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifacts WHERE id = p_output_artifact_id) THEN
    RAISE EXCEPTION 'output artifact % does not exist', p_output_artifact_id USING ERRCODE = '23503';
  END IF;

  UPDATE role_jobs
  SET status = 'SUCCEEDED', output_artifact_id = p_output_artifact_id,
      heartbeat_at = CURRENT_TIMESTAMP, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE id = p_job_id RETURNING * INTO job_row;
  UPDATE workflow_nodes
  SET status = 'SUCCEEDED', output_artifact_id = p_output_artifact_id,
      completed_at = CURRENT_TIMESTAMP, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = job_row.workflow_node_id RETURNING * INTO node_row;
  SELECT * INTO run_row FROM workflow_runs WHERE id = job_row.workflow_run_id FOR UPDATE;

  INSERT INTO job_events(role_job_id, workflow_run_id, workflow_node_id, event_type, actor_instance_id, claim_token, event_payload)
  VALUES (job_row.id, job_row.workflow_run_id, job_row.workflow_node_id, 'SUCCEEDED', p_instance_id, p_claim_token,
          jsonb_build_object('outputArtifactId', p_output_artifact_id, 'result', COALESCE(p_result, '{}'::jsonb)));
  UPDATE bot_instances
  SET status = 'ONLINE', current_job_id = NULL, last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  WHERE instance_id = p_instance_id;
  INSERT INTO workflow_events(workflow_run_id, workflow_node_id, task_id, event_type, actor_instance_id, correlation_id, event_payload)
  VALUES (run_row.id, node_row.id, job_row.task_id, 'ROLE_RESULT_RECORDED', p_instance_id, run_row.correlation_id,
          jsonb_build_object('jobId', job_row.id, 'outputArtifactId', p_output_artifact_id));
  INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload_json, target_role, idempotency_key, correlation_id)
  VALUES ('outbox-' || gen_random_uuid()::text, 'role_job', job_row.id, 'ROLE_RESULT_PUBLICATION',
          jsonb_build_object(
            'taskId', job_row.task_id,
            'workflowRunId', run_row.id,
            'nodeId', node_row.id,
            'jobId', job_row.id,
            'role', job_row.target_role,
            'result', COALESCE(p_result, '{}'::jsonb)
          ), job_row.target_role, run_row.id || ':outbox:result:' || node_row.node_key, run_row.correlation_id)
  ON CONFLICT (idempotency_key) DO NOTHING;
  INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload_json, target_role, idempotency_key, correlation_id)
  VALUES ('outbox-' || gen_random_uuid()::text, 'workflow_node', node_row.id, 'WORKFLOW_ADVANCE_REQUIRED',
          jsonb_build_object('taskId', job_row.task_id, 'workflowRunId', run_row.id, 'nodeId', node_row.id),
          'manager', run_row.id || ':outbox:advance:' || node_row.node_key, run_row.correlation_id)
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN job_row;
END;
$$;

CREATE OR REPLACE FUNCTION advance_workflow_node(
  p_workflow_run_id TEXT,
  p_workflow_node_id TEXT,
  p_manager_instance_id TEXT
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
  requires_approval BOOLEAN;
  approval_action TEXT;
BEGIN
  SELECT * INTO manager_row FROM bot_instances
  WHERE instance_id = p_manager_instance_id AND bot_role = 'manager'
    AND db_principal = SESSION_USER AND status IN ('ONLINE', 'BUSY', 'DEGRADED')
    AND phase17_instance_authorized(p_manager_instance_id, 'manager')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow advance requires an active Manager' USING ERRCODE = '42501'; END IF;
  SELECT * INTO run_row FROM workflow_runs
  WHERE id = p_workflow_run_id FOR UPDATE;
  SELECT * INTO node_row FROM workflow_nodes
  WHERE id = p_workflow_node_id AND workflow_run_id = p_workflow_run_id AND status = 'SUCCEEDED' FOR UPDATE;
  IF run_row.id IS NULL OR node_row.id IS NULL THEN
    RAISE EXCEPTION 'completed workflow node binding was not found' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workflow_events
    WHERE workflow_run_id = p_workflow_run_id AND workflow_node_id = p_workflow_node_id
      AND event_type IN ('APPROVAL_REQUIRED', 'NODE_ADVANCED')
  ) THEN
    RETURN run_row;
  END IF;
  IF run_row.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'workflow run is not advanceable from %', run_row.status USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE((node->>'requiresApprovalAfter')::boolean, false) INTO requires_approval
  FROM workflow_definitions d,
       LATERAL jsonb_array_elements(d.graph_json->'nodes') node
  WHERE d.id = run_row.workflow_definition_id AND node->>'key' = node_row.node_key;
  IF requires_approval THEN
    approval_action := LEFT('WORKFLOW:' || node_row.node_key, 50);
    INSERT INTO approvals(
      task_id, action, status, requested_by, expected_task_state, expected_task_version,
      workflow_run_id, workflow_node_id, expires_at
    )
    SELECT t.id, approval_action, 'PENDING', p_manager_instance_id, t.status, t.row_version,
           run_row.id, node_row.id, CURRENT_TIMESTAMP + INTERVAL '24 hours'
    FROM tasks t WHERE t.id = run_row.task_id;
    UPDATE workflow_runs SET status = 'WAITING_APPROVAL', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.id RETURNING * INTO run_row;
    UPDATE tasks SET lifecycle_status = 'WAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = run_row.task_id;
    INSERT INTO workflow_events(workflow_run_id, workflow_node_id, task_id, event_type, actor_instance_id, correlation_id, event_payload)
    VALUES (run_row.id, node_row.id, run_row.task_id, 'APPROVAL_REQUIRED', p_manager_instance_id, run_row.correlation_id,
            jsonb_build_object('action', approval_action, 'outputArtifactId', node_row.output_artifact_id));
    INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload_json, target_role, idempotency_key, correlation_id)
    VALUES ('outbox-' || gen_random_uuid()::text, 'workflow_node', node_row.id, 'APPROVAL_REQUIRED',
            jsonb_build_object('taskId', run_row.task_id, 'workflowRunId', run_row.id, 'nodeId', node_row.id),
            'manager', run_row.id || ':outbox:approval:' || node_row.node_key, run_row.correlation_id)
    ON CONFLICT (idempotency_key) DO NOTHING;
  ELSE
    PERFORM phase17_schedule_next_node(run_row.id, node_row.id, p_manager_instance_id, node_row.output_artifact_id);
    INSERT INTO workflow_events(workflow_run_id, workflow_node_id, task_id, event_type, actor_instance_id, correlation_id, event_payload)
    VALUES (run_row.id, node_row.id, run_row.task_id, 'NODE_ADVANCED', p_manager_instance_id, run_row.correlation_id, '{}'::jsonb);
    SELECT * INTO run_row FROM workflow_runs WHERE id = p_workflow_run_id;
  END IF;
  RETURN run_row;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_workflow_approval(
  p_workflow_run_id TEXT,
  p_workflow_node_id TEXT,
  p_manager_instance_id TEXT,
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
  task_version BIGINT;
BEGIN
  SELECT * INTO manager_row FROM bot_instances
  WHERE instance_id = p_manager_instance_id AND bot_role = 'manager'
    AND db_principal = SESSION_USER AND status IN ('ONLINE', 'BUSY', 'DEGRADED')
    AND phase17_instance_authorized(p_manager_instance_id, 'manager')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow approval requires an active Manager' USING ERRCODE = '42501'; END IF;
  SELECT * INTO run_row FROM workflow_runs WHERE id = p_workflow_run_id AND status = 'WAITING_APPROVAL' FOR UPDATE;
  SELECT * INTO node_row FROM workflow_nodes WHERE id = p_workflow_node_id AND workflow_run_id = p_workflow_run_id FOR UPDATE;
  SELECT * INTO approval_row FROM approvals
  WHERE workflow_run_id = p_workflow_run_id AND workflow_node_id = p_workflow_node_id AND status = 'PENDING'
  FOR UPDATE;
  IF run_row.id IS NULL OR node_row.id IS NULL OR approval_row.id IS NULL THEN
    RAISE EXCEPTION 'pending workflow approval binding was not found' USING ERRCODE = '55000';
  END IF;
  SELECT row_version INTO task_version FROM tasks WHERE id = run_row.task_id FOR UPDATE;
  IF task_version IS DISTINCT FROM approval_row.expected_task_version THEN
    RAISE EXCEPTION 'workflow approval task version changed' USING ERRCODE = '55000';
  END IF;
  UPDATE approvals
  SET status = CASE WHEN p_approved THEN 'APPROVED' ELSE 'REJECTED' END,
      approved_by = p_manager_instance_id,
      reason = p_reason,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = approval_row.id;
  INSERT INTO workflow_events(workflow_run_id, workflow_node_id, task_id, event_type, actor_instance_id, correlation_id, event_payload)
  VALUES (run_row.id, node_row.id, run_row.task_id,
          CASE WHEN p_approved THEN 'APPROVAL_GRANTED' ELSE 'APPROVAL_REJECTED' END,
          p_manager_instance_id, run_row.correlation_id, jsonb_build_object('reason', p_reason));
  IF p_approved THEN
    UPDATE tasks SET lifecycle_status = 'RUNNING', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.task_id;
    PERFORM phase17_schedule_next_node(run_row.id, node_row.id, p_manager_instance_id, node_row.output_artifact_id);
  ELSE
    UPDATE workflow_runs SET status = 'REJECTED', completed_at = CURRENT_TIMESTAMP, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.id RETURNING * INTO run_row;
    UPDATE tasks SET lifecycle_status = 'REJECTED', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = run_row.task_id;
  END IF;
  SELECT * INTO run_row FROM workflow_runs WHERE id = p_workflow_run_id;
  RETURN run_row;
END;
$$;

CREATE OR REPLACE FUNCTION fail_role_job(
  p_job_id TEXT,
  p_instance_id TEXT,
  p_claim_token TEXT,
  p_error_code TEXT,
  p_error_detail_redacted TEXT,
  p_failure_fingerprint TEXT,
  p_side_effect_uncertain BOOLEAN,
  p_retry_delay_ms INTEGER DEFAULT 1000
)
RETURNS role_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE job_row role_jobs%ROWTYPE; terminal_status TEXT;
BEGIN
  SELECT j.* INTO job_row
  FROM role_jobs j JOIN bot_instances i ON i.instance_id = p_instance_id
  WHERE j.id = p_job_id AND j.status = 'RUNNING'
    AND j.claimed_by_instance_id = p_instance_id AND j.claim_token = p_claim_token
    AND i.db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
  FOR UPDATE OF j;
  IF NOT FOUND THEN RAISE EXCEPTION 'job failure transition rejected' USING ERRCODE = '55000'; END IF;
  terminal_status := CASE
    WHEN p_side_effect_uncertain OR NOT job_row.safe_to_retry THEN 'NEEDS_RECONCILIATION'
    WHEN job_row.attempt_count < job_row.max_attempts THEN 'RETRY_WAIT'
    ELSE 'DEAD_LETTER'
  END;
  UPDATE role_jobs
  SET status = terminal_status,
      available_at = CASE WHEN terminal_status = 'RETRY_WAIT'
        THEN CURRENT_TIMESTAMP + (GREATEST(COALESCE(p_retry_delay_ms, 1000), 0) * INTERVAL '1 millisecond')
        ELSE available_at END,
      lease_expires_at = NULL,
      last_error_code = p_error_code,
      last_error_detail_redacted = LEFT(p_error_detail_redacted, 4000),
      failure_fingerprint = p_failure_fingerprint,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = job_row.id RETURNING * INTO job_row;
  UPDATE workflow_nodes
  SET status = CASE
        WHEN terminal_status = 'RETRY_WAIT' THEN 'READY'
        WHEN terminal_status = 'NEEDS_RECONCILIATION' THEN 'NEEDS_RECONCILIATION'
        ELSE 'FAILED' END,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = job_row.workflow_node_id;
  UPDATE bot_instances SET status = 'ONLINE', current_job_id = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE instance_id = p_instance_id;
  INSERT INTO job_events(role_job_id, workflow_run_id, workflow_node_id, event_type, actor_instance_id, claim_token, event_payload)
  VALUES (job_row.id, job_row.workflow_run_id, job_row.workflow_node_id, terminal_status, p_instance_id, p_claim_token,
          jsonb_build_object('errorCode', p_error_code, 'failureFingerprint', p_failure_fingerprint));
  IF terminal_status <> 'RETRY_WAIT' THEN
    UPDATE workflow_runs SET status = CASE WHEN terminal_status = 'DEAD_LETTER' THEN 'FAILED' ELSE 'NEEDS_RECONCILIATION' END,
        row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = job_row.workflow_run_id;
  END IF;
  RETURN job_row;
END;
$$;

CREATE OR REPLACE FUNCTION claim_outbox_event(p_instance_id TEXT, p_lease_ms INTEGER)
RETURNS SETOF outbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE instance_row bot_instances%ROWTYPE; outbox_row outbox_events%ROWTYPE;
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 THEN
    RAISE EXCEPTION 'outbox lease must be positive' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO instance_row FROM bot_instances
  WHERE instance_id = p_instance_id AND db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
    AND status IN ('ONLINE', 'BUSY', 'DEGRADED') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'outbox claim instance rejected' USING ERRCODE = '42501'; END IF;
  SELECT o.* INTO outbox_row FROM outbox_events o
  WHERE o.status IN ('PENDING', 'RETRY_WAIT')
    AND o.available_at <= CURRENT_TIMESTAMP
    AND o.attempt_count < o.max_attempts
    AND (o.target_role IS NULL OR o.target_role = instance_row.bot_role)
    AND (o.target_instance_id IS NULL OR o.target_instance_id = p_instance_id)
  ORDER BY o.created_at
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE outbox_events SET status = 'DISPATCHING', claimed_by_instance_id = p_instance_id,
      claim_token = gen_random_uuid()::text,
      lease_expires_at = CURRENT_TIMESTAMP + (p_lease_ms * INTERVAL '1 millisecond'),
      attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = outbox_row.id RETURNING * INTO outbox_row;
  RETURN NEXT outbox_row;
END;
$$;

CREATE OR REPLACE FUNCTION complete_outbox_event(p_outbox_id TEXT, p_instance_id TEXT, p_claim_token TEXT)
RETURNS outbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE outbox_row outbox_events%ROWTYPE;
BEGIN
  UPDATE outbox_events o SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP,
      lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
  FROM bot_instances i
  WHERE o.id = p_outbox_id AND o.status = 'DISPATCHING'
    AND o.claimed_by_instance_id = p_instance_id AND o.claim_token = p_claim_token
    AND o.lease_expires_at > CURRENT_TIMESTAMP
    AND i.instance_id = p_instance_id AND i.db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
  RETURNING o.* INTO outbox_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'outbox completion rejected' USING ERRCODE = '55000'; END IF;
  RETURN outbox_row;
END;
$$;

CREATE OR REPLACE FUNCTION suppress_outbox_event(p_outbox_id TEXT, p_instance_id TEXT, p_claim_token TEXT)
RETURNS outbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE outbox_row outbox_events%ROWTYPE;
BEGIN
  UPDATE outbox_events o SET status = 'SHADOWED', lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
  FROM bot_instances i
  WHERE o.id = p_outbox_id AND o.status = 'DISPATCHING'
    AND o.claimed_by_instance_id = p_instance_id AND o.claim_token = p_claim_token
    AND i.instance_id = p_instance_id AND i.db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id)
  RETURNING o.* INTO outbox_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'outbox shadow transition rejected' USING ERRCODE = '55000'; END IF;
  RETURN outbox_row;
END;
$$;

CREATE OR REPLACE FUNCTION fail_outbox_event(
  p_outbox_id TEXT,
  p_instance_id TEXT,
  p_claim_token TEXT,
  p_error_code TEXT,
  p_error_detail_redacted TEXT,
  p_uncertain_delivery BOOLEAN,
  p_retry_delay_ms INTEGER DEFAULT 1000
)
RETURNS outbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE outbox_row outbox_events%ROWTYPE; next_status TEXT;
BEGIN
  SELECT o.* INTO outbox_row FROM outbox_events o JOIN bot_instances i ON i.instance_id = p_instance_id
  WHERE o.id = p_outbox_id AND o.status = 'DISPATCHING'
    AND o.claimed_by_instance_id = p_instance_id AND o.claim_token = p_claim_token
    AND i.db_principal = SESSION_USER
    AND phase17_instance_authorized(p_instance_id) FOR UPDATE OF o;
  IF NOT FOUND THEN RAISE EXCEPTION 'outbox failure transition rejected' USING ERRCODE = '55000'; END IF;
  next_status := CASE WHEN p_uncertain_delivery THEN 'NEEDS_RECONCILIATION'
    WHEN outbox_row.attempt_count < outbox_row.max_attempts THEN 'RETRY_WAIT' ELSE 'DEAD_LETTER' END;
  UPDATE outbox_events SET status = next_status,
      available_at = CASE WHEN next_status = 'RETRY_WAIT'
        THEN CURRENT_TIMESTAMP + (GREATEST(COALESCE(p_retry_delay_ms, 1000), 0) * INTERVAL '1 millisecond')
        ELSE available_at END,
      lease_expires_at = NULL, last_error_code = p_error_code,
      last_error_detail_redacted = LEFT(p_error_detail_redacted, 4000), updated_at = CURRENT_TIMESTAMP
  WHERE id = p_outbox_id RETURNING * INTO outbox_row;
  RETURN outbox_row;
END;
$$;

CREATE OR REPLACE FUNCTION recover_phase17_control_plane(p_actor_instance_id TEXT)
RETURNS TABLE(retried_jobs INTEGER, reconciled_jobs INTEGER, dead_jobs INTEGER, stale_instances INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  retry_count INTEGER;
  reconcile_count INTEGER;
  dead_count INTEGER;
  stale_count INTEGER;
  retry_job_ids TEXT[] := ARRAY[]::TEXT[];
  reconcile_job_ids TEXT[] := ARRAY[]::TEXT[];
  dead_job_ids TEXT[] := ARRAY[]::TEXT[];
  affected_job_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bot_instances
    WHERE instance_id = p_actor_instance_id AND bot_role = 'manager'
      AND db_principal = SESSION_USER AND status IN ('ONLINE', 'BUSY', 'DEGRADED')
      AND phase17_instance_authorized(p_actor_instance_id, 'manager')
  ) THEN
    RAISE EXCEPTION 'watchdog recovery requires an active Manager' USING ERRCODE = '42501';
  END IF;
  WITH changed AS (
    UPDATE role_jobs SET status = 'RETRY_WAIT', available_at = CURRENT_TIMESTAMP,
      lease_expires_at = NULL, last_error_code = 'LEASE_EXPIRED', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'RUNNING' AND lease_expires_at <= CURRENT_TIMESTAMP
      AND safe_to_retry AND attempt_count < max_attempts RETURNING id
  ) SELECT COALESCE(array_agg(id), ARRAY[]::TEXT[]), COUNT(*)::int
    INTO retry_job_ids, retry_count FROM changed;
  WITH changed AS (
    UPDATE role_jobs SET status = 'NEEDS_RECONCILIATION', lease_expires_at = NULL,
      last_error_code = 'LEASE_EXPIRED_UNSAFE', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'RUNNING' AND lease_expires_at <= CURRENT_TIMESTAMP
      AND NOT safe_to_retry RETURNING id
  ) SELECT COALESCE(array_agg(id), ARRAY[]::TEXT[]), COUNT(*)::int
    INTO reconcile_job_ids, reconcile_count FROM changed;
  WITH changed AS (
    UPDATE role_jobs SET status = 'DEAD_LETTER', lease_expires_at = NULL,
      last_error_code = 'RETRY_BUDGET_EXHAUSTED', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'RUNNING' AND lease_expires_at <= CURRENT_TIMESTAMP
      AND safe_to_retry AND attempt_count >= max_attempts RETURNING id
  ) SELECT COALESCE(array_agg(id), ARRAY[]::TEXT[]), COUNT(*)::int
    INTO dead_job_ids, dead_count FROM changed;
  affected_job_ids := retry_job_ids || reconcile_job_ids || dead_job_ids;
  UPDATE bot_instances i
  SET status = 'ONLINE', current_job_id = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE i.current_job_id = ANY(affected_job_ids);
  UPDATE workflow_nodes n SET status = CASE
      WHEN j.status = 'RETRY_WAIT' THEN 'READY'
      WHEN j.status = 'NEEDS_RECONCILIATION' THEN 'NEEDS_RECONCILIATION'
      ELSE 'FAILED' END,
      updated_at = CURRENT_TIMESTAMP
  FROM role_jobs j
  WHERE n.id = j.workflow_node_id
    AND j.id = ANY(affected_job_ids);
  UPDATE workflow_runs r SET status = 'NEEDS_RECONCILIATION', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE EXISTS (
    SELECT 1 FROM role_jobs j
    WHERE j.workflow_run_id = r.id AND j.id = ANY(reconcile_job_ids)
  ) AND r.status IN ('RUNNING', 'WAITING_APPROVAL');
  UPDATE workflow_runs r SET status = 'FAILED', row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE EXISTS (
    SELECT 1 FROM role_jobs j
    WHERE j.workflow_run_id = r.id AND j.id = ANY(dead_job_ids)
  ) AND r.status IN ('RUNNING', 'WAITING_APPROVAL');
  UPDATE outbox_events SET status = 'NEEDS_RECONCILIATION', lease_expires_at = NULL,
      last_error_code = 'DISPATCH_LEASE_EXPIRED', updated_at = CURRENT_TIMESTAMP
  WHERE status = 'DISPATCHING' AND lease_expires_at <= CURRENT_TIMESTAMP;
  WITH changed AS (
    UPDATE bot_instances SET status = 'STALE', current_job_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE status NOT IN ('OFFLINE', 'STALE')
      AND last_heartbeat_at < CURRENT_TIMESTAMP - INTERVAL '30 seconds' RETURNING instance_id
  ) SELECT COUNT(*)::int INTO stale_count FROM changed;
  INSERT INTO workflow_events(workflow_run_id, task_id, event_type, actor_instance_id, correlation_id, event_payload)
  SELECT r.id, r.task_id, 'WATCHDOG_RECOVERY', p_actor_instance_id, r.correlation_id,
         jsonb_build_object('retriedJobs', retry_count, 'reconciledJobs', reconcile_count, 'deadJobs', dead_count, 'staleInstances', stale_count)
  FROM workflow_runs r
  WHERE r.id IN (
    SELECT DISTINCT workflow_run_id FROM role_jobs WHERE id = ANY(affected_job_ids)
  );
  RETURN QUERY SELECT retry_count, reconcile_count, dead_count, stale_count;
END;
$$;

REVOKE ALL ON TABLE bot_instances, workflow_definitions, workflow_runs, workflow_nodes,
  workflow_events, role_jobs, job_events, outbox_events, discord_event_receipts,
  discord_publications, bot_role_principals FROM PUBLIC;
REVOKE ALL ON SEQUENCE workflow_events_id_seq, job_events_id_seq, discord_event_receipts_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION phase17_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase17_job_type_allowed(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION phase17_instance_authorized(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_bot_instance(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION heartbeat_bot_instance(TEXT, TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_bot_instance_offline(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_phase17_channel_credential(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION receive_discord_command(TEXT, TEXT, TEXT, TEXT, TEXT, VARCHAR, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_role_job(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_manager_notice(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION heartbeat_role_job(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION phase17_schedule_next_node(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_role_job(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_workflow_node(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_workflow_approval(TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_role_job(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_outbox_event(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_outbox_event(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION suppress_outbox_event(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_outbox_event(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION recover_phase17_control_plane(TEXT) FROM PUBLIC;
