DROP FUNCTION IF EXISTS reconcile_phase17_item(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT);

DROP TRIGGER IF EXISTS trg_phase17_reconciliation_actions_append_only ON phase17_reconciliation_actions;
DROP TABLE IF EXISTS phase17_reconciliation_actions;

DROP TRIGGER IF EXISTS trg_outbox_events_reconciliation_revision ON outbox_events;
DROP TRIGGER IF EXISTS trg_role_jobs_reconciliation_revision ON role_jobs;
DROP FUNCTION IF EXISTS phase17_bump_reconciliation_revision();

ALTER TABLE outbox_events DROP COLUMN IF EXISTS reconciliation_revision;
ALTER TABLE role_jobs DROP COLUMN IF EXISTS reconciliation_revision;
