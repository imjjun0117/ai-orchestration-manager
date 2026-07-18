# AI Manager Follow-up Notes

현재 승인된 구현들에서 남은 항목들은 치명적 블로커가 아니라 후속 개선 과제다.

## Phase 4: Queue

### 1. `!reject` 큐 적용

- 우선순위: Medium
- 현재 `approvalService.resolveLatest()`가 원자적으로 동작하므로 중복 reject/rollback 실행은 대부분 막혀 있다.
- 다만 `!reject`의 코드/리뷰/커밋 롤백 분기는 `git.discardChanges()`로 workspace에 직접 부작용을 만든다.
- 다른 queued agent 작업과 같은 workspace를 동시에 만질 가능성을 줄이려면 `!reject`도 queue job 안으로 넣는 편이 일관적이다.

### 2. `!run-codex` enqueue 전 DB await

- 우선순위: Low~Medium
- `!run-codex`는 active task guard 덕분에 기존 승인 파이프라인과의 큰 충돌은 막는다.
- 하지만 `taskService.getTask()` / `hasAnyActiveTask()` 같은 DB await가 `worker.enqueue()` 앞에 남아 있어, 완전 FIFO 선점 원칙에는 덜 엄밀하다.
- 추후 “모든 agent 실행 명령은 수신 순서대로 queue slot을 선점한다”는 정책을 강제하려면 이 부분도 queue 내부로 옮기는 것이 좋다.

### 3. Queue size / wait policy

- 우선순위: Low / 운영 설계 판단
- 현재 queue size 제한이 없어 요청이 많이 쌓이면 메모리 증가나 긴 대기 시간이 발생할 수 있다.
- 운영 사용자가 늘어나면 `MAX_QUEUE_SIZE`, 예상 대기 시간 안내, 오래된 작업 취소 정책을 추가하는 것이 좋다.

## Phase 5: AI 기반 스킬 자동 축적

### 1. Pending skill proposal 간 `skillId` 중복 방지

- 우선순위: Low~Medium
- 현재 `skillDiscovery.analyzeForSkillProposal()`은 DB에 이미 등록된 skill id와의 중복은 막는다.
- 하지만 아직 승인/반려되지 않은 `skill_creation` pending proposal들끼리 같은 `skillId`를 제안하는 경우까지는 막지 않는다.
- `findPendingProposalBySkillId()`는 같은 `skillId`가 여러 task에 동시에 pending 상태로 존재하면 최신 proposal 하나를 선택한다.
- 운영상 드문 케이스지만, 완전히 닫으려면 새 proposal 저장 전에 pending `skill_proposal`들을 조회해 동일 `skillId`가 이미 대기 중이면 `suitable:false` 또는 별도 suffix 재생성을 요구하는 정책이 필요하다.

## Current Approval Status

- `!approve` / `!skip` FIFO 선점 순서: 통과
- `finalizeAfterReview()` 중첩 enqueue 교착 방지: 통과
- 실패 catch rollback 이후 다음 queue job 시작: 통과
- 기존 diff 원자성: 통과
- AI 기반 스킬 자동 축적 경로 이탈 방어: 통과
- 커밋 성공 이후 스킬 분석 및 실패 격리: 통과
- `approve-skill` / `reject-skill` 원자성: 통과

현재 기준으로 Phase 4 Queue FIFO 수정과 Phase 5 AI 기반 스킬 자동 축적은 승인 가능하다.
