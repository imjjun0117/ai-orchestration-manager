# Phase 15 Known Issues and Acceptance Blockers

## Blocking before immutable submission

1. The current workspace has no `.git` metadata. A real `base_commit_sha` and `candidate_commit_sha` cannot be produced or independently verified. A compliant Phase 15 submission must not be sealed until the implementation is placed in the authoritative Git repository.
2. Real planning and development validators have not yet been assigned and have not produced independent signed verdicts. Test actors and generated test keys prove the mechanism only; they are not Phase approval.

## Non-blocking implementation notes

- The local project PostgreSQL has the additive Phase 15 migration applied, but no real `phase-15` submission or validation rows have been imported.
- Runtime Discord commands are intentionally unchanged in Phase 15. Discord `!phase` integration belongs to the later durable Manager control-plane work.
- Application DB owner credentials remain a trusted administrative boundary. The externally exposed bootstrap CLI only imports cryptographically verified verdict packages; direct owner access must remain restricted operationally.
- `submission-candidate-status.md` is derived mutable operator status and is intentionally excluded from the canonical bundle to avoid a recursive hash dependency. Immutable submission facts are carried by the manifest, known-issues snapshot, evidence, and database events.
