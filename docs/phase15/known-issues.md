# Phase 15 Known Issues and Acceptance Blockers

## Blocking before bootstrap acceptance

1. Real planning and development validators have not yet been assigned and have not produced independent signed verdicts for the final Git-bound bundle hash. Test actors and generated test keys prove the mechanism only; they are not Phase approval.

The authoritative Git repository is now established. The sealed manifest is generated as a separate attestation after the candidate commit so that `candidateCommitSha` can bind an existing immutable commit without a self-referential commit hash.

## Non-blocking implementation notes

- The local project PostgreSQL has the additive Phase 15 migration applied, but no real `phase-15` submission or validation rows have been imported.
- Only the full reverse migration chain invoked by `npm run phase15 -- rollback --confirm-phase15-rollback` is supported. Applying an individual Phase 15 down migration is an unsupported partial rollback.
- The previously exposed local `ai_manager` database credential remains in historical Git objects and must be rotated by a database administrator before shared or production use. The current Compose file requires `POSTGRES_PASSWORD` from the local environment and does not contain the old value.
- Runtime Discord commands are intentionally unchanged in Phase 15. Discord `!phase` integration belongs to the later durable Manager control-plane work.
- Application DB owner credentials remain a trusted administrative boundary. The externally exposed bootstrap CLI only imports cryptographically verified verdict packages; direct owner access must remain restricted operationally.
- `submission-candidate-status.md` is derived mutable operator status and is intentionally excluded from the canonical bundle to avoid a recursive hash dependency. Immutable submission facts are carried by the manifest, known-issues snapshot, evidence, and database events.
