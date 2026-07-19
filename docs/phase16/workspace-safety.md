# Phase 16 Workspace Safety & Approval Binding

Phase 16은 Coder와 QA가 canonical repository를 직접 수정하지 못하게 하고, task별 격리 workspace에서 만든 정확한 candidate commit만 승인 후 통합하는 안전 경계를 제공한다.

## 기본 안전 상태

Phase 16 Gate가 수락되기 전에는 다음 값을 유지한다.

```dotenv
ISOLATED_WORKSPACE_MODE=false
CODER_WRITE_ENABLED=false
```

두 값 중 하나라도 `true`가 아니면 Coder/Codex/QA 실행은 차단된다. 격리 생성 또는 sandbox 실행에 실패해도 canonical workspace로 우회하지 않는다. Planner와 Reviewer의 읽기 작업은 계속 가능하다.

Gate 수락 후에만 아래 순서로 활성화한다.

1. `npm run migrate:phase16`
2. `npm run verify:db`
3. 사용할 container image를 로컬에 준비한다. 태그는 `latest`가 아닌 고정 버전 또는 digest여야 한다.
4. `ISOLATED_WORKSPACE_ROOT`를 canonical repository 밖의 전용 디렉터리로 지정한다.
5. `ISOLATED_SANDBOX_BACKEND=container`, `SANDBOX_CONTAINER_IMAGE=<고정 이미지>`를 설정한다.
6. Phase 16 DB Gate가 `ACCEPTED`인지 재확인한 뒤 `ISOLATED_WORKSPACE_MODE=true`, `CODER_WRITE_ENABLED=true`를 설정한다.

## 구성 요소

| 구성 요소 | 역할 |
|---|---|
| `workspace_lock_heads` | workspace별 최신 exclusive fencing token |
| `workspace_leases` | 복수 `READ_SHARED` 또는 단일 exclusive holder와 operation owner |
| `isolated_workspaces` | clone 생성, 활성화, candidate 준비, cleanup/reconciliation lifecycle |
| `artifacts` | base/candidate SHA, diff, 파일 목록, context hash의 불변 스냅샷 |
| `approvals` 확장 | artifact/context/base/candidate, task state/version, delegation, 만료시각 결합 |
| `workspace_finalizations` | finalizer claim과 정확히 한 번의 terminal 결과 |
| `workspace_safety_events` | append-only lease/control/finalization 감사 로그 |

기존 `workspace_locks`는 이전 runtime 호환을 위해 유지하지만 Phase 16 finalization에는 사용하지 않는다.

## Workspace와 sandbox 경계

- 격리 workspace는 canonical repository 밖에서 `git clone --no-local --no-hardlinks`로 생성한다.
- base commit을 detached checkout하고 `origin`을 제거한다. 격리 작업에서 canonical repository로 push할 수 없다.
- 경로 cleanup은 관리 root 아래의 실제 경로인지 재검사하고 symlink escape를 거부한다.
- untrusted sandbox는 container backend만 허용한다. native fallback은 없다.
- container는 network none, read-only root filesystem, non-root uid/gid, dropped capabilities, no-new-privileges, PID/memory/CPU 제한으로 실행한다.
- container에는 task workspace 하나만 read-write bind mount한다. canonical path와 host credential environment는 전달하지 않는다.

## Candidate와 context 결합

`contextManifestService`는 다음 정보를 canonical JSON으로 고정한다.

- task ID, 원 요청, plan, 실행 instruction, role
- expected task state와 row version
- 허용 경로와 도구
- risk level, policy version, revision/diff/cost 같은 constraints

`artifactService`는 Git object를 직접 읽어 다음을 만든다.

- base commit과 candidate commit
- binary diff hash
- 변경 파일별 path, mode, type, raw-byte SHA-256, size
- 변경 파일 수, 추가/삭제 line 수, binary/delete 수
- canonical context manifest hash

승인 표시에는 최소한 base/candidate SHA, artifact/context/diff hash, 전체 변경 경로, 변경량, binary/delete/large-diff 위험 신호, 승인 만료시각, 허용 finalizer와 target ref를 보여야 한다.

새 candidate artifact가 생기면 같은 task의 이전 PENDING/APPROVED bound approval은 `STALE`이 된다. finalization claim이 진행 중이면 새 candidate 등록 자체가 거부된다.

## 승인과 finalization

Bound approval은 다음 조건을 모두 만족할 때만 생성·해결된다.

- 저장된 artifact의 ID/hash/context/base/candidate가 요청과 정확히 일치
- task status와 row version이 expected 값과 일치
- 승인자와 요청자가 다름
- 미래의 expiry 존재
- delegation scope에 허용 finalizer actor와 target ref 존재

Finalizer는 bare canonical repository에서만 동작한다. 먼저 `FINALIZE_EXCLUSIVE` lease와 fencing token으로 DB claim을 선점한 다음, candidate object를 가져와 `git update-ref <target> <candidate> <base>`로 base가 그대로일 때만 원자 갱신한다. non-bare repository나 현재 ref가 다른 경우 실패한다.

Git ref 변경 뒤 DB terminal 기록이 실패하면 성공으로 추정하지 않고 `NEEDS_RECONCILIATION`으로 남긴다.

## Pause, resume, kill

- pause: task version CAS 후 process group에 `SIGSTOP`
- resume: task version CAS 후 process group에 `SIGCONT`
- kill: 먼저 `CANCEL_REQUESTED`를 기록하고, `SIGTERM`, grace period, 필요 시 `SIGKILL` 순으로 process group을 종료
- owner host/instance가 다르면 신호를 보내지 않는다.
- 프로세스가 사라졌지만 side effect가 확정되지 않으면 watchdog이 task를 `NEEDS_RECONCILIATION`으로 전환하며 자동 재실행하지 않는다.

## 운영 명령

```bash
npm run phase16 -- status
npm run phase16 -- reconcile-list
npm run migrate:phase16
```

`status`는 migration, feature flag, active lease, open workspace, claimed finalization, reconciliation 수를 출력한다. token, DB password, private key는 출력하지 않는다.

Phase 16 Gate 이전에는 migration을 적용해 shadow/readiness 검증할 수 있지만 `CODER_WRITE_ENABLED`는 반드시 `false`로 둔다.
