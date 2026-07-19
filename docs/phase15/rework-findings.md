# Phase 15 Validation Rework Findings

This document maps the independent planning and development findings to worker changes. It is implementation evidence, not a validator verdict.

| Finding | Resolution | Regression evidence |
|---|---|---|
| Submission worker could self-approve after role rotation | Gate and validation functions compare against immutable `submitted_by_actor_id` | worker rotation self-approval rejection |
| `BLOCKED` could be overwritten by later `CHANGES_REQUESTED` | central precedence projection | ordered dual-verdict test |
| Concurrent dual-role assignment race | unique active `(phase_id, actor_id)` index | concurrent assignment test |
| Validation attempts could overlap or restart after completion | retry allowed only after `INFRA_FAILED`/`CANCELLED`; Gate selects latest attempt | overlap, infra retry, completed retry tests |
| Debt could unlock a successor without explicit downstream safety | risk acceptance plus two successor-safe validator approvals | incomplete/full debt tests |
| Phase 16 activation was not explicit/idempotent | activation table, unique key, Gate event and guard | exact-one activation/event/start test |
| Commit strings were not authoritative Git objects | SHA format plus object and ancestry verification | temporary real-Git binding tests |
| DELETE trigger silently ignored allowed deletes | DELETE returns `OLD`; protected terminal rows raise | draft delete and immutable delete tests |
| Required negative Gate paths were missing | added hash mismatch, open finding, unassigned/cross-actor, dependency tests | disposable DB suite |
| Operator lifecycle and status were incomplete | request-file CLI commands, cancellation, assignment replacement, expanded status/runbook | syntax, DB, and readiness verification |
| Rework down migration could be misused as a standalone rollback | runbook declares the full reverse chain as the only supported rollback unit and explains the intermediate-state hazard | full-chain rollback verification |
| Round 16 bundled channel migration/runtime had no coherent rollback boundary | rollback CLI requires an explicit preserve/delete credential decision; runbook defines retained-runtime and re-enrollment consequences | disposable preservation-boundary and five-migration full-down tests |
| Four-role launcher could continue in a degraded partial state | per-role stream prefixes, exit audit, non-zero/signal fail-fast sibling shutdown | mocked child output and lifecycle regression |
| Round 16 channel/launcher scope was absent from acceptance trace and evidence | requirements matrix and evidence now map enrollment, DB-only tokens, operations, labels, supervisor, and rollback | current pure/DB/readiness command results and independent revalidation |
| Friendly role identity and unattended role typos were hard to diagnose | `--role` validates the fixed IDs before runtime; startup and `!instance` include friendly labels | launcher validation and runtime source assertions |

Authoritative Git metadata is available. Real actor assignment, signed independent verdicts for the final Git-bound hash, bootstrap import, and Gate replay remain acceptance steps; the worker can assemble and import an independently signed package but cannot create validator approval on their behalf.
