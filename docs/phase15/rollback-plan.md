# Phase 15 Rollback Plan

## Scope

Phase 15 is additive. It does not modify runtime `tasks`, `messages`, `approvals`, agent execution, Discord ingress, or the existing workspace lock.

## Before rollback

1. Stop Phase governance imports and Gate operations.
2. Confirm no Phase 16 or later work has started.
3. Export `delivery_*`, `phase_*`, dependency activations, debts/approvals, and `schema_migrations` records.
4. Preserve canonical manifests, signed verdicts, evidence, and Gate events outside the database.
5. Confirm the target is disposable or that an authorized recovery point exists.

## Command

```bash
npm run phase15 -- rollback --confirm-phase15-rollback
```

The explicit confirmation reverses operator, validation-rework, privilege-hardening, and core migrations in that order, then removes the Phase 15 governance tables and functions.

This full reverse chain is the only supported rollback unit. Do not execute an individual `015_delivery_governance*.down.sql` file or roll back only `015_delivery_governance_rework`: the rework migration replaces core function definitions, so its down script removes those replacements and relies on the remaining reverse chain to remove the core governance layer. A partial down would therefore leave an unsupported intermediate schema. The operator command above enforces the required order.

## Verification

- `to_regclass('public.delivery_phases') IS NULL`
- `to_regclass('public.phase_dependency_activations') IS NULL`
- existing runtime tables remain present
- existing `npm run verify` static checks still pass after the code/schema version is rolled back together
- bootstrap manifest and signed verdict artifacts remain recoverable
- no individual Phase 15 migration remains recorded as applied after the full rollback

## Recovery

Reapply with `npm run migrate:phase15`. The migration runner checks the current migration checksum and serializes concurrent application with an advisory lock. Reimport only a previously verified bootstrap package whose canonical hash and signatures still match.
