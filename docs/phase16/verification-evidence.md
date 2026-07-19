# Phase 16 Worker Verification Evidence

이 문서는 worker의 사전 evidence이며 독립 검증자의 서명 verdict가 아니다.

## Round 3 재작업 결과

- Round 1 candidate: `38f5ff6b6894fb39861c1ba032d5452b2b102173`
- Round 1 planning verdict: `CHANGES_REQUESTED`
- Round 2 candidate: `ae3a0f15d1c2e14ea07eb66e2b3b11759d8e2532`
- Round 2 bundle: `sha256:a35e5a3a9066f66f003075461507ce8b5bdb4c1542dd4e09bbc3152527f56246`
- Round 2 development verdict: signed `APPROVED`
- Round 2 planning verdict: signed `CHANGES_REQUESTED` (3 MAJOR)
- live core migration: `017_workspace_safety` applied (파일과 checksum은 변경하지 않음)
- additive rework migration: `017_workspace_safety_rework` applied
- additive migration checksum: `1165f1b8f3f0566bad115a66e95349ee9e750394b18fa7630c0814661d61be9e`
- migration checksum: `1976f2cf1d1c94874ee65ef5441faad68ec61695773873fa6a2f27e233452ed6`
- `npm test`: PASS, 42 passed with 3 gated skips
- `npm run test:phase16`: PASS
- `npm run test:phase16:db`: PASS, 11/11
- `npm run test:phase16:container`: PASS, 1/1 actual Docker policy probe
- `node --check`: PASS
- disposable PostgreSQL cleanup: PASS
- live DB mutation during integration tests: 없음
- `npm run verify:db`: PASS after live additive migration
- post-migration state: active lease 0, open workspace 0, claimed finalization 0, reconciliation 0
- activation state: `ISOLATED_WORKSPACE_MODE=false`, `CODER_WRITE_ENABLED=false`, canonical fallback false

검증된 주요 시나리오:

- 20개 `READ_SHARED` holder 공존, exclusive 거부
- exclusive/finalizer 경쟁 정확히 한 winner와 fencing 증가
- stale heartbeat와 released fence finalization 거부
- artifact/hash/context/base/candidate/task-version/delegation mismatch 거부
- bare Git ref의 exact base-to-candidate CAS
- process group pause/resume/kill, cancel intent 선행
- dead process와 expired workspace lease reconciliation
- PUBLIC 권한 0, artifact/event 불변성
- `017` down/up 및 legacy task/approval 보존
- DB Gate가 `ACCEPTED`가 아니면 flags가 true여도 write 거부
- finalization claim/task update/superseding artifact 동시성 직렬화
- isolated execution → candidate → detailed approval → bare finalizer → cleanup E2E
- Discord `!implement`, exact `!approval/!approve ID`, safe pause/resume/kill wiring
- reconciliation dry-run/apply, incident evidence, canonical ref 검산
- production `!implement`의 등록 native Codex sandbox와 후속 registered QA container 강제
- native agent environment에서 DB URL/Discord token/channel master key 제거
- 임의 또는 canonical path의 `sandbox-run` mount 거부
- pause DB CAS 실패 시 process signal 0회, signal 불확실 시 reconciliation 전환
- workspace cleanup의 status/lease owner/operation/fencing snapshot CAS와 stale-plan path 보존
- path가 존재하는 cleanup에서도 incident evidence를 workspace row와 append-only event에 보존

최종 candidate commit과 bundle hash의 authoritative 값은 sealed manifest가 제공한다. commit hash의 자기참조로 candidate가 바뀌는 문제를 피하기 위해 이 evidence 본문에는 값을 중복 기록하지 않는다.
