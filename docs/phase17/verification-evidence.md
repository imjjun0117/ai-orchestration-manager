# Phase 17 Verification Evidence

## Automated checks

- `npm test`: PASS — 109 tests passed; four environment-gated suites skipped.
- `npm run test:phase17:db`: PASS — 20/20 disposable PostgreSQL tests, including principal-bound runtime enrollment/revocation, current-claim-bound skill/process/command logging, rejected-task status synchronization, operator reconciliation, explicit role-job retry guard rejection, sibling dead-letter state, and the real inventory query.
- `npm run test:phase15:db`: PASS — 20/20 governance and credential regression tests.
- `npm run test:phase16:db`: PASS — 11/11 workspace, finalization, fencing, and rollback regression tests.
- `npm run test:phase16:container`: PASS — network, root-write, non-root, and resource isolation policy.
- `npm run verify:db`: PASS — 105 JavaScript syntax checks, package/env/docs checks, migration `020` checksum, reconciliation table/function/triggers, PUBLIC revocation, bot-principal operator-function denial, and live schema.
- `npm run verify:stress`: PASS — six-worker workspace-lock contention, owner safety, TTL takeover, and process ownership.
- `npm audit --omit=dev --audit-level=low`: PASS — zero vulnerabilities after removing the unused legacy `codex@0.2.3` package and updating `discord.js` to 14.27.0 (`undici` 6.27.0).
- `npm run phase17 -- verify-role-profiles`: PASS — all six 0600 profiles connected as their expected PostgreSQL `SESSION_USER` and matched enabled role bindings.
- migration smoke: PASS — `018_durable_control_plane`, additive `019_phase17_credential_enrollment`, and `020_phase17_operator_reconciliation` up/down/reapply with legacy tasks preserved.
- `git diff --check`: PASS.
- `node --test test/phase17/botSetup.test.js`: PASS — 5/5 tests covering the six exact mappings, default menu, hidden-token storage metadata, ACTIVE preserve/replace, duplicate reprompt, missing-fingerprint refusal, secret-safe output, and non-TTY fail-closed behavior.
- `node --test test/phase17/discordAuthorSmoke.test.js`: PASS — 5/5 tests covering explicit live confirmation, Shadow-only profiles, plaintext-token refusal, control-env data minimization, exact DB identity bindings, repeated author matching, and Manager bot-message rejection.
- `node --test test/phase17/discordResilienceSmoke.test.js`: PASS — 6/6 tests covering explicit confirmation, bounded read-only rate-limit probes, inherited-token removal, exact process evidence, controlled Gateway Resume, and six-role rate-limit recovery evidence.
- interactive `node bot.js` menu smoke: PASS — the Phase 17 six-bot option is the default and exit completed without touching credentials; the non-TTY invocation failed before consuming input.

The Phase 17 DB suite covers PUBLIC privilege revocation, principal-role negative paths, 20-way duplicate ingress, wrong-role claim, 20-way atomic claim, Manager-separated advancement, approval redelivery, stale completion, safe/unsafe lease recovery, immediate re-claim race protection, outbox reconciliation, operator role-job/outbox retry and dead-letter decisions, repeated request idempotency, stale revision rejection, 20-way reconciliation single-winner behavior, append-only audit enforcement, shadow publication, and rollback preservation.

## Active canary hardening

- Planner 모델은 실행 프로필과 CLI argv 모두에서 `claude-opus-4-8`로 고정된다. 종료 코드 0으로 반환된 사용량/인증 오류 문구와 빈 출력도 `CLAUDE_PROVIDER_UNAVAILABLE` 또는 `CLAUDE_EMPTY_RESPONSE`로 실패 처리된다.
- migration `022_phase17_canary_hardening`은 역할 DB principal에 테이블 전체 쓰기 권한을 주지 않는다. 실행 중인 자기 claim/task에 한해서만 skill 조회, PID 기록/정리, command log 추가를 허용하며 다른 task와 완료된 claim은 거부한다.
- workflow run이 `REJECTED`로 전환되면 레거시 `tasks.status`와 `lifecycle_status`를 함께 동기화하고, readiness가 남은 불일치를 차단한다.
- 사유 없는 `!reject` 등 안전하게 설명 가능한 승인 오류는 감사 가능한 Manager outbox 응답으로 한글 사용법을 돌려준다.

Enrollment verification covers the `node bot.js` six-role bulk wizard plus direct role-node fallback, hidden TTY prompting, AES-GCM storage, plaintext absence from DB parameters/output, ACTIVE preserve/replace, six-target duplicate rejection, non-TTY fail-closed behavior, invalid-token revocation, immediate pool cleanup, and live execute privileges for all six role principals. A live QA TTY launch displayed the hidden prompt and was cancelled without entering or storing a token; the instance returned to `OFFLINE`.

## Independent verification

- Claude Opus 4.8: selected by explicit user instruction after Fable repeatedly returned usage-credit HTTP 429. Its first read-only development review returned `PASS` with no code findings. All five requirement-implied coverage cases were added, and its fresh revalidation returned `PASS` with every prior observation resolved, no new findings, and no missing tests. Residuals are the disposable suite's intentional sequential shared-DB setup and its explicit `PHASE17_DB_TEST=1` gate; the suite was run directly and passed 15/15 before delivery.
- Antigravity (`agy`): `PASS` for the final operator-reconciliation implementation, live-application evidence, and requirement coverage. It reported no findings, missing tests, or residual risks.

