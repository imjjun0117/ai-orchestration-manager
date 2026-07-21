# Phase 17 Verification Evidence

## Automated checks

- `npm test`: PASS — 67 tests passed; four environment-gated suites skipped.
- `npm run test:phase17:db`: PASS — 10/10 disposable PostgreSQL tests, including principal-bound runtime enrollment and revocation.
- `npm run test:phase15:db`: PASS — 20/20 governance and credential regression tests.
- `npm run test:phase16:db`: PASS — 11/11 workspace, finalization, fencing, and rollback regression tests.
- `npm run test:phase16:container`: PASS — network, root-write, non-root, and resource isolation policy.
- `npm run verify:db`: PASS — syntax, package scripts, env examples, migration static checks, docs, and live schema.
- `npm run verify:stress`: PASS — six-worker workspace-lock contention, owner safety, TTL takeover, and process ownership.
- `npm audit --omit=dev --audit-level=low`: PASS — zero vulnerabilities after removing the unused legacy `codex@0.2.3` package and updating `discord.js` to 14.27.0 (`undici` 6.27.0).
- `npm run phase17 -- verify-role-profiles`: PASS — all six 0600 profiles connected as their expected PostgreSQL `SESSION_USER` and matched enabled role bindings.
- migration smoke: PASS — `018_durable_control_plane` plus additive `019_phase17_credential_enrollment` up/down/reapply with six definitions.
- `git diff --check`: PASS.
- `node --test test/phase17/botSetup.test.js`: PASS — 5/5 tests covering the six exact mappings, default menu, hidden-token storage metadata, ACTIVE preserve/replace, duplicate reprompt, missing-fingerprint refusal, secret-safe output, and non-TTY fail-closed behavior.
- interactive `node bot.js` menu smoke: PASS — the Phase 17 six-bot option is the default and exit completed without touching credentials; the non-TTY invocation failed before consuming input.

The Phase 17 DB suite covers PUBLIC privilege revocation, principal-role negative paths, 20-way duplicate ingress, wrong-role claim, 20-way atomic claim, Manager-separated advancement, approval redelivery, stale completion, safe/unsafe lease recovery, immediate re-claim race protection, outbox reconciliation, shadow publication, and rollback preservation.

Enrollment verification covers the `node bot.js` six-role bulk wizard plus direct role-node fallback, hidden TTY prompting, AES-GCM storage, plaintext absence from DB parameters/output, ACTIVE preserve/replace, six-target duplicate rejection, non-TTY fail-closed behavior, invalid-token revocation, immediate pool cleanup, and live execute privileges for all six role principals. A live QA TTY launch displayed the hidden prompt and was cancelled without entering or storing a token; the instance returned to `OFFLINE`.

## Independent verification

- Claude Code model Fable: `BLOCKED` for the final security revalidation round. Authentication preflight passed, but the corrected read-only request was rejected with HTTP 429 because reviewer usage credits were exhausted. It produced no code finding and no file was changed; no substitute model was used.
- Antigravity (`agy`): `PASS` for the final no-tool planning and requirement-coverage review. It reported no findings or missing tests. It retained only the documented live-environment, generalized outbox reconciliation, and dedicated secret-scanner residual risks.

## Live shadow smoke

- PostgreSQL role and env bootstrap: PASS — six distinct principals and protected shadow profiles.
- Credentials: PASS — all six Phase 17 rows are `ACTIVE`, fingerprinted, and distinct. Legacy rows remain available for rollback.
- Six-account login: PASS — `manager-01`, `planner-01`, `coder-01`, `reviewer-01`, `qa-01`, and `summarizer-01` were simultaneously `ONLINE` in Shadow mode.
- Full six-role workflow: PASS — a real Discord `!task` message created one workflow; PM, Developer, Reviewer, QA, and Summarizer jobs each succeeded in one attempt; both approval points were resolved through the Manager API; the workflow and task lifecycle reached `SUCCEEDED`.
- Shadow delivery: PASS — all nine user-facing publication events and projections reached `SHADOWED`; internal scheduling events reached `POSTED`; no Discord message was sent. The final queue had zero active, pending, unhealthy, or reconciliation items.
- Shadow publication: the first live command exposed a runtime adapter mismatch in `publicationService.withTransaction`. The adapter now supports the application `{ query, pool }` shape, with unit and disposable-DB regression coverage. The three affected events had no publication rows or Discord sends, were conditionally retried, and reached `SHADOWED` with matching projections.
- Failure cleanup: the first attempt exposed stale ONLINE registrations after login failure. The runtime was corrected and the repeated attempt left all six instances `OFFLINE` after supervisor shutdown.
- Publication: no external message was sent because every profile remained in shadow mode.

## Environment evidence still required

- Manager-only ingress verification with expected role-account author IDs across repeated messages.
- Role bot and Manager forced-termination/reconnect/rate-limit smoke against Discord.
- A generalized operator reconciliation path for future outbox events that reach `NEEDS_RECONCILIATION`.

These remaining environment checks are Phase 17 Gate blockers and must not be represented as completed by the disposable DB tests or the successful six-account login and Planner-stage smoke.
