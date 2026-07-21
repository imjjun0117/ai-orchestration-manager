-- Phase 17 rollback. Keep legacy tasks and Phase 16 workspace safety intact.

DROP FUNCTION IF EXISTS recover_phase17_control_plane(TEXT);
DROP FUNCTION IF EXISTS fail_outbox_event(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER);
DROP FUNCTION IF EXISTS complete_outbox_event(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS suppress_outbox_event(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS claim_outbox_event(TEXT, INTEGER);
DROP FUNCTION IF EXISTS fail_role_job(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER);
DROP FUNCTION IF EXISTS resolve_workflow_approval(TEXT, TEXT, TEXT, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS complete_role_job(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS advance_workflow_node(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS phase17_schedule_next_node(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS heartbeat_role_job(TEXT, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS claim_role_job(TEXT, INTEGER);
DROP FUNCTION IF EXISTS enqueue_manager_notice(TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS receive_discord_command(TEXT, TEXT, TEXT, TEXT, TEXT, VARCHAR, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS heartbeat_bot_instance(TEXT, TEXT, JSONB, JSONB);
DROP FUNCTION IF EXISTS mark_bot_instance_offline(TEXT);
DROP FUNCTION IF EXISTS get_phase17_channel_credential(TEXT, TEXT);
DROP FUNCTION IF EXISTS register_bot_instance(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, JSONB);
DROP FUNCTION IF EXISTS phase17_instance_authorized(TEXT, TEXT);

DROP INDEX IF EXISTS uq_pending_approval_per_workflow_node_action;
ALTER TABLE approvals DROP COLUMN IF EXISTS workflow_node_id;
ALTER TABLE approvals DROP COLUMN IF EXISTS workflow_run_id;

DROP TABLE IF EXISTS discord_publications;
DROP TABLE IF EXISTS discord_event_receipts;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS job_events;
ALTER TABLE bot_instances DROP CONSTRAINT IF EXISTS fk_bot_instance_current_job;
DROP TABLE IF EXISTS role_jobs;
DROP TABLE IF EXISTS workflow_events;
DROP TABLE IF EXISTS workflow_nodes;
DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS workflow_definitions;
DROP TABLE IF EXISTS bot_instances;
DROP TABLE IF EXISTS bot_role_principals;

DROP FUNCTION IF EXISTS phase17_job_type_allowed(TEXT, TEXT);
DROP FUNCTION IF EXISTS phase17_append_only();

ALTER TABLE tasks DROP COLUMN IF EXISTS workflow_version;
ALTER TABLE tasks DROP COLUMN IF EXISTS lifecycle_status;
