# ai-manager 작업 진행 보고서

작성일: 2026-07-16  
대상 프로젝트: `ai-manager`  
범위: Phase 5 ~ Phase 14 구현 및 검증 정리

## 요약

`ai-manager`는 단일 Discord 봇 기반 승인형 작업 흐름에서 출발해, task별 thread/log, PM 자동 루프, 최종 승인/반려, pause/resume, kill/watchdog, 멀티봇 실행, DB 기반 workspace lock, host/process ownership, stress harness, 배포 전 readiness 검증까지 확장되었다.

현재 구현 기준으로 Phase 5~14 작업은 완료되었고, 자동화된 readiness 검증도 통과한 상태다. 남은 항목은 코드 구현이 아니라 실제 Discord 채널에서 두 봇을 동시에 띄운 실환경 E2E 검증이다.

## 현재 상태

| 구분 | 상태 | 비고 |
| --- | --- | --- |
| Phase 5~14 구현 | 완료 | 요청된 핵심 기능 구현 완료 |
| 로컬 문법 검사 | 통과 | Phase 14 `npm run verify`에 포함 |
| Live DB schema 검증 | 통과 | `npm run verify:db` 통과 |
| Workspace lock stress | 통과 | `npm run verify:stress` 통과 |
| 실제 Discord 멀티봇 E2E | 남음 | 사용자 Discord 입력이 필요한 실환경 검증 |

## Phase별 작업 내용

### Phase 5: Task Thread 및 대화 로그 가시성

구현 내용:

- task별 Discord thread 생성
- thread 생성 실패 또는 thread 미지원 환경에서 parent channel fallback
- user/pm/agent 메시지를 DB `messages` 테이블과 thread/fallback 채널에 동시 기록
- `!log TASK-ID`로 task 대화 이력을 시간순 복원
- 기존 app log는 무인자 `!log`와 `!app-log`로 분리
- `!dbtask`와 manager mock pipeline도 task thread/log 흐름에 연결

주요 수정:

- thread 생성 후 안내 메시지 전송 실패 시 stale task가 반환되던 Medium 이슈 수정
- `discord_thread_id`가 DB에 저장된 뒤 안내 메시지 전송만 실패해도 이후 로그가 thread로 계속 라우팅되도록 보정

검증 결과:

- task thread 생성, fallback, 시간순 로그 복원, app log 명령 분리 모두 수용 가능 판정

### Phase 6: PM 자동 루프 및 에이전트 연동

구현 내용:

- `!autotask` 기반 PM 자동 오케스트레이션 루프
- `pm -> coder -> reviewer -> qa -> summarizer` 전이
- `PENDING_FINAL_APPROVAL` 도달
- revise/retry loop, QA fail feedback loop, max revision guard
- 동일 agent 연속 실패 감지 후 `PM_ESCALATION`
- archived Discord thread 자동 unarchive 후 메시지 전송

주요 수정:

- PM 자동 루프의 합성 로그 메시지가 실제 thread로 전송되는데도 DB `messages.channel_id`에 fallback channel id가 저장되던 감사 데이터 정합성 버그 수정
- `pmOrchestrator.append()`에서 fallback channel id 강제 전달을 제거하고, `taskLogService`가 실제 라우팅된 channel id를 기록하도록 정리

검증 결과:

- happy path, reviewer/coder revise loop, QA fail loop, escalation, archived thread 복구 모두 수용 가능 판정
- channel_id 오기록 수정분도 재검증 통과

### Phase 7: 최종 승인/거절 및 커밋/롤백

구현 내용:

- `PENDING_FINAL_APPROVAL` 상태에서 `!approve` 입력 시 git add/commit 수행
- 성공 시 task 상태 `DONE`
- `!reject` 입력 시 rollback 수행
- 성공 시 task 상태 `REJECTED`
- rollback 실패 시 `ROLLBACK_FAILED` 전이 및 수동 복구 안내
- approval 중복 호출 방어를 위한 atomic resolve 흐름 유지

주요 수정:

- `!reject` 핸들러를 `!approve`와 동일하게 `worker.enqueue()` 내부에서 task 조회/분기까지 처리하도록 리팩터링
- queue 선점 race와 유지보수 혼선을 줄이도록 두 명령의 구조 대칭화

검증 결과:

- 최종 approve/reject, rollback failure, duplicate transaction lock, channel_id 감사 무결성 모두 수용 가능 판정
- `!reject` queue 리팩터링 검증 통과

### Phase 8: Graceful Pause/Resume

구현 내용:

- `!end`로 task 일시중지 요청
- 실행 중 agent 작업은 강제 중단하지 않고 안전 checkpoint에서 `PAUSED` 전이
- 승인 대기 상태 등 즉시 멈출 수 있는 상태는 즉시 `PAUSED`
- `!resume TASK-ID`로 `paused_from_status` 복원 후 자동 루프 재진입
- pause/resume 이력 DB messages에 기록

