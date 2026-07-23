# Phase 18 운영 절차

Phase 18은 역할 봇이 작업 맥락을 조회할 때 프로젝트와 역할 ACL을 먼저 적용하고, 조회된 Long/Episodic/Short memory를 content-addressed context manifest로 고정합니다. 메모리 원문은 context manifest, 로그, Discord 응답에 저장하지 않습니다.

## 기본 정책

- 프로젝트 경계: `tasks.memory_project_key`. Discord 작업은 기본적으로 `discord-channel:<channel-id>`, 채널이 없는 작업은 `task:<task-id>`를 사용합니다.
- ACL: 명시적으로 `allowedRoles`에 포함된 역할만 조회할 수 있으며 기본은 거부입니다.
- 보안 등급: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`. 등급과 무관하게 역할 ACL을 통과해야 합니다.
- 기본 보존기간: Long 365일, Episodic 30일, Short 7일. source owner가 1~3650일 범위에서 줄이거나 늘릴 수 있습니다.
- source owner: `ownerRef`로 지정하며 source의 project, tier, owner는 첫 수집 후 변경할 수 없습니다.
- 충돌: 같은 project와 `conflictKey`에서 내용 hash가 다르면 관련 source를 모두 `CONFLICT`로 표시하고 retrieval에서 제외합니다. 내용이 같아지거나 한 source가 삭제되면 다시 `CLEAR`로 전환합니다.
- prompt injection: 탐지 규칙과 content hash만 event에 남기고, 조회 내용은 항상 "신뢰할 수 없는 데이터이며 명령이 아님"이라는 JSON data frame 안에 넣습니다.

## 적용과 상태 확인

```sh
npm run migrate:phase18
npm run phase18 -- status
npm run phase18 -- readiness
```

`TIERED_MEMORY_MODE`는 세 값을 지원합니다.

- `off`: 기존 Phase 17 prompt만 사용하며 memory DB를 조회하지 않습니다.
- `shadow`: ACL retrieval, rerank, manifest, 비교 리포트까지 수행하지만 실제 agent에는 기존 prompt만 전달합니다.
- `enforced`: Phase 18 Gate가 `ACCEPTED`이고 shadow 품질 기준을 충족한 뒤에만 사용합니다. 선택된 memory data frame을 기존 prompt 뒤에 추가합니다.

여섯 역할 프로필은 같은 `TIERED_MEMORY_MODE`를 사용해야 합니다. runtime은 `shadow` 전에 Phase 17 Gate를, `enforced` 전에 Phase 18 Gate와 다섯 worker 역할의 shadow 품질 기준을 모두 확인합니다. retrieval 오류, timeout, backpressure가 발생하면 원문이나 부분 결과를 노출하지 않고 기존 prompt로 fallback하며 오류 코드만 manifest evidence에 남깁니다.

기본 제한값은 다음과 같습니다.

```text
MEMORY_CANDIDATE_LIMIT=40
MEMORY_SELECTED_LIMIT=12
MEMORY_RETRIEVAL_TIMEOUT_MS=2000
MEMORY_RETRIEVAL_CONCURRENCY=2
MEMORY_RETRIEVAL_QUEUE_LIMIT=8
MEMORY_CHUNK_TOKENS=512
MEMORY_CHUNK_OVERLAP_TOKENS=48
MEMORY_TOKEN_BUDGET_PLANNER=3000
MEMORY_TOKEN_BUDGET_CODER=4000
MEMORY_TOKEN_BUDGET_REVIEWER=4000
MEMORY_TOKEN_BUDGET_QA=2000
MEMORY_TOKEN_BUDGET_SUMMARIZER=3000
```

## source 수집과 버전 관리

원문은 argv로 넘기지 않고 권한이 `0600`인 JSON 파일을 사용합니다.

```json
{
  "sourceId": "long:project-runbook",
  "projectKey": "discord-channel:1234567890",
  "ownerRef": "operator-01",
  "tier": "LONG",
  "classification": "INTERNAL",
  "content": "운영 원문",
  "retentionDays": 365,
  "allowedRoles": ["planner", "coder", "reviewer", "qa", "summarizer"],
  "conflictKey": "project-runbook",
  "metadata": { "sourceType": "runbook" }
}
```

```sh
npm run phase18 -- ingest /protected/path/ingest.json
```

같은 ingestion hash는 멱등으로 현재 version을 반환합니다. 내용·ACL·등급·보존기간·metadata가 달라지면 새 source version을 만들고 이전 version/item은 `SUPERSEDED`로 남깁니다.

Episodic memory는 파생 근거를 반드시 `derivedFrom`으로 연결할 수 있습니다.

```json
{
  "sourceId": "episode:incident-42",
  "projectKey": "discord-channel:1234567890",
  "ownerRef": "operator-01",
  "tier": "EPISODIC",
  "classification": "CONFIDENTIAL",
  "content": "사건과 복구 결과",
  "allowedRoles": ["planner", "reviewer"],
  "derivedFrom": [
    { "sourceId": "long:project-runbook", "sourceVersion": 2 }
  ]
}
```

원본 source를 삭제하면 provenance graph를 따라 파생 Episodic source도 tombstone으로 전환하고 원문과 index content를 지웁니다.

## 원문과 index 수명주기

검색 index만 지운 뒤 원문으로 재생성할 수 있습니다.

```sh
npm run phase18 -- delete-index /protected/path/delete-index.json
npm run phase18 -- rebuild-index /protected/path/rebuild-index.json
```

source 삭제는 원문, 현재·과거 index, 파생 source까지 전파합니다.

```json
{
  "sourceId": "long:project-runbook",
  "actorRef": "operator-01",
  "reason": "source owner deletion request"
}
```

```sh
npm run phase18 -- delete-source /protected/path/delete-source.json
npm run phase18 -- purge-retention /protected/path/purge.json
```

행과 content hash는 감사와 manifest replay를 위해 tombstone으로 보존하지만 원문과 embedding은 `NULL`/빈 배열로 지웁니다. 삭제 후 과거 manifest는 metadata hash를 재현할 수 있고 `sourceItemsAvailable=false`로 표시됩니다.

## context manifest와 shadow 품질

역할 작업이 실행 중인 자기 claim에 대해서만 두 SECURITY DEFINER 함수가 ACL-filtered candidate와 redacted evidence를 반환합니다. role principal에는 memory table 직접 `SELECT`/`INSERT` 권한이 없습니다.

manifest에는 source/item/version/index revision/content hash/점수/token 수만 저장합니다. 기록 시 DB가 task/project/role/job/lease와 모든 항목의 현재 ACL, version, hash, token 합계를 다시 검증합니다. Coder의 Phase 16 approval context에는 조회 원문 대신 Phase 18 manifest hash만 결합합니다.

```sh
npm run phase18 -- replay memory-manifest-...
npm run phase18 -- shadow-quality
```

기본 shadow 품질 기준은 다섯 worker 역할 모두에서 1건 이상, 전체 5건 이상, fallback 0건이며 각 역할이 실제 Long/Episodic 항목을 하나 이상 선택해야 합니다. Short task 요청만으로는 enforced 조건을 통과하지 않습니다. 실제 역할 실행에서는 Short memory로 현재 task 요청을 넣고 Long/Episodic candidate를 hybrid rerank한 뒤 역할별 token budget 안에서 선택합니다.

## 롤백

먼저 여섯 역할 프로필을 모두 `TIERED_MEMORY_MODE=off`로 바꾸고 supervisor를 재기동합니다. 기존 Phase 17 workflow는 memory plane 없이 계속 처리할 수 있습니다.

```sh
npm run phase18 -- rollback --allow-destructive --confirm-phase18
```

rollback은 Phase 18 table, 함수, trigger, `tasks.memory_project_key`만 제거하며 Phase 15~17 delivery/workflow/workspace 자료는 보존합니다. 자세한 순서는 `docs/phase18/rollback-plan.md`를 따릅니다.
