# Phase 15 Rollback Plan

## Scope

The sealed Phase 15 bundle contains the four additive `015_delivery_governance*` migrations plus `016_channel_credentials`. It also changes Discord startup so role tokens are resolved from encrypted PostgreSQL credentials instead of `DISCORD_TOKEN`. It does not modify runtime `tasks`, `messages`, `approvals`, agent execution, or the existing workspace lock.

## Before rollback

1. Stop Phase governance imports and Gate operations.
2. Confirm no Phase 16 or later work has started.
3. Export `delivery_*`, `phase_*`, dependency activations, debts/approvals, and `schema_migrations` records.
4. Preserve canonical manifests, signed verdicts, evidence, and Gate events outside the database.
5. Choose the channel boundary before running anything:
   - preserve the encrypted `channel_credentials` rows and keep the DB-token-capable runtime, or
   - delete the channel schema as part of a full bundle rollback and plan to re-enroll every role token.
6. If deleting credentials, preserve an authorized encrypted export and the separately held master-key recovery material, or confirm that every Discord token can be reset and re-enrolled. Never write plaintext tokens into a rollback artifact.
7. Confirm the target is disposable or that an authorized recovery point exists.

## Preserve channel credentials

```bash
npm run phase15 -- rollback --confirm-phase15-rollback --preserve-channel-credentials
```

This reverses the four governance migrations in the required order and deliberately leaves `016_channel_credentials`, its ledger entry, encrypted rows, and the DB-only token runtime contract in place. Use this mode when governance must be removed without interrupting the four Discord roles. Do not deploy an older runtime that requires `DISCORD_TOKEN` after this preservation-mode rollback.

## Delete channel credentials with the full bundle

```bash
npm run phase15 -- rollback --confirm-phase15-rollback --delete-channel-credentials
```

This first removes `016_channel_credentials`, including every encrypted token row, and then reverses operator, validation-rework, privilege-hardening, and core governance migrations. Recovery requires reapplying the bundle and re-enrolling role tokens through `node bot.js`. The deletion flag is intentionally separate from the Phase 15 confirmation so an operator cannot silently choose the credential data-loss boundary.

Both commands require exactly one channel boundary flag. Within the governance subset, the full reverse chain is the only supported unit. Do not execute an individual `015_delivery_governance*.down.sql` file or roll back only `015_delivery_governance_rework`: the rework migration replaces core function definitions and relies on the remaining reverse chain. The operator commands enforce the required order.

## Verification

- `to_regclass('public.delivery_phases') IS NULL`
- `to_regclass('public.phase_dependency_activations') IS NULL`
- existing runtime tables remain present
- preservation mode: `to_regclass('public.channel_credentials') IS NOT NULL`, its `016_channel_credentials` ledger row remains, and all four roles can still decrypt their own ACTIVE credential
- deletion mode: `to_regclass('public.channel_credentials') IS NULL` and no `016_channel_credentials` ledger row remains
- existing `npm run verify` static checks still pass after the code/schema version is rolled back together
- bootstrap manifest and signed verdict artifacts remain recoverable
- no `015_delivery_governance*` migration remains recorded as applied after either rollback mode

## Recovery

Reapply with `npm run migrate:phase15`; it applies all five bundled migrations, including `016_channel_credentials`. The migration runner checks the current migration checksum and serializes concurrent application with an advisory lock. After deletion mode, run `node bot.js` and re-enroll Developer, PM, Code Reviewer, and Release Manager credentials before starting the supervisor. Reimport only a previously verified bootstrap package whose canonical hash and signatures still match.