주요 수정:

- `PAUSED` task가 active guard에서 빠져 새 task/project/run-codex를 허용하던 workspace 오염 버그 수정
- `ACTIVE_STATUSES`는 유지하고, 별도 `OCCUPIED_STATUSES` 및 occupied helper를 추가
- `!task`, `!autotask`, `!project`, `!run-codex`는 PAUSED task도 workspace 점유로 간주
- `!resume`은 재개 대상 task 자신을 제외하고 다른 점유 task만 차단하도록 조정

검증 결과:

- pause/resume, delayed pause, immediate pause, legacy flow 호환, PAUSED workspace occupancy 수정 모두 수용 가능 판정

### Phase 9: PID 추적, Kill, Watchdog

구현 내용:

- task-bound CLI 실행 시 `tasks.current_pid` 기록
- CLI 종료 시 PID 자동 정리
- `!kill TASK-ID`로 큐를 거치지 않고 즉시 프로세스 종료 요청
- kill 후 task를 `PM_ESCALATION` 및 `next_action=killed`로 전이
- worker watchdog 추가
- watchdog은 자동 kill하지 않고 Discord 경고만 발송

검증 결과:

- PID 기록/정리, stale PID 처리, kill 즉시성, watchdog 경고, 기존 pause/resume 무회귀 모두 수용 가능 판정

남은 운영 리스크:

- 실제 agent CLI가 하위 프로세스를 fork하는 경우 최상위 PID kill만으로 프로세스 트리 전체가 정리되지 않을 수 있음
- 이 리스크는 Phase 12에서 process group 기반 kill로 보강

### Phase 10: Multi-Bot 실행 하네스

구현 내용:

- `scripts/run-multibot.js`
- `npm run multibot -- .env.bot-a .env.bot-b`
- `ENV_FILE`, `BOT_INSTANCE_ID`, `COMMAND_PREFIX` 기반 다중 봇 실행
- instance별 stdout/stderr prefix
- instance별 app log 분리
- `!instance` 명령
- `.env.bot-a.example`, `.env.bot-b.example`
- `docs/phase10-multibot.md`

주요 수정:

- 자식 봇이 비정상 종료해도 부모 `run-multibot.js`가 exit code 0으로 자연 종료하던 Medium 이슈 수정
- `shutdown()` 진입 시 `process.exitCode = exitCode`를 즉시 설정하여 unref timer 전에 자연 종료되어도 실패 코드 보존

검증 결과:

- invalid token 기반 end-to-end 재현에서 부모 종료 코드 1 확인
- 후속 검증 기준으로 exit code 이슈 해소 확인

### Phase 11: DB 기반 전역 Workspace Lock

구현 내용:

- `workspace_locks` 테이블
- workspace 단위 DB lock
- atomic acquire/release/heartbeat
- TTL 기반 lock takeover
- lock busy UX 안내
- `!kill`, 조회성 명령은 lock 밖에서 즉시 동작
- workspace 변경성 명령은 lock 내부에서 실행

주요 수정:

- workspace path 문자열이 다르면 같은 실제 workspace도 다른 lock key로 취급되던 Medium 이슈 수정
- `path.resolve()` 적용
- 이후 Phase 12에서 `fs.realpathSync.native()`까지 추가되어 symlink alias도 가능한 범위에서 정규화

검증 결과:

- 동시성 충돌 차단, heartbeat, release, TTL, owner safety 모두 수용 가능 판정

### Phase 12: Host/Process Ownership 및 Process Tree Kill 보강

구현 내용:

- `src/core/hostIdentity.js`
- `HOST_INSTANCE_ID` 지원
- `workspace_locks.owner_host_id`
- `tasks.current_pgid`
- `tasks.current_host_id`
- `tasks.current_owner_instance_id`
- task-bound CLI를 POSIX 환경에서 detached process group으로 실행
- timeout/kill 시 PID 또는 PGID 대상 signal 전송
- `!kill`에서 현재 host와 task owner host가 다르면 remote kill 차단
- workspace lock acquire/release/heartbeat owner scope에 host id 포함

검증 결과:

- 문법 검사 통과
- live Postgres에서 task process field 기록/정리 확인
- workspace lock owner host safety 및 symlink realpath collision 확인

남은 운영 리스크:

- 다중 host/컨테이너 환경에서 remote kill은 의도적으로 지원하지 않음
- remote host task는 해당 host의 봇 인스턴스에서 kill해야 함

### Phase 13: Local Stress Harness

구현 내용:

