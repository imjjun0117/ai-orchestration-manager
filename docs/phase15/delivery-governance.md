# Phase 15 Delivery Governance Bootstrap

Phase 15 adds the delivery control plane used to implement and accept Phase 16 onward. The final bundle also adds encrypted role-specific Discord credential storage and a single-terminal four-role launcher. It does not change the Discord command workflow or enable a new code-writing path.

## Safety boundary

- Runtime `tasks`, approvals, agents, and workspace locks remain unchanged.
- Sealed submissions, terminal validation attempts, and Gate events are immutable.
- The immutable submission's `submitted_by_actor_id` remains the self-approval boundary even after assignment rotation.
- One actor can hold only one active role per Phase. The database enforces this under concurrency.
- Planning and development validators approve the same latest canonical bundle hash using separate principals and credentials.
- Phase 16 cannot start until the Phase 15 acceptance transaction activates its dependency exactly once.

## Migrations

Apply all Phase 15 migrations in ledger order:

```bash
npm run migrate:phase15
```

The final schema is the result of:

1. `015_delivery_governance`
2. `015_delivery_governance_security`
3. `015_delivery_governance_rework`
4. `015_delivery_governance_operations`
5. `016_channel_credentials`

The two `015` correction migrations are additive and preserve the checksums of installations that already applied the original core and security migrations. Migration `016` is the isolated encrypted channel-credential store.

Rollback is destructive and is allowed only on an approved disposable or recoverable database:

```bash
npm run phase15 -- rollback --confirm-phase15-rollback --preserve-channel-credentials
# or, after an authorized recovery/export decision:
npm run phase15 -- rollback --confirm-phase15-rollback --delete-channel-credentials
```

Exactly one channel boundary must be selected. The preservation mode retains encrypted credentials and requires the DB-token-capable runtime; deletion mode removes the credential table and requires role-token re-enrollment. See `rollback-plan.md` before either command.

## Authoritative Git binding

Sealing and bootstrap verification require an authoritative repository:

```bash
export DELIVERY_AUTHORITATIVE_REPOSITORY=/absolute/path/to/repository
```

The submission service verifies that base and candidate values are 40- or 64-character lowercase commit IDs, both objects exist as commits, the IDs resolve exactly, they are different, and base is an ancestor of candidate. An `UNAVAILABLE:*` value is accepted only by the explicitly unsealed `hash-draft` command.

```bash
npm run phase15 -- hash-draft docs/phase15/submission-candidate.unsealed.json
npm run phase15 -- hash path/to/final-manifest.json
```

## Operator request files

Mutating CLI commands read a JSON request file. Store request files outside release artifacts, restrict their file permissions, and never include private signing keys. Credential bindings are fingerprints, not private credentials.

```bash
chmod 600 /secure/path/request.json
npm run phase15 -- <command> /secure/path/request.json
```

Supported commands:

| Lifecycle | Commands |
|---|---|
| Principal and Phase setup | `actor-register`, `phase-create`, `assignment-create`, `assignment-replace` |
| Implementation submission | `start`, `submit` |
| Validation | `validation-start`, `validation-complete`, `validation-fail` |
| Findings and rework | `finding-resolve`, `rework` |
| Debt | `debt-register`, `debt-approve`, `debt-risk-accept` |
| Terminal control | `cancel`, `gate` |
| Inspection | `status` |

Use `npm run phase15 -- --help` for exact syntax. Request JSON field names match the corresponding service inputs in `src/delivery/`.

## Status and recovery UX

```bash
npm run phase15 -- status phase-15
```

The status response includes:

- Phase state and row version
- latest submission ID, round, hash, and seal state
- active assignments
- latest validation attempt for each validator and full attempt history
- unresolved findings
- debt, risk acceptance, validator safety approvals, and due dates
- predecessor dependencies and activation records
- successor activation state
- recent Gate events
- start-readiness blockers

State handling:

- `BLOCKED` has precedence over `CHANGES_REQUESTED` regardless of verdict arrival order.
- `CHANGES_REQUESTED` or `BLOCKED` can enter `REWORK_IN_PROGRESS` through `rework`.
- Rework produces a new immutable submission round and hash; old verdicts remain historical and cannot Gate the new round.
- `INFRA_FAILED` or `CANCELLED` validation attempts may be retried. Overlapping attempts and retries after `COMPLETED` are rejected.
- `cancel` requires a Gate administrator, expected row version, and an audit reason. Accepted or already cancelled phases cannot be cancelled.

Common recovery:

| Error | Recovery |
|---|---|
| version mismatch | Run `status`, review intervening events, then retry with the new `rowVersion` |
| actor not authorized | Verify the active assignment and credential fingerprint; use atomic `assignment-replace` for rotation |
| previous validation attempt not failed | Complete or infrastructure-fail the current attempt; never overlap attempts |
| dependency not activated | Do not bypass it; complete the predecessor Gate and inspect the activation event |
| open BLOCKER/MAJOR | Rework and resolve, or use debt only for eligible non-security/non-integrity/non-rollback MAJOR findings |

## Debt workflow

`ACCEPTED_WITH_DEBT` requires all of the following:

1. An eligible unresolved `MAJOR` finding with owner, risk owner, future due date, and impact scope.
2. Planning and development approvals from the validators of the accepted submission.
3. Each approval explicitly sets `successorSafe=true` with a non-empty safety rationale.
4. The assigned risk owner accepts the risk using its own credential.

Security, data-integrity, and rollback MAJOR findings cannot become debt. Missing successor-safety or risk approval blocks Gate and therefore blocks downstream dependency activation.

## Bootstrap package

Planning and development validators independently sign the canonical JSON form of their verdict with separate Ed25519 keys. Private keys never enter the CLI arguments or PostgreSQL.

```bash
npm run phase15 -- verify-bootstrap path/to/bootstrap-package.json
npm run phase15 -- import-bootstrap path/to/bootstrap-package.json
```

Import performs one serializable transaction:

1. Verify Git commit binding, manifest hash, signatures, actor separation, evidence, and findings.
2. Register Phase 15 actors and assignments.
3. Create the planned Phase 16 dependency.
4. Seal the Phase 15 submission and store both independent verdicts.
5. Execute the self-hosted Gate.
6. Append `BOOTSTRAP_ACCEPTED` and exactly one Phase 16 dependency activation.

## Verification

```bash
npm run test:phase15
npm run test:phase15:db
npm run verify:db
npm run verify:stress
```

The DB suite uses disposable databases and an authoritative temporary Git repository. It applies all five forward migrations, exercises positive and negative Gate paths, verifies both the channel-preservation boundary and the full five-migration reverse chain, and drops every temporary database.

Phase 15 remains unaccepted until real assigned validators independently approve and sign the final immutable submission. Test keys and test verdicts prove the mechanism only.
