# Phase 15 Verification Evidence

Date: 2026-07-18

This is worker-generated execution evidence. It is not an independent validator verdict.

## Pure tests

Command:

```bash
npm run test:phase15
```

Result:

- 15 passed
- 0 failed
- 1 PostgreSQL integration suite skipped unless explicitly enabled

Coverage includes canonical JSON/hash, raw bytes and symlinks, traversal rejection, Git SHA validation, real Git object/ancestry verification, role policy, credential fingerprints, Ed25519 signature/tamper checks, and bootstrap blocker rejection.

## Disposable PostgreSQL integration

Command:

```bash
npm run test:phase15:db
```

Result: 17 passed, 0 failed.

Verified scenarios:

1. Governance functions, tables, and sequences are not exposed to `PUBLIC`.
2. Sequential and concurrent multi-role actor assignments are rejected.
3. Sealed submissions, terminal validations, and Gate events reject update/delete; allowed draft delete is explicit.
4. Validation attempts cannot overlap or restart after a completed verdict; infrastructure retry preserves history.
5. Immutable submission worker identity prevents self-approval after assignment rotation at validation start and Gate.
6. `BLOCKED` retains precedence over a later `CHANGES_REQUESTED` verdict and enters rework.
7. Unassigned actors and cross-actor verdict completion are rejected.
8. Late verdicts for superseded submissions become `STALE_ON_ARRIVAL`.
9. Twenty concurrent Gate requests produce one acceptance and one event.
10. A latest mismatched artifact hash is rejected.
11. Open BLOCKER and unapproved MAJOR findings are rejected.
12. A successor cannot start before predecessor acceptance and dependency activation occurs exactly once.
13. Cancellation requires an authorized administrator and preserves its reason in the audit event.
14. Non-security MAJOR debt requires risk-owner acceptance and two successor-safe validator approvals.
15. A signed bootstrap package verifies real Git commits, imports, self-Gates, records `BOOTSTRAP_ACCEPTED`, and activates Phase 16 exactly once.

The suite created a temporary Git repository and PostgreSQL database, applied all four forward migrations, ran the scenarios, reversed all four migrations, verified governance tables were removed, and dropped the database and repository.

## Live project DB readiness

Commands:

```bash
npm run migrate:phase15
npm run verify:db
```

Results:

- `015_delivery_governance`: already applied, checksum `39b410f974ba07f723eaa0a59f0993ea6fd754af703e1a16ec1b65104d09721e`
- `015_delivery_governance_security`: already applied, checksum `b31614a1386c3f14c5698bcf9728307b0bac9edcef4427322c71a163bb09b3b3`
- `015_delivery_governance_rework`: applied, checksum `13ebef15f2ed76d52f8b887ccc7b3e018dd9eb57146f980fc727ad10d0ed84db`
- `015_delivery_governance_operations`: applied, checksum `23b76dc1f805b0bcc0d196dc17b1e923f8634fd7cb6fb29a17e4584cdfa2cead`
- syntax, package, env examples, static migration/docs, live tables/columns/functions, and PUBLIC privilege checks passed

## Existing workspace-lock regression

Command:

```bash
npm run verify:stress
```

Result: passed with six competing workers. Contention selected exactly one lock winner; owner safety, TTL takeover, task process ownership, and cleanup passed. The first sandboxed attempt was denied local PostgreSQL access with `EPERM`; the identical approved local-DB execution passed.

## Remaining acceptance boundary

- The current workspace has no authoritative Git metadata, so a real final base/candidate commit pair cannot be emitted here.
- No real Phase 15 submission row or signed planning/development verdict has been imported.
- The worker does not create approval verdicts. A new manifest/hash must be independently revalidated after authoritative Git placement.
