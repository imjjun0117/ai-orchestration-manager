# Phase 17 Requirements Trace

| Requirement | Implementation | Verification |
|---|---|---|
| MB-001 six role identities and tokens | `roleConfig.js`, `bot_role_principals`, protected six-profile bootstrap, node-start TTY enrollment, encrypted `channel_credentials`, six-bot preflight | six DB identities verified; principal-bound enrollment DB test; four Discord logins pass; valid QA/Summarizer accounts pending |
| MB-002 Manager-only ingress | `managerCommandIngress.js`, `receive_discord_command` principal/role check, receipt unique key | principal negative test; 20-way ingress test |
| MB-003 atomic role claim | `claim_role_job`, role/job capability policy, `SKIP LOCKED` | wrong-role rejection and 20-way single-winner test |
| MB-004 DB control channel | workflow/run/node/event/job/outbox tables and transaction APIs | PostgreSQL integration suite |
| MB-005 role-author publication | role-scoped outbox dispatcher and instance-bound Discord credential | shadow projection test; actual expected-author-ID smoke pending |
| MB-006 correlation and identity | task/workflow/job/publication correlation fields and deterministic marker | schema/integration assertions |
| MB-007 capability restriction | `phase17_job_type_allowed`, principal binding, Manager-only grants | privilege revocation and negative tests |
| MB-008 pause/recovery safety | Phase 16 task control and workspace fencing retained; Phase 17 job watchdog | Phase 16 regression plus lease recovery tests |
| MB-009 restart recovery | instance heartbeat, startup compensation, claim token, lease expiry, retry/reconciliation/dead-letter | safe/unsafe expiry, re-claim race, and invalid-login OFFLINE cleanup tests plus live repeat smoke |
| MB-010 token non-disclosure | hidden node-start prompt, AES-GCM encryption, principal-bound store/retrieve/revoke, runner plaintext rejection | prompt/store non-disclosure unit tests, cross-role DB rejection, PUBLIC revocation, reviewer scan |
| MB-011 operations | `!team`, `!health`, `!roles`, `!instance`, outbox response | command unit test; live Discord smoke pending |
| MB-012 six-env runner | `run-phase17-multibot.js` | six principal/profile preflight passes; four-account Discord process smoke passes; six-account smoke pending |
| MB-013 six-role E2E | six workflow definitions and Manager advancement | durable DB graph test; live six-bot E2E pending |
| ARC-001 transactional outbox | workflow transitions and outbox rows in stored procedures | outbox single claim, uncertain delivery, shadow projection tests |
| ARC-002 state/version invariant | node/run status checks, immutable events, Manager-only advancement | approval redelivery and stale completion tests |
| ARC-003 workspace fencing | Phase 16 isolated workspace gateway used by Coder/QA executor | Phase 16 database/container regression suites |
| DEL-001..010 delivery governance | existing Phase 15 submission/validation/Gate control plane | Phase 17 submission and Gate pending candidate commit |
