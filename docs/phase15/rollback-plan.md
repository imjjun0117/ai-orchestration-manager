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

## Verification

- `to_regclass('public.delivery_phases') IS NULL`
- `to_regclass('public.phase_dependency_activations') IS NULL`
- existing runtime tables remain present
- existing `npm run verify` static checks still pass after the code/schema version is rolled back together
- bootstrap manifest and signed verdict artifacts remain recoverable

## Recovery

Reapply with `npm run migrate:phase15`. The migration runner checks the current migration checksum and serializes concurrent application with an advisory lock. Reimport only a previously verified bootstrap package whose canonical hash and signatures still match.
