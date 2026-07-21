# Phase 17 Rollback Plan

1. Stop the six-role runner and set `MULTIBOT_ROLE_MODE=off` in every role profile.
2. Confirm no Phase 17 process remains active and run `npm run phase17 -- readiness`.
3. Resolve or explicitly preserve every `NEEDS_RECONCILIATION`/`DEAD_LETTER` job and outbox record.
4. Confirm all workflow runs are terminal and all outbox events are delivered or shadowed.
5. Execute `npm run phase17 -- rollback --allow-destructive --confirm-phase17`.
6. Verify `role_jobs` is absent, legacy tasks remain, and Phase 16 workspace tables/functions still exist.
7. Resume the existing single-Manager entrypoint only after credential and workspace readiness checks.

The CLI rejects rollback while role mode is enabled, workflows are non-terminal, or outbox events are undelivered. It removes `019_phase17_credential_enrollment` before `018_durable_control_plane`; the enrollment functions and Phase 17 control-plane objects are removed while legacy credential rows, legacy tasks, and Phase 16 safety data remain.
