# Phase 16 Requirements Trace

| ID | 요구사항 | 구현 | 검증 |
|---|---|---|---|
| WS-001 | task별 clone, canonical remote 제거 | `isolatedWorkspaceService.js` | DB integration: orphaned isolated workspace |
| WS-002 | canonical fallback 금지 | `workspaceExecutionPolicy.js`, `featureFlags.js`, `services/shell.js` | unit: Coder/QA fallback 거부 |
| WS-003 | container sandbox path/network/resource 제한 | `sandboxService.js` | unit policy + actual Docker escape suite |
| WS-004 | 20-way shared lease | `acquire_workspace_lease` | DB integration: twenty readers |
| WS-005 | exclusive 경쟁·fencing 증가 | lease procedures | DB integration: one winner, stale heartbeat |
| WS-006 | generic operation owner | `workspace_leases.lease_owner_operation_id` | migration + lease integration tests |
| WS-007 | canonical context hash | `contextManifestService.js` | unit: instruction/scope/version hash 변화 |
| WS-008 | candidate/diff/file manifest | `artifactService.js` | unit: raw file/binary diff/stat 재현 |
| WS-009 | artifact immutable, supersession stale | core/rework migration triggers | DB integration: mutation 거부, claim/supersession race one-winner |
| WS-010 | approval exact binding | `approvalService.js`, approval columns | DB integration: hash/context mismatch 거부 |
| WS-011 | state/version/expiry/delegation binding | service + `claim_candidate_finalization` | DB integration: self approval, version, actor scope 거부 |
| WS-012 | competing finalization exactly one | unique claim + FINALIZE lease + task row serialization | DB integration: two claims one winner, task update/새 artifact race 차단 |
| WS-013 | base ref CAS와 bare canonical | `finalizerService.js` | DB/Git integration: atomic `update-ref` |
| WS-014 | stale finalizer 차단 | fencing checks in claim/complete | DB integration: released/stale fence 성공 완료 거부 |
| WS-015 | pause/resume process group | `processService.js`, `taskControlService.js`, Discord `!end/!resume` | unit real PGID + DB state test + runtime wiring |
| WS-016 | cancel intent before kill | `killTaskProcess`, Discord `!kill` | DB integration checks state inside kill callback + runtime wiring |
| WS-017 | orphan process/workspace/finalizer reconciliation | task/isolated/reconciliation services + CLI | DB integration, dry-run/apply CAS, incident evidence |
| WS-018 | append-only audit | event trigger | DB integration + PUBLIC privilege checks |
| WS-019 | migration rollback | core + additive rework down files, CLI guard | reverse-order down/reapply, legacy preservation |
| WS-020 | Gate 전 write disabled | flags + DB `phase-16=ACCEPTED` assertion | unit false/accepted DB Gate; every write entry |
| WS-021 | 사용자 approval 화면 | `approvalDisplay.js`, bound approval query, Discord/CLI | unit required fields + operational DB flow |
| WS-022 | 실제 task lifecycle 연결 | `taskWorkspaceWorkflowService.js`, `!implement`, exact `!approve ID` | DB E2E: isolated→artifact→approval→finalizer→cleanup |
| WS-023 | approval/hash 변경과 task claim 동시성 | `017_workspace_safety_rework` | disposable DB claim/artifact race + claimed task update rejection |

검증 명령:

```bash
npm test
npm run test:phase16:db
npm run test:phase16:container
npm run verify
npm run verify:db
git diff --check
```

DB integration은 매 실행마다 별도 database를 생성하고 정상 연결 종료 후 제거한다. 라이브 DB를 테스트 대상으로 사용하지 않는다.
