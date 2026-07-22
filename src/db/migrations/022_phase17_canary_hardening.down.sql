DROP TRIGGER IF EXISTS trg_phase17_sync_rejected_task_status ON workflow_runs;
DROP FUNCTION IF EXISTS phase17_sync_rejected_task_status();
DROP FUNCTION IF EXISTS append_phase17_command_log(TEXT, VARCHAR, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS clear_phase17_task_process(TEXT, VARCHAR, INTEGER);
DROP FUNCTION IF EXISTS record_phase17_task_process(TEXT, VARCHAR, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS get_phase17_task_skill(TEXT, VARCHAR);
DROP FUNCTION IF EXISTS phase17_instance_owns_running_task(TEXT, VARCHAR);

-- The rejected-task backfill is an intentional data repair and is not reversed.
