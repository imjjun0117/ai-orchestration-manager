# Phase 15 Requirements Trace Matrix

| Requirement | Implementation | Verification evidence |
|---|---|---|
| Delivery principals and credential binding | `delivery_actors`, `phase_assignments`, `phaseAssignmentPolicy.js` | unit fingerprint tests; unassigned and cross-actor DB rejection |
| Concurrent role separation | `uq_phase_assignment_active_role`, `uq_phase_assignment_active_actor`, atomic replacement procedure | sequential and concurrent dual-role rejection tests |
| Immutable submitter self-approval boundary | `phase_submissions.submitted_by_actor_id`, `phase15_assert_not_submission_worker`, Gate backstop | worker revoke/reassignment self-approval probe rejected at start and Gate |
| Governance privilege boundary | security/rework/operations migrations | dynamic PUBLIC function, table, and sequence privilege test |
| Canonical manifest and Git binding | canonical JSON/hash, commit format validation, `verifyRepositoryCommitBinding` | golden vector, invalid commit, real Git ancestry, unknown object tests |
| Immutable sealed submission | submission trigger with explicit DELETE semantics | sealed UPDATE and DELETE rejection |
| Versioned rounds and stale verdict | submission round/version checks, `STALE_ON_ARRIVAL` | superseded submission integration scenario |
| Validation attempt lifecycle | previous-attempt terminal policy and latest-attempt Gate selection | overlapping attempt rejection, infra retry, post-verdict retry rejection |
| Terminal validation immutability | terminal trigger with explicit DELETE semantics | terminal UPDATE and DELETE rejection |
| Verdict state precedence | `phase15_refresh_validation_projection` | `BLOCKED` followed by `CHANGES_REQUESTED` remains `BLOCKED` |
| Finding lifecycle and Gate rejection | findings, resolve procedure, Gate queries | open BLOCKER and unapproved MAJOR rejection tests |
| Restricted accepted debt | risk-owner acceptance and two successor-safe validator approvals | incomplete approval rejection and full accepted-debt scenario |
| Atomic dual Gate | row/version lock, latest attempt, hash, actor, finding and dependency checks | 20 concurrent Gate requests; one acceptance/event |
| Mismatched hash defense | Gate compares both verdict hashes with sealed submission | forced latest mismatch rejection test |
| Dependency guard | `phase_dependency_activations`, dependency assertion | predecessor rejection before acceptance; successor start after activation |
| Exactly-once successor activation | activation primary key and Gate `ON CONFLICT DO NOTHING` | one activation row, one event, one allowed successor start |
| Cancellation UX | `cancel_delivery_phase`, CLI and event | audited cancellation test |
| Assignment rotation UX | `replace_phase_assignment`, CLI and event | worker/validator rotation in self-approval regression test |
| Bootstrap replay | signed package verification, authoritative Git binding, Phase 16 creation | import, self-hosted Gate, `BOOTSTRAP_ACCEPTED`, activation test |
| Forward/backward migration | four ledger migrations and reverse runner | disposable up/down verification |
| Operational visibility | expanded `getPhaseStatus`, request-file CLI, runbook | dependency/status assertions and static readiness checks |
