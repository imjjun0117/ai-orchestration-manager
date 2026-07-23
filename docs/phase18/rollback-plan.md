# Phase 18 Rollback Plan

1. 새 memory source 수집과 retention purge 작업을 중지한다.
2. 여섯 역할 프로필을 모두 `TIERED_MEMORY_MODE=off`로 변경한다. 일부 역할만 변경한 mixed topology는 runner가 거부한다.
3. Phase 17 supervisor를 재기동하고 `npm run phase17 -- readiness`에서 여섯 역할과 queue가 정상인지 확인한다.
4. `npm run phase18 -- status`의 source, expired source, manifest, shadow report 수를 사건 기록에 남긴다. 원문이나 content를 내보내지 않는다.
5. memory 자료 보존이 필요하면 DB owner가 암호화된 운영 백업 정책으로 Phase 18 table만 백업한다. Discord, CLI, 일반 로그에 원문을 복사하지 않는다.
6. 아래 명령으로 migration을 내린다.

```sh
npm run phase18 -- rollback --allow-destructive --confirm-phase18
```

7. `npm run verify:db`, `npm run phase17 -- readiness`, 비쓰기 Discord 작업 한 건으로 Phase 17 fallback을 검증한다.

Rollback은 `memory_*` table, Phase 18 함수·trigger와 `tasks.memory_project_key`만 제거합니다. 기존 task, workflow, role job, outbox, Phase 16 workspace/approval, Phase 15 delivery Gate는 보존합니다. memory index 장애 시 직접 table 조회나 raw prompt 삽입으로 우회하지 않고 `off` fallback만 사용합니다.