## 거버넌스 승인

- 후보 커밋: `5cef762c5d8ae2aeff37626d5caa84fec048e800`
- 봉인 제출: `phase17-submission-round-1`
- 봉인 매니페스트: `docs/phase17/submission-round1.sealed.json`
- 아티팩트 번들 해시: `sha256:66ffa14f471f10f7c2efedde29bcbc6b6c49ad5f701e597aedb7b35c639ff44a`
- 계획 검증: `phase17-round1-planning-verdict` — Antigravity 증적, `APPROVED`
- 개발 검증: `phase17-round1-development-verdict` — 사용자 지시에 따라 Fable 대신 Claude Opus 4.8 증적, `APPROVED`
- 열린 지적/기술부채: 0건
- 최종 Gate: `ACCEPTED` (`2026-07-22T05:08:47.451Z`, row version 7)

Gate 승인과 봇 프로세스 실행은 분리되어 있다. 승인 직후에도 여섯 봇은 의도적으로 `OFFLINE`이며, 실제 운영 시작은 운영자가 역할 프로필과 실행 모드를 확인한 뒤 별도로 수행한다.

## Live shadow smoke

- PostgreSQL role and env bootstrap: PASS — six distinct principals and protected shadow profiles.
- Credentials: PASS — all six Phase 17 rows are `ACTIVE`, fingerprinted, and distinct. Legacy rows remain available for rollback.
- Six-account login: PASS — `manager-01`, `planner-01`, `coder-01`, `reviewer-01`, `qa-01`, and `summarizer-01` were simultaneously `ONLINE` in Shadow mode.
- Expected-author-ID E2E: PASS — all six DB-bound Discord identities sent two live transport messages each. All 12 sent and fetched author IDs matched their role binding; Manager observed and rejected all 12 bot-authored `!task` messages; `discord_event_receipts` remained at zero for their message IDs; all 12 test messages were deleted by their exact IDs.
- Full six-role workflow: PASS — a real Discord `!task` message created one workflow; PM, Developer, Reviewer, QA, and Summarizer jobs each succeeded in one attempt; both approval points were resolved through the Manager API; the workflow and task lifecycle reached `SUCCEEDED`.
- Shadow delivery: PASS — all nine user-facing publication events and projections reached `SHADOWED`; internal scheduling events reached `POSTED`; no Discord message was sent. The final queue had zero active, pending, unhealthy, or reconciliation items.
- Shadow publication: the first live command exposed a runtime adapter mismatch in `publicationService.withTransaction`. The adapter now supports the application `{ query, pool }` shape, with unit and disposable-DB regression coverage. The three affected events had no publication rows or Discord sends, were conditionally retried, and reached `SHADOWED` with matching projections.
- Failure cleanup: the first attempt exposed stale ONLINE registrations after login failure. The runtime was corrected and the repeated attempt left all six instances `OFFLINE` after supervisor shutdown.
- Process restart: PASS — each of the six real role entrypoints reached `ONLINE`, was terminated by exact child PID with `SIGKILL`, retained detectable stale PID state, restarted with a new PID and the same DB-bound Discord identity, then exited cleanly by `SIGTERM`; all six final instance states were `OFFLINE`.
- Gateway reconnect: PASS — after all six clients reached initial Ready, each controlled shard interruption emitted `shardReconnecting` and `shardResume` and returned to Ready.
- REST rate-limit recovery: PASS — Discord reported a 5-request/1-second bucket for the recent-message read endpoint. All six identities emitted a positive-wait rate-limit event and completed a subsequent recovered read; no Discord message was created.
- Resilience hardening: the first reconnect attempt showed that `client.login()` may resolve before full Guild Ready, so the smoke now waits for each initial Ready before interruption. A channel-metadata probe reported a 1,000-request bucket, so the bounded test switched to the read-only recent-message endpoint only after its 5-request/1-second response headers were observed. Failed attempts left no child process and all six DB instances `OFFLINE`.
- Publication: no external message was sent because every profile remained in shadow mode.

## Operator reconciliation evidence

- Migration `020_phase17_operator_reconciliation` adds per-item reconciliation revisions and append-only `phase17_reconciliation_actions` without granting the recovery function or audit table to PUBLIC/bot principals.
- `reconcile-list` returns identifiers, revision, role/type, retry policy, attempt counts, error code, and projection status only; payload, correlation/channel identifiers, error detail, credentials, and connection strings are excluded.
- `reconcile` requires an exact item, expected revision, unique request ID, 16+ character rationale, evidence reference, decision, and explicit confirmation. Same-input request replay is idempotent; stale or conflicting decisions fail closed.
- Role-job retry restores claimable workflow/node/task state only when task control remains `RUNNING` and no sibling reconciliation is unresolved. Outbox retry resets nonterminal publication state so the existing author-bound correlation-marker path runs before any send. Explicit dead-letter is treated as resolved only when its audit action matches the current reconciliation revision.
- Live application: PASS — all six instances were `OFFLINE`; migrations `018`/`019` remained checksum-matched no-ops and `020` applied once. `reconcile-list` returned zero unresolved items. Active/pending/unhealthy role-job and outbox counts were all zero; readiness blockers were limited to the six intentionally stopped instances.

The previous generalized operator-recovery Gate blocker is implemented, covered in the disposable DB suite, independently approved by Claude Opus 4.8 and Antigravity, and accepted by the Phase 17 governance Gate.
