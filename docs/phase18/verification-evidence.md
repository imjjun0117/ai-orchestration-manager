# Phase 18 Verification Evidence

## Baseline

- Baseline commit: `d3e8fb9dd48acc05418037bf33683ffb46ce6d8d`
- Baseline worktree: clean
- Baseline `npm test`: PASS — 109 passed, 4 environment-gated skips
- Predecessor Gate: Phase 17 `ACCEPTED`
- Phase 18 delivery state at start: `IN_PROGRESS`, four distinct assignments active

## Current checks

- `npm run test:phase18`: PASS — 14 unit tests, disposable DB suite gated
- `npm run test:phase18:db`: PASS — 13/13 disposable PostgreSQL tests
- `npm test`: PASS — 124 passed, 5 environment-gated skips, 0 failed
- Phase 15/16/17 DB regression: PASS — 20/20, 11/11, 20/20
- Phase 16 container isolation: PASS — 1/1
- `npm run verify`: PASS — syntax 114 files, package scripts, profiles, static migration and operator docs
- `npm audit --omit=dev --audit-level=low`: PASS — 0 vulnerabilities
- Covered: source idempotency/versioning, role/project ACL, injection redaction, conflict exclusion, canonical manifest hash and active-claim binding revalidation, replay/stale evidence, source/index deletion split, index rebuild, derived deletion propagation, retention purge, migration down/reapply.
- Antigravity Round 1: `PASS`, BLOCKER/MAJOR 없음. Short task injection 표시와 timeout query 제한 두 MINOR를 반영·문서화함.
- Antigravity Round 2: `PASS`, BLOCKER/MAJOR/MINOR 없음. 배포 및 shadow 전환 가능 판정.
- Antigravity 임시 대체 검증: 개발·보안·운영 세 세션 모두 최초 `PASS`. 운영 판정과 코드 대조 중 Codex가 enforced runtime의 shadow-quality 강제 누락을 발견해 보완함. 보완 후 세 관점 전부 다시 `PASS`, BLOCKER/MAJOR/MINOR 0건.
- Claude Opus 4.8 Round 1: 구현 문제가 아닌 계정 session limit으로 검토 인프라 차단. 서울 기준 01:10 초기화 후 재시도 예정.
- Claude Opus 4.8 최종 Round 1: `PASS`, BLOCKER/MAJOR 없음, MINOR 5건. 신규 principal grant, injection 증거 재검증, Short-only shadow 품질 세 항목을 수용·보완. boot-only 재검증은 Gate/증거 불변성으로 기각, query 미취소는 문서화된 확장 전 제한으로 유지.
- Claude Opus 4.8 최종 Round 2: `PASS`, 수용한 세 항목 해결 확인, 신규 BLOCKER/MAJOR 없음. Short 표시 신뢰도, 빈 요청 fallback, 확장 전 query/admission control은 비차단 잔여 위험.
- Antigravity 독립 최종 검증: `PASS`, BLOCKER/MAJOR/MINOR 0건. 최신 principal grant, injection DB 대조, non-Short five-role shadow gate를 모두 확인.
- 최초 live shadow canary는 worker principal에 `tasks.title`, `tasks.memory_project_key` column `SELECT`가 없어 legacy fallback으로 안전 중단됨. Discord 발송, 코드 변경, context manifest 기록은 없었고 만료 claim은 watchdog으로 `RETRY_WAIT` 복구됨.
- 후속 migration `024_phase18_runtime_task_grants`가 기존 5개 worker principal의 누락 column 권한을 보정하고, `provisionOnClient`가 이후 생성되는 principal에도 같은 최소 권한을 부여함. disposable DB에서 기존 principal grant와 rollback/reapply를 검증함.
- live migration 024 적용: PASS — 023 checksum 불변 확인, 024 checksum `c64828183926172bf1505dece608966ecc1676b0b5cb179cd3e7373522963352`, live DB readiness PASS.
- 실제 5역할 shadow canary: PASS — planner/coder/reviewer/qa/summarizer 각 1건, non-Short 선택 5건, fallback 0건, 최대 retrieval 62ms. 외부 발송 대신 canary outbox 23건을 claim-bound suppression하고 승인형 workflow는 승인하지 않고 반려 종결함.
- canary 후 운영 정합성: active/unhealthy job 0, pending/unhealthy outbox 0, inconsistent terminal task 0. launchd supervisor와 6개 봇을 재기동해 모두 `ONLINE` 확인.
- Antigravity 후속 기획 검증: `PASS`, 024 적용 후 shadow 재개 승인, 5역할 증거 전 enforced 금지 판정. 권고한 context-builder column/provisioning grant 정적 대조도 상수 기반 테스트로 보완함.
- Claude Opus 4.8 후속 검증은 로컬 CLI 인증 만료(`Not logged in`)로 실행되지 않았고, Antigravity 개발·보안 대체 세션 두 번은 판정 없이 timeout. 따라서 이 후속 수정에 대한 최종 Phase Gate와 enforced 전환은 독립 개발 검증이 복구될 때까지 보류함.

이 문서는 독립 검토, live migration/shadow canary와 Gate 결과가 진행될 때 갱신합니다.
