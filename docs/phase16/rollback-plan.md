# Phase 16 Rollback Plan

Rollback은 workspace safety schema를 제거하는 파괴적 작업이다. source artifact와 Gate evidence는 보존한다.

## 사전 조건

1. `.env` 또는 프로세스 환경에서 `CODER_WRITE_ENABLED=false`로 변경하고 역할 bot을 재시작한다.
2. `npm run phase16 -- status`에서 active lease와 claimed finalization이 모두 0인지 확인한다.
3. `npm run phase16 -- reconcile-list` 결과를 저장하고 각 workspace를 cleanup 또는 수동 reconciliation한다.
4. canonical bare repository의 대상 ref와 객체 저장소를 백업한다.
5. DB backup을 생성한다.

격리 기능이 꺼진 상태에서 Coder/QA는 읽기 전용 모드로 자동 전환되는 것이 아니라 실행 자체가 차단된다. canonical direct-write fallback은 없다.

## 실행

```bash
node scripts/phase16-workspace.js rollback --confirm-disable-writes
```

CLI는 `CODER_WRITE_ENABLED=true`, 활성 lease, active finalization claim 중 하나라도 있으면 rollback을 거부한다. rollback은 `017_workspace_safety_rework.down.sql`을 먼저 실행한 뒤 `017_workspace_safety.down.sql`을 각각 transaction으로 실행한다. 이미 적용된 round-1 migration 파일의 checksum은 변경하지 않는다.

## 보존되는 항목

- 기존 `tasks`, `approvals`, `workspace_locks` 테이블과 legacy 데이터
- Phase 15 Delivery Governance 테이블과 Gate evidence
- Git commit과 release artifact

먼저 제거되는 항목은 round-2 concurrency/reconciliation trigger와 procedure다. 이어 core rollback에서 Phase 16 테이블, procedure, trigger, `tasks.control_state/row_version`, Phase 16 approval 확장 column을 제거한다.

## 실패 복구

- migration transaction이 실패하면 전체 rollback되어 적용 전 schema가 유지된다. 오류를 수정한 뒤 같은 명령을 재실행한다.
- Git ref는 DB rollback 대상이 아니다. ref가 이미 변경됐다면 `workspace_finalizations`, event log, reflog를 먼저 대조하고 승인된 base/candidate 중 어느 값이 authoritative인지 운영자가 결정한다.
- ref 변경은 성공했지만 DB가 `NEEDS_RECONCILIATION`이면 임의로 재실행하지 않는다. [reconciliation-runbook.md](./reconciliation-runbook.md)의 finalizer 절차를 따른다.
- DB rollback 후에도 격리 디렉터리가 남았다면 경로가 `ISOLATED_WORKSPACE_ROOT` 아래인지 직접 확인하고 보존 또는 삭제한다. broad recursive delete를 사용하지 않는다.

## 재적용

```bash
npm run migrate:phase16
npm run verify:db
npm run test:phase16:db
```

Gate가 여전히 유효하고 canonical ref가 승인된 상태임을 확인하기 전에는 write flag를 다시 켜지 않는다.