- `scripts/stress-workspace-locks.js`
- `npm run stress:locks`
- 여러 child Node process가 동시에 같은 workspace lock 획득 시도
- 정확히 1개만 lock 획득하고 나머지는 busy 처리되는지 검증
- path/trailing slash/dot segment/symlink canonicalization 검증
- owner host/instance/pid safety 검증
- TTL takeover 검증
- task-bound CLI 실행 중 process ownership fields 기록 및 종료 후 정리 검증
- `docs/phase13-stress.md`

검증 결과:

- `npm run stress:locks -- --workers 6` 통과
- 테스트 후 `tasks`, `workspace_locks`, `command_logs` 잔여 row 0 확인

### Phase 14: Readiness Verification

구현 내용:

- `scripts/verify-readiness.js`
- `npm run verify`
- `npm run verify:db`
- `npm run verify:stress`
- `docs/phase14-readiness.md`
- multi-bot example env의 token 값을 placeholder로 정리

검증 범위:

- app-owned JS 파일 문법 검사
- package scripts 확인
- multi-bot example env 안전성 확인
- schema 정적 검증
- live DB schema 및 role seed 검증
- Phase 13 stress harness 통합 실행

검증 결과:

- `npm run verify` 통과
- `npm run verify:db` 통과
- `npm run verify:stress` 통과
- stress 이후 DB 잔여 row 0 확인

## 주요 명령어

정적 readiness:

```bash
npm run verify
```

Live DB readiness:

```bash
npm run verify:db
```

Stress readiness:

```bash
npm run verify:stress
```

멀티봇 실행:

```bash
npm run multibot -- .env.bot-a .env.bot-b
```

Phase 13 단독 stress:

```bash
npm run stress:locks -- --workers 8
```

## 주요 파일

| 파일 | 역할 |
| --- | --- |
| `bot.js` | Discord command entrypoint 및 phase별 명령 연결 |
| `src/core/taskLogService.js` | task thread/log 기록 및 fallback |
| `src/core/pmOrchestrator.js` | PM 자동 루프 |
| `src/core/taskService.js` | task 상태/점유/pause/resume 관리 |
| `src/core/workspaceLockService.js` | DB workspace lock |
| `src/core/processService.js` | PID/PGID kill 처리 |
| `src/core/hostIdentity.js` | host identity 정규화 |
| `services/shell.js` | CLI spawn, PID/PGID 기록, timeout kill |
| `src/queue/worker.js` | queue 및 watchdog |
| `scripts/run-multibot.js` | 멀티봇 실행 하네스 |
| `scripts/stress-workspace-locks.js` | lock/process ownership stress |
| `scripts/verify-readiness.js` | 배포 전 readiness 검증 |
| `src/db/schema.sql` | DB schema 및 seed |

## 검증 요약

수행 및 확인된 검증:

- 전체 주요 JS 문법 검사
- 실제 Postgres 기반 task/message/approval/lock/process field 검증
- mock Discord 기반 thread/fallback/unarchive/log 검증
- workspace lock 동시성 검증
- PID/PGID 기록 및 정리 검증
- `run-multibot.js` exit code 재현 검증
- readiness 통합 검증

마지막 통합 검증 기록:

- `npm run verify`: 통과
- `npm run verify:db`: 통과
- `npm run verify:stress`: 통과

## 남은 항목

남은 항목은 구현이 아니라 실제 Discord 환경 E2E다.

필수 확인:

```text
!a instance
!b instance
!a lock
!b lock
```

이후 한 봇에서 긴 작업을 시작한 상태에서 다른 봇으로 다음 명령을 입력해 lock busy 차단을 확인한다.

```text
!b autotask ...
!b task ...
!b run-codex ...
!b project ...
```

추가 확인:

- `!log TASK-ID`
- `!end`
- `!resume TASK-ID`
- `!kill TASK-ID`
- `!approve`
- `!reject`

## 운영상 주의사항

- 실제 운영 workspace가 아니라 테스트용 git workspace에서 멀티봇 E2E를 수행해야 한다.
- 실제 Discord token은 문서, 로그, 보고서에 남기지 않는다.
- `.env.bot-a.example`, `.env.bot-b.example`에는 placeholder만 유지한다.
- 다중 host 환경에서는 remote process kill을 지원하지 않는다.
- symlink workspace는 현재 `realpath`가 가능한 경우 같은 lock key로 정규화되지만, 존재하지 않는 path는 `path.resolve()` fallback이다.
- readiness/stress는 Discord gateway ordering이나 실제 agent CLI의 모든 비정상 동작을 대체하지 않는다.

## 최종 판단

구현 및 자동화 검증 기준으로 Phase 5~14는 완료 상태다. 실제 배포 또는 장시간 운영 전에 남은 핵심 작업은 실제 Discord 멀티봇 E2E 검증이며, 이를 통해 gateway 이벤트, 봇 권한, 실제 채널 thread 권한, 실제 agent CLI 장시간 실행 특성을 최종 확인해야 한다.
