# Phase 16 Reconciliation Runbook

Unknown side effect는 자동 성공 또는 자동 재시도로 처리하지 않는다.

## 1. 상태 수집

```bash
npm run phase16 -- status
npm run phase16 -- reconcile-list
```

DB의 `workspace_safety_events`, `workspace_finalizations`, `workspace_leases`, `isolated_workspaces`를 시간순으로 확인한다. credential, token, private key는 incident 기록에 복사하지 않는다.

## 2. 죽은 process owner

`reconcileOrphanedTaskProcesses`는 현재 host 소유 task만 검사한다.

- process 또는 process group이 살아 있으면 자동으로 ownership을 탈취하지 않는다.
- 죽었으면 PID/PGID owner를 비우고 task를 `NEEDS_RECONCILIATION`으로 CAS 전환한다.
- candidate workspace에서 `git status`, `git rev-parse HEAD`, artifact 존재 여부를 확인한다.
- side effect가 없다고 증명된 경우에만 새 operation ID와 새 lease로 재실행한다.

먼저 dry-run으로 확인하고, 적용 시 request 파일과 `--apply`를 모두 요구한다.

```json
{"actorId":"gate-admin","apply":false}
```

```bash
npm run phase16 -- reconcile-processes process-reconcile.json
# 확인 후 JSON의 apply를 true로 바꾸고:
npm run phase16 -- reconcile-processes process-reconcile.json --apply
```

## 3. Orphan workspace

`reconcile-list`의 각 항목에 대해 다음을 확인한다.

1. path가 configured isolation root 아래인지 확인
2. lease 만료·release 여부와 operation owner 확인
3. uncommitted change와 candidate commit 존재 여부 확인
4. artifact가 있으면 DB hash와 Git object를 재계산
5. 보존이 필요하면 incident용 read-only archive를 만들고, 아니면 owner-aware cleanup 실행

경로가 canonical repository 또는 isolation root 밖이면 자동 삭제하지 않고 security incident로 분류한다.

```json
{
  "isolatedWorkspaceId":"iw-...",
  "expectedStatus":"NEEDS_RECONCILIATION",
  "actorId":"gate-admin",
  "incidentEvidence":{"incidentId":"INC-2026-001","rationale":"owner process is gone and candidate was archived"},
  "apply":false
}
```

```bash
npm run phase16 -- reconcile-workspace workspace-reconcile.json
# 출력의 path/status/action을 확인하고 JSON apply=true로 변경한 뒤:
npm run phase16 -- reconcile-workspace workspace-reconcile.json --apply
```

path가 이미 없으면 DB row, lease release, append-only event가 한 transaction에서 정리된다. path가 있으면 configured isolation root를 다시 검증한 owner-aware cleanup만 실행한다.

## 4. Finalizer reconciliation

`NEEDS_RECONCILIATION` finalization은 다음 값을 대조한다.

- bare canonical `target_ref` 현재 SHA
- finalization의 base/candidate SHA
- approval/artifact/context hash와 expiry
- lease fencing token과 event ordering

판정:

- ref가 candidate이고 artifact가 일치하면 DB terminal 상태를 관리자 recovery operation으로 보정한다.
- ref가 base이면 기존 claim을 재사용하지 않는다. 새 lease, 새 fencing token, 새 approval을 만든다.
- ref가 base/candidate 어느 것도 아니면 외부 변경으로 간주하고 자동 진행을 중단한다.

관리자 보정은 사유, 확인자, before/after ref, artifact hash를 append-only incident evidence에 남긴다.

```json
{
  "finalizationId":"finalization-...",
  "expectedStatus":"NEEDS_RECONCILIATION",
  "terminalStatus":"SUCCEEDED",
  "actorId":"gate-admin",
  "incidentEvidence":{"incidentId":"INC-2026-002","rationale":"bare canonical ref equals the approved candidate"},
  "apply":false
}
```

```bash
npm run phase16 -- reconcile-finalization finalization-reconcile.json
# observedRefSha가 candidate와 정확히 같은지 확인하고 JSON apply=true로 변경한 뒤:
npm run phase16 -- reconcile-finalization finalization-reconcile.json --apply
```

서비스는 bare canonical ref를 직접 재계산한다. `SUCCEEDED`는 observed ref가 approved candidate일 때만, `FAILED`는 ref가 approved base일 때만 허용한다. DB procedure도 expected status CAS와 incident evidence를 재검증한다.

## 5. Kill 직후

kill은 `CANCEL_REQUESTED` event가 process signal보다 먼저 존재해야 한다. 그 다음 `TASK_PROCESS_KILLED` 또는 reconciliation event가 있어야 한다.

- process가 살아 있으면 owner가 맞는지 확인 후 grace/hard kill을 다시 판단한다.
- process가 죽고 workspace가 clean하면 `CANCELLED`로 종료할 수 있다.
- workspace change 여부가 불명확하면 `NEEDS_RECONCILIATION`을 유지한다.

## 6. 종료 조건

- active lease와 claimed finalization 0
- canonical ref가 승인된 commit 또는 명시적으로 복구한 commit
- orphan workspace 0 또는 각 항목에 owner와 후속 조치가 기록됨
- task/process projection과 append-only event가 일치
