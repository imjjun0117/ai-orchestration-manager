# AI Manager 리팩터링 계획서

작성일: 2026-07-09
대상: 현재 `bot.js` 기반 반자동(!task) 파이프라인
목표: PM 오케스트레이션 기반 자동 파이프라인 + 세션 재개 + 역할-어댑터 분리 + 병목 대응

---

## 0. 배경 — 기존 구조에서 바뀌는 것

기존 구조(legacy `!task`)는 매 단계(`PENDING_PLAN_APPROVAL` → `PENDING_CODEX_APPROVAL` →
`PENDING_GEMINI_APPROVAL` → `PENDING_COMMIT_APPROVAL`)마다 사람이 `!approve`를 입력해야
다음 단계로 넘어갔다. 이번 리팩터링의 핵심은 다음 5가지다.

1. **PM 오케스트레이션**: 사람의 중간 승인을 없애고, PM 에이전트가 계획 수립 이후의
   진행 판단(재수정/다음 단계 진행)을 대신한다. 사람은 작업 시작과 최종 승인/거절
   시점에만 개입한다.
2. **세션 개념**: `!end`로 진행 중인 작업을 일시중지 요청하고 task ID를 받아, 나중에
   `!resume <TASK-ID>`로 전체 대화 이력을 복원해 이어서 진행할 수 있다.
3. **에이전트 간 대화 가시성**: 승인 게이트가 사라진 만큼, 자동 실행 루프 안에서
   에이전트들이 주고받는 내용을 실시간으로 볼 수 있어야 한다 (task별 스레드 중계 +
   `!log` 조회 명령). **→ 사용자가 명시적으로 가장 중요하다고 지정한 요구사항.
   PM 판단 로직을 얼마나 정교하게 짜든, 에이전트끼리 뭘 주고받는지 안 보이면 그
   과정을 신뢰할 수 없다는 게 핵심 이유. PM 오케스트레이션 구현과 동시에
   만들어야 하는 항목이지, 나중에 얹는 부가기능이 아니다.**
4. **병목 대응**: CLI 자식 프로세스가 응답 없이 멈추는 문제(기존 결함, 07-07 16:24
   로그에서 7시간 무응답 확인됨, 미수정 상태)에 타임아웃/워치독/강제종료 명령을 추가한다.
5. **역할-어댑터 분리**: `askClaude`/`askCodex`처럼 CLI 이름이 파이프라인 로직에
   하드코딩된 구조를 없애고, "역할(pm/coder/reviewer/qa/summarizer)"과 "실제 CLI
   어댑터"를 분리해 런타임에 교체 가능하게 한다.

이와 별개로, 기존 스펙 문서에서 발견된 정리가 필요한 부분은 10장에 별도로 남겨둔다
(죽은 코드, git 관련 문구 모순 등).

---

## 1. 새 태스크 상태머신

```
RECEIVED                 (!task 입력 직후)
  ↓ (자동, PM 트리거)
PM_PLANNING               PM이 작업을 분해하고 역할별 에이전트에 배정
  ↓ (자동)
AUTONOMOUS_EXECUTION       coder ↔ reviewer ↔ qa 반복. PM이 매 라운드 결과를 보고
  │                        "재수정" / "다음 단계" / "완료"를 스스로 판단
  │
  ├─ (PM이 막힘/판단불가 감지) → PM_ESCALATION   사람에게 알림, 사람이 직접 지시
  │                                    ↓ (사람 지시 후)
  │                              AUTONOMOUS_EXECUTION 복귀
  │
  ├─ (사용자가 !end) → 현재 단계 종료 후 PAUSED  task ID 반환, paused_from_status 저장
  │                        ↓ (!resume <TASK-ID>)
  │                  paused_from_status로 복귀 (대부분 AUTONOMOUS_EXECUTION)
  │
  ↓ (PM이 "완료" 판단)
PENDING_FINAL_APPROVAL     사람이 유일하게 개입하는 승인 지점
  ├─ !approve → git add+commit → DONE
  └─ !reject  → git.discardChanges() → REJECTED (실패 시 ROLLBACK_FAILED, 기존과 동일)
```

기존 유지 규칙:
- `MAX_REVISION_ROUNDS` 상한 그대로 유지 (PM 판단 루프에도 동일 적용)
- 채널당 동시 1개 활성 task 가드(`hasAnyActiveTask`) 유지, 단 **`PAUSED` 상태는
  비활성으로 취급**하도록 조건 수정 (그래야 `!end` 후 다른 작업 시작 가능)
- `approvals` 테이블의 원자적 조건부 UPDATE(중복 `!approve` 방지)는 그대로 사용한다.
  새 자동 파이프라인은 `final_approval`을 쓰고, legacy `PENDING_COMMIT_APPROVAL` 경로의
  `commit_approval`은 Phase 10 전환 완료 전까지 유지한다.

---

## 2. DB 마이그레이션 목록

### 2.1 `tasks` 테이블 ALTER

```sql
ALTER TABLE tasks
  ADD COLUMN paused_at             TIMESTAMPTZ,
  ADD COLUMN paused_from_status    TEXT,
  ADD COLUMN discord_thread_id     TEXT,
  ADD COLUMN current_pid           INTEGER,
  ADD COLUMN role_overrides        JSONB;         -- v1에서는 미사용, 확장 포인트로만 컬럼 선점
```

- `paused_from_status`: `!end` 시점의 원래 상태 저장 (`AUTONOMOUS_EXECUTION` 등)
- `discord_thread_id`: task 생성 시 연 스레드 ID. `!log`/`!resume`/프로세스 재시작 후에도
  재조회 없이 바로 참조
- `current_pid`: 현재 실행 중인 CLI 자식 프로세스 PID. `!kill` 명령이 이 값을 사용
- `role_overrides`: v2 확장 포인트. task 단위로 전역 역할 바인딩을 덮어쓸 때 사용
  (지금은 컬럼만 추가하고 로직은 구현하지 않음)

### 2.2 신규 테이블 `role_bindings`

```sql
CREATE TABLE role_bindings (
  role         TEXT PRIMARY KEY,     -- 'pm' | 'coder' | 'reviewer' | 'qa' | 'summarizer'
  agent_name   TEXT NOT NULL,        -- 'claude' | 'codex' | 'gemini' | 'gemma'
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

-- 초기 시드 (기존 구조와 동일하게 시작)
INSERT INTO role_bindings (role, agent_name) VALUES
  ('pm', 'claude'),
  ('coder', 'codex'),
  ('reviewer', 'gemini'),
  ('qa', 'codex'),
  ('summarizer', 'gemma');
```

전용 테이블로 만드는 이유: `bot_settings`는 자유 KV라 "역할별로 정확히 하나씩만
존재해야 한다"는 제약을 보장 못 함. PK로 무결성을 강제.

### 2.3 `command_logs` ALTER (병목 진단용)

```sql
ALTER TABLE command_logs
  ADD COLUMN duration_ms   INTEGER,
  ADD COLUMN timed_out     BOOLEAN DEFAULT FALSE,
  ADD COLUMN killed        BOOLEAN DEFAULT FALSE;
```

### 2.4 `messages.role` 값 확장 (컬럼 타입 변경 없음, 자유 문자열이라 코드 규약만 추가)

자동 실행 루프 중 매 라운드마다 반드시 INSERT할 `role` 값:
- `pm` — PM의 지시/판단 텍스트
- `coder`, `reviewer`, `qa`, `summarizer` — 역할 기준 (CLI 이름이 아니라 역할명으로
  저장해야, 나중에 역할-어댑터 바인딩이 바뀌어도 과거 로그의 의미가 유지됨)

---

## 3. 역할-어댑터 분리

### 3.1 공통 어댑터 인터페이스

기존 `agents/*.js` (실사용) 와 `src/adapters/*Cli.js` (부분 연결) 이중 구현을
아래 인터페이스로 통일한다. 통일 안 하면 역할 교체 자체가 불가능하므로 이번
작업의 선결 과제다.

```js
// src/adapters/AgentAdapter.js
// 모든 CLI 어댑터(claude/codex/gemini/gemma)는 이 형태를 따른다
module.exports = {
  name: 'codex', // 'claude' | 'codex' | 'gemini' | 'gemma'
  capabilities: {
    canExec: true,       // 실제 코드 실행/수정 가능한가
    canReview: true,     // 코드 리뷰 가능한가
    canPlan: false,      // 계획 수립 가능한가
    canSummarize: false, // 요약 가능한가
  },
  async invoke(prompt, opts) {
    // opts: { taskId, timeoutMs, workspaceDir, role }
    // return: { text, raw, exitCode, timedOut, killed, durationMs }
  },
};
```

### 3.2 역할 → 어댑터 조회

```js
// src/core/roleResolver.js
async function resolveAgent(role) {
  const binding = await db.query(
    'SELECT agent_name FROM role_bindings WHERE role = $1', [role]
  );
  const adapter = require(`../adapters/${binding.agent_name}Adapter`);
  if (!adapter.capabilities[capabilityForRole(role)]) {
    throw new Error(
      `${binding.agent_name}는 ${role} 역할에 필요한 기능(${capabilityForRole(role)})을 지원하지 않음`
    );
  }
  return adapter;
}
```

`capabilityForRole`: `coder→canExec`, `reviewer→canReview`, `pm→canPlan`,
`summarizer→canSummarize`. **바인딩 변경 시점(`!set-role`)에도 동일 체크를 돌려서
지원 안 하는 조합은 아예 저장을 막는다** — 파이프라인 중간에 조용히 실패하는 것보다
설정 시점에 막는 게 안전하다.

### 3.3 명령어

| 명령어 | 동작 |
|---|---|
| `!roles` | 현재 역할↔에이전트 매핑 전체 표시 |
| `!set-role <role> <agent>` | 매핑 변경. capability 체크 실패 시 거부하고 이유 출력 |

### 3.4 역할 기반 단발 호출 명령

기존 CLI 이름 기반 명령(`!claude`, `!codex`, `!gemini`, `!gemma`)은 당분간 호환을 위해
유지하되, 새 구조에서는 역할명 기반 명령을 1차 사용 방식으로 제공한다. 예를 들어
현재 `reviewer -> gemini`로 바인딩돼 있으면 `!reviewer 리뷰해줘`는 Gemini를 호출하고,
나중에 `!set-role reviewer claude`로 바꾸면 같은 `!reviewer` 명령이 Claude를 호출한다.

| 명령어 | 동작 |
|---|---|
| `!pm <prompt>` | 현재 `pm` role에 바인딩된 agent 호출 |
| `!planner <prompt>` | `!pm` alias |
| `!coder <prompt>` | 현재 `coder` role에 바인딩된 agent 호출 |
| `!reviewer <prompt>` | 현재 `reviewer` role에 바인딩된 agent 호출 |
| `!qa <prompt>` | 현재 `qa` role에 바인딩된 agent 호출 |
| `!summarizer <prompt>` | 현재 `summarizer` role에 바인딩된 agent 호출 |

동작 원칙:
- roleResolver로 현재 role binding을 조회한다.
- 호출 직전에도 adapter capability를 재확인한다.
- 기존 일회성 명령과 동일하게 worker queue를 탄다.
- 진행 메시지(`message.reply`)도 queue job 안에서 보내 queue 선점 순서를 보존한다.
- 코드 변경 가능성이 있는 role에는 `captureGitSnapshot`/`warnIfUnapprovedGitChange`를
  적용한다.
  - 최소 `coder`는 필수.
  - `pm`, `reviewer`, `qa`는 바인딩된 adapter의 `capabilities.canExec`가 true이면 적용한다.
  - `summarizer`는 기본적으로 읽기 전용이므로 canExec가 false이면 제외한다.
- 기존 `!claude`, `!codex`, `!gemini`, `!gemma`는 deprecated compatibility alias로
  남기고, `help`에서는 역할 기반 명령을 우선 안내한다.

### 3.5 스킬 시스템과의 연동

`skills` 테이블의 `agent_type` 컬럼과 `contextBuilder.buildSkillGuidance()`가
CLI 이름(`codex`, `gemini` 등)을 직접 참조하고 있다면 **역할명(`coder`, `reviewer`
등) 기준으로 변경**해야 한다. CLI가 바뀌어도 스킬 정책(`allowed_commands`/
`blocked_commands`)은 "그 역할에 적용되는 정책"으로 유지되어야 하기 때문.

주의: `commandGuard.js`의 런처 allowlist(`claude -p`, `codex --ask-for-approval
never exec` 등)는 CLI 도구 자체의 보안 정책이므로 역할 개념과 무관하게 어댑터별로
그대로 유지한다. 여기 역할 개념을 섞으면 보안 경계가 흐려진다.

---

## 4. PM 오케스트레이션 로직

### 4.1 PM이 대신 내리는 판단

기존에 `!approve` 핸들러 안에 있던 분기 로직(재수정 vs 다음 단계 vs 완료)을
PM 판단 함수로 이동한다.

```
PM_PLANNING:
  입력: 사용자 원 지시
  출력: 작업 분해 계획, 각 하위 작업에 role 배정
  → coder 역할 호출

AUTONOMOUS_EXECUTION 루프 (매 라운드):
  coder 결과 수신 → reviewer 역할에 전달
  reviewer 결과 수신 → PM 판단:
    - "이슈 있음, 수정 필요" → coder 재호출 (round+1, MAX_REVISION_ROUNDS 체크)
    - "이슈 없음, 통과" → qa 역할 호출
  qa 결과 수신 → PM 판단:
    - 테스트 실패 → coder 재호출 (재수정)
    - 테스트 통과/없음 → summarizer 역할 호출 → PENDING_FINAL_APPROVAL로 전환
```

### 4.2 에스컬레이션 조건 (`PM_ESCALATION`)

다음 중 하나라도 해당하면 PM은 스스로 판단하지 않고 사람에게 넘긴다:
- `MAX_REVISION_ROUNDS` 도달
- 동일 에이전트 2회 연속 타임아웃/실패 (6절 참고)
- reviewer/qa 결과가 서로 모순되거나 PM이 출력 형식을 파싱하지 못한 경우

에스컬레이션 시 스레드 + 메인 채널에 사람 멘션 알림을 보내고, 사람의 자유 텍스트
지시를 받아 `AUTONOMOUS_EXECUTION`으로 복귀한다.

---

## 5. 세션 재개 (`!end` / `!resume`)

CLI 에이전트 호출은 매번 stateless이므로 "기억"은 DB에서 히스토리를 다시 읽어
프롬프트 컨텍스트로 재구성하는 방식으로 구현한다.

### 5.1 `!end`

1. 현재 실행 중인 CLI 호출이 없다면 즉시 `status = PAUSED`, `paused_from_status`에 원래 상태 저장
2. 현재 실행 중인 CLI 호출이 있다면 즉시 child process를 끊지 않고, 다음 안전 체크포인트에서
   `PAUSED`로 전환하도록 pause request를 남긴다
3. `paused_at = now()`는 실제로 `PAUSED` 전환되는 시점에 기록
4. task ID를 사람에게 반환 (예: `TASK-20260709-0001 일시중지를 요청했습니다. 나중에 !resume TASK-20260709-0001로 재개할 수 있습니다.`)
5. `hasAnyActiveTask` 체크에서 `PAUSED`는 비활성으로 취급하도록 쿼리 조건 수정

주의: `!end`는 kill 명령이 아니다. 실행 중인 CLI를 즉시 중단해야 하는 경우는 `!kill <TASK-ID>`를
사용한다. `status`만 먼저 `PAUSED`로 바꿔서 실행 중인 child process가 없는 것처럼 보이게
만들면 안 된다.

### 5.2 `!resume <TASK-ID>`

1. `tasks`에서 해당 row 로드, `paused_from_status` 확인
2. `messages`를 `created_at` 순 전체 로드
   - 20개 초과 시 기존 `task_summaries`의 rolling summary + 그 이후 메시지만 사용
     (기존 20개 초과 요약 메커니즘 그대로 재활용)
3. `agent_results`에서 `result_type`별 최신 것(plan/code_diff/review/qa_report) 조회
4. 채널(또는 기존 `discord_thread_id` 스레드)에 요약 출력:
   "이 태스크는 X 단계에서 멈췄고, 지금까지 이런 일이 있었습니다: ..."
5. `status`를 `paused_from_status`로 복원하고 그 지점부터 파이프라인 재개

---

## 6. 에이전트 대화 가시성

### 6.1 task별 Discord 스레드

자동 파이프라인 task 시작 시 PM이 자동으로 스레드를 열고 (`tasks.discord_thread_id`에 저장),
자동 실행 루프의 모든 라운드를 이 스레드 안에서 중계한다. 메인 채널에는
`PENDING_FINAL_APPROVAL` 전환 시점에만 멘션 알림을 보낸다.

각 에이전트 호출 시 스레드에 시작/완료 마커를 남긴다 (6.2 병목 대응과 연동):
```
Codex 구현 시작 (14:32)
Codex 구현 완료 (14:38, 6분 소요)
```

긴 diff/리뷰는 Discord 2000자 제한을 고려해 짧으면 인라인 코드블록, 길면 파일
첨부(`.diff`/`.md`)로 자동 분기 (`src/discord`의 기존 포맷 헬퍼 확장).

### 6.2 `!log <TASK-ID>`

`messages` 테이블에서 해당 task의 전체 대화를 시간순으로 다시 뽑아 채널에 출력.
`!resume`이 사용하는 히스토리 재구성 로직(5.2의 1~3단계)을 그대로 재사용하되,
PM 프롬프트에 넣는 대신 사람이 읽기 좋은 포맷으로 출력한다는 점만 다르다.

---

## 7. 병목 대응

### 7.1 근본 수정 — `services/shell.js`

```
1. 에이전트별 타임아웃 (env로 분리)
   CODEX_TIMEOUT_MS, GEMINI_TIMEOUT_MS, CLAUDE_TIMEOUT_MS, GEMMA_TIMEOUT_MS
2. 타임아웃 도달 시 SIGTERM 전송
3. 유예시간(5초) 후에도 살아있으면 SIGKILL
4. Promise는 반드시 reject (큐가 다음 작업으로 진행 가능하도록)
5. command_logs에 duration_ms, timed_out, killed 기록
```

**이 항목이 최우선순위다.** 나머지 안전장치는 이게 없으면 증상 완화에 불과하다.

### 7.2 큐 레벨 워치독

`worker.js`에 개별 타임아웃과 별개로, "현재 작업이 예상 최대 시간(개별 타임아웃의
2배)을 넘겼는데 `isRunning`이 안 풀렸다"를 주기적으로 체크하는 워치독을 추가한다.
7.1의 타임아웃 로직이 놓칠 수 있는 엣지케이스(좀비 프로세스 등)에 대한 이중 안전장치.

### 7.3 `!kill <TASK-ID>`

- `tasks.current_pid`에 저장된 PID에 SIGKILL
- 해당 child process가 종료되며 현재 adapter invocation이 reject/return되도록 연결
- task 상태를 직전 상태로 롤백하거나 `PM_ESCALATION`으로 전환

주의: `!kill`은 worker의 `isRunning` 플래그를 직접 강제 해제하지 않는다. 플래그만 풀면
아직 종료되지 않은 job과 다음 job이 동시에 같은 워크스페이스를 만질 수 있다. 반드시
child process 종료 → runCommand 종료 → worker job 종료 흐름으로 queue가 풀려야 한다.

### 7.4 자동 재시도 + 에스컬레이션 상한

타임아웃 발생 시 1회는 백오프 후 자동 재시도. 재시도 후에도 또 실패하면
`PM_ESCALATION`으로 전환하고 사람 멘션 알림 ("Codex가 2회 연속 응답 없음, 확인 필요").

---

## 8. 구현 Phase 계획 (보강판)

이번 리팩터링은 기존 `!task`/`!approve` 파이프라인을 한 번에 갈아엎지 않는다.
현행 파이프라인은 이미 queue, approval 원자성, git diff 원자성, QA, skill discovery가
촘촘히 맞물려 있으므로, 새 자동 파이프라인은 **기존 명령과 병행하는 방식**으로 먼저
구현하고 충분히 검증한 뒤 `!task` 기본 동작으로 승격한다.

핵심 원칙:
- 기존 `!task`/`!approve`/`!reject`는 Phase 4가 끝날 때까지 기능 변경하지 않는다.
- 새 자동 파이프라인은 처음에는 `!autotask` 같은 별도 명령으로 노출한다.
- 각 Phase는 `schema.sql`과 실행 중 DB 컨테이너를 함께 갱신하고, 신규 환경에서
  `docker compose down -v && docker compose up -d` 후 동일 스키마가 만들어지는지 확인한다.
- Phase별 검증이 끝나기 전 다음 Phase로 넘어가지 않는다.

### Phase 0 — 기준선 고정 및 테스트 하네스 정리

목표: 리팩터링 전 현재 동작을 재현 가능한 기준선으로 고정한다.

작업:
- 전체 `*.js` 문법 검사 스크립트 정리.
- 기존 smoke를 문서화한다:
  - `!dbtask -> QA_DONE`
  - `!task -> !approve` 기존 승인 파이프라인
  - approvalService 20-way 동시성
  - pathGuard/commandGuard 회귀
  - ContextBuilder 20개 임계값
  - qaAgent skip/fail/ENOENT 분류
- 임시 테스트 파일(`temp_*`)이 필요하면 `.gitignore`에 명시하고, 새 테스트는 가능하면
  `scripts/` 또는 `test/` 아래로 이동한다.

완료 기준:
- 현재 기능 기준선 로그가 남아 있고, 이후 Phase 검증 프롬프트에서 재사용 가능해야 한다.
- 코드 동작 변경 없음.

### Phase 1 — shell timeout/kill 기반 안정화

목표: CLI 자식 프로세스가 멈춰 queue 전체가 정지하는 문제를 먼저 해결한다.

작업:
- `services/shell.js`에 timeout 옵션 추가.
  - `timeoutMs`를 명시적으로 받을 수 있게 하고, 없으면 agent별 env 기본값 사용:
    `CODEX_TIMEOUT_MS`, `GEMINI_TIMEOUT_MS`, `CLAUDE_TIMEOUT_MS`, `GEMMA_TIMEOUT_MS`,
    공통 fallback `AGENT_TIMEOUT_MS`.
  - timeout 도달 시 `SIGTERM`, 5초 유예 후 생존 시 `SIGKILL`.
  - Promise는 반드시 resolve/reject로 종료되어 worker가 다음 job으로 진행해야 한다.
- `command_logs`에 `duration_ms`, `timed_out`, `killed` 컬럼 추가.
- spawn 성공/실패/timeout/kill 모두 command_logs에 기록한다.
- 기존 reject 형태와 호출부 호환성을 유지한다.
  - commandGuard 차단: plain `Error`
  - spawn/exit/timeout: `{ error, stdout, stderr, timedOut?, killed?, durationMs? }`
- 현재 실행 중인 child PID를 상위에서 추적할 수 있도록 `runCommand` 옵션에
  `onSpawn(child)` 콜백을 추가한다. 이 단계에서는 `tasks.current_pid`에 아직 연결하지 않는다.

금지:
- 이 Phase에서 PM 오케스트레이션이나 상태머신을 건드리지 않는다.
- worker의 `isRunning`을 외부에서 강제로 바꾸는 API를 만들지 않는다.

검증:
- 정상 명령 성공.
- non-zero exit 실패.
- commandGuard 차단.
- `node -e "setTimeout(()=>{}, 60000)"` 같은 장기 실행 명령 timeout.
- SIGTERM 후 종료되는 케이스와 SIGKILL까지 가는 케이스.
- timeout 후 다음 queue job이 실행되는지 확인.
- command_logs의 `duration_ms/timed_out/killed` 값 확인.

### Phase 2 — DB 스키마 확장과 활성 상태 정의

목표: 새 상태머신/세션/kill/role binding을 담을 DB 기반을 만든다.

작업:
- `tasks` ALTER:
  - `paused_at TIMESTAMPTZ`
  - `paused_from_status TEXT`
  - `discord_thread_id TEXT`
  - `current_pid INTEGER`
  - `role_overrides JSONB`
- `role_bindings` 테이블 생성 및 seed:
  - `pm -> claude`
  - `coder -> codex`
  - `reviewer -> gemini`
  - `qa -> codex`
  - `summarizer -> gemma`
- `taskService`에 `ACTIVE_STATUSES` 개념 추가.
  - 기존 `status LIKE 'PENDING_%'` 의존을 제거한다.
  - 활성 상태 예:
    `RECEIVED`, `PM_PLANNING`, `AUTONOMOUS_EXECUTION`, `PM_ESCALATION`,
    `PENDING_FINAL_APPROVAL`, 기존 `PENDING_%`.
  - `PAUSED`, `DONE`, `REJECTED`, `CANCELLED`, `ROLLBACK_FAILED`, `QA_DONE`은 비활성.
- `hasAnyActiveTask()`와 `getActiveTaskForChannel()`를 새 active status 기준으로 수정.
- `schema.sql`과 실행 중 DB 컨테이너를 반드시 동기화한다.

금지:
- 아직 `!task` 상태 전이를 새 상태로 바꾸지 않는다.

검증:
- 신규 DB에서 schema.sql만으로 모든 컬럼/테이블/index/seed가 생성되는지 확인.
- 기존 `!task`/`!approve`가 기존 PENDING 상태 기준으로 계속 작동하는지 확인.
- `PAUSED` task가 active task로 잡히지 않는지 unit/integration 확인.

### Phase 3 — 공통 AgentAdapter 인터페이스 통일

목표: CLI 이름과 역할을 분리하기 위한 실행 계층을 만든다.

작업:
- `src/adapters/*Adapter.js` 형태로 통일한다.
  - `claudeAdapter.js`
  - `codexAdapter.js`
  - `geminiAdapter.js`
  - `gemmaAdapter.js`
- 모든 adapter는 아래 인터페이스를 따른다:

```js
module.exports = {
  name: "codex",
  capabilities: {
    canExec: true,
    canReview: true,
    canPlan: false,
    canSummarize: false,
  },
  async invoke(prompt, opts) {
    // opts: { taskId, timeoutMs, workspaceDir, role, onSpawn }
    // return: { text, raw, exitCode, timedOut, killed, durationMs }
  },
};
```

- 기존 `agents/*.js`는 바로 삭제하지 않고 adapter 내부에서 감싼다.
- 기존 `src/adapters/*Cli.js`는 새 adapter로 대체하거나 compatibility wrapper로 남긴다.
- error를 throw할지 `{exitCode:1}`로 반환할지 하나로 통일한다.
  - 권장: adapter는 예외를 삼키고 `{exitCode:1, text:"", raw, ...}` 반환.
  - 단, 프로그래밍 오류(잘못된 opts 등)는 throw 허용.

금지:
- `bot.js` 전체를 이 단계에서 전환하지 않는다.
- commandGuard의 런처 allowlist 정책을 role 개념과 섞지 않는다.

검증:
- 4개 adapter가 동일 shape를 반환하는지 mock으로 확인.
- timeout/timedOut/killed가 adapter 결과에 보존되는지 확인.
- 기존 `agents/*.js` 경유 명령의 commandGuard/pathGuard 회귀 확인.

### Phase 4 — roleResolver와 역할 설정 명령

목표: role -> agent binding을 DB에서 조회하고 capability 검증으로 잘못된 조합을 막는다.
또한 `!reviewer`처럼 CLI 이름이 아니라 역할명으로 단발 호출할 수 있게 한다.

작업:
- `src/core/roleResolver.js` 추가.
  - `resolveAgent(role)`
  - `setRoleBinding(role, agentName, updatedBy)`
  - `listRoleBindings()`
  - `capabilityForRole(role)`
- `!roles` 명령 추가.
- `!set-role <role> <agent>` 명령 추가.
- 저장 시점과 실행 시점 모두 capability 체크.
- `role_overrides`는 이 Phase에서 구현하지 않고 컬럼만 유지한다.
- 역할 기반 단발 호출 명령 추가:
  - `!pm <prompt>`
  - `!planner <prompt>` (`!pm` alias)
  - `!coder <prompt>`
  - `!reviewer <prompt>`
  - `!qa <prompt>`
  - `!summarizer <prompt>`
- 기존 CLI명 기반 단발 호출 명령은 호환 alias로 유지:
  - `!claude`, `!codex`, `!gemini`, `!gemma`
- 역할 기반 단발 호출은 공통 helper로 처리한다.
  - `runRoleCommand(role, prompt, message)` 같은 형태 권장.
  - roleResolver -> adapter.invoke -> memory 저장/응답 전송 순서.
  - worker queue를 반드시 탄다.
  - 진행 메시지는 queue job 안에서 보낸다.
  - adapter `capabilities.canExec === true`이면 git snapshot 경고를 적용한다.

검증:
- 기본 seed 조회.
- 유효한 변경 성공.
- capability 안 맞는 변경 거부.
- 존재하지 않는 role/agent 거부.
- `!reviewer`가 기본 설정에서 Gemini adapter를 호출하는지 확인.
- `!set-role reviewer claude` 후 `!reviewer`가 Claude adapter를 호출하는지 mock으로 확인.
- capability가 맞지 않는 role command는 실행 전에 거부되는지 확인.
- `!coder`처럼 canExec role은 `captureGitSnapshot`/`warnIfUnapprovedGitChange`가 적용되는지 확인.
- `!summarizer`처럼 canExec=false role은 불필요한 git 경고를 내지 않는지 확인.
- 기존 파이프라인 영향 없음.

### Phase 5 — task thread와 대화 로그 가시성

목표: 자동 파이프라인을 만들기 전에 task별 대화 중계/조회 기반을 만든다.

작업:
- task 생성 시 Discord thread 생성 helper 추가.
  - thread 생성 성공 시 `tasks.discord_thread_id` 저장.
  - 실패 시 기존 채널 fallback. 이 경우 `discord_thread_id = null` 허용.
- `src/core/taskLogService.js` 또는 유사 모듈 추가.
  - `appendTaskMessage(task, { role, authorName, content, channelId })`
  - DB `messages` 저장 + thread/fallback 채널 전송을 함께 처리.
- `!log <TASK-ID>` 추가.
  - DB messages 전체를 시간순으로 출력.
  - 길면 파일 첨부 또는 기존 `sendLongMessage` 정책 재사용.
- PM/coder/reviewer/qa/summarizer role명을 messages.role에 저장하는 규약 확정.

금지:
- 아직 PM 자동 루프를 구현하지 않는다.

검증:
- thread 생성 성공/실패 fallback.
- `!log TASK-ID`가 전체 대화를 복원.
- 기존 `!log` 최근 app.log 명령과 이름 충돌 처리 필요:
  - 권장: 기존 app log는 `!app-log`로 별칭 추가하고, `!log`는 인자가 없으면 기존 동작,
    인자가 있으면 task log로 동작.

### Phase 6 — 병행 자동 파이프라인 `!autotask`

목표: 기존 `!task`를 건드리지 않고 PM 오케스트레이션을 별도 명령으로 구현한다.

상태 흐름:

```
RECEIVED
PM_PLANNING
AUTONOMOUS_EXECUTION
PM_ESCALATION
PENDING_FINAL_APPROVAL
DONE / REJECTED / ROLLBACK_FAILED
```

작업:
- `src/core/pmOrchestrator.js` 추가.
- `!autotask 작업 내용` 추가.
- PM planning:
  - roleResolver로 `pm` adapter 호출.
  - 계획을 `messages(role='pm')`, `agent_results(result_type='plan')`에 저장.
- 자동 실행 루프:
  - coder -> reviewer -> PM 판단 -> qa -> summarizer.
  - 매 호출 시작/완료를 thread에 중계.
  - `MAX_REVISION_ROUNDS` 유지.
  - reviewer/qa 결과가 실패하면 coder 재호출.
  - QA skip은 실패로 보지 않는다.
- 완료 판단 시 `PENDING_FINAL_APPROVAL`로 전환하고 `approvalService.openApproval(task.id, "final_approval", "pm")`.
- 메인 채널에 최종 승인 요청 알림.

PM 판단 출력:
- 자연어만 믿지 말고 JSON block 또는 명확한 schema를 요구한다.
- parse 실패 시 `PM_ESCALATION`.

금지:
- 기존 `!approve`의 legacy PENDING_* 분기를 제거하지 않는다.
- 이 Phase에서 `!task` 기본 동작을 바꾸지 않는다.

검증:
- mock adapter로 성공 경로가 `PENDING_FINAL_APPROVAL`까지 도달.
- reviewer revise -> coder 재호출.
- QA fail -> coder 재호출.
- MAX_REVISION_ROUNDS 도달 시 `PM_ESCALATION`.
- adapter timeout 2회 연속 시 `PM_ESCALATION`.
- thread/messages/agent_results에 모든 단계가 남는지 확인.

### Phase 7 — 최종 승인/거절 연결

목표: 자동 파이프라인의 유일한 사람 승인 지점을 구현한다.

작업:
- `!approve`가 `PENDING_FINAL_APPROVAL` task도 처리하도록 확장.
  - `approvalService.resolveLatest(... final_approval ...)`
  - `git.addAndCommit`
  - `DONE`
  - skillDiscovery는 기존 커밋 후 hook을 재사용하되 자동 파이프라인 task에도 동작하게 한다.
- `!reject`가 `PENDING_FINAL_APPROVAL` task를 처리하도록 확장.
  - 승인 획득 후 `git.discardChanges`
  - 성공: `REJECTED`
  - 실패: `ROLLBACK_FAILED`
- 기존 `PENDING_COMMIT_APPROVAL` legacy 경로는 유지한다.

검증:
- 동시에 `!approve` 20개 -> 1개만 성공.
- 동시에 `!reject` 20개 -> 1개만 rollback 실행.
- rollback 실패 시 `ROLLBACK_FAILED`.
- 기존 legacy `PENDING_COMMIT_APPROVAL` 경로 회귀 없음.

### Phase 8 — `!end` / `!resume`

목표: 자동 파이프라인 세션을 중단/재개한다.

중요 결정:
- `!end`는 이미 실행 중인 CLI를 즉시 kill하지 않는다.
- 기본 동작은 "현재 adapter 호출이 끝난 뒤 다음 체크포인트에서 PAUSED로 전환"이다.
- 즉시 중단이 필요하면 `!kill <TASK-ID>`를 사용한다.

작업:
- `tasks`에 pause_requested 같은 컬럼이 필요하면 이 Phase에서 추가 검토.
  - 단순 `PAUSED` 전환만으로 실행 중 child를 멈춘 것처럼 보이게 만들면 안 된다.
- `!end`
  - active task에 pause request 표시.
  - 현재 실행 중이 아니면 즉시 `PAUSED`, `paused_from_status`, `paused_at` 저장.
  - 실행 중이면 thread에 "현재 단계 종료 후 일시중지 예정" 안내.
- orchestrator 체크포인트마다 pause request를 확인하고 `PAUSED` 전환.
- `!resume <TASK-ID>`
  - `PAUSED` task만 허용.
  - messages + summaries + agent_results 최신 결과로 context 복원.
  - `paused_from_status`로 복귀 후 orchestrator 재시작.

검증:
- 실행 전 pause.
- 실행 중 pause request 후 다음 체크포인트에서 pause.
- resume 후 중복 실행 없이 이어서 진행.
- `PAUSED` 상태에서는 새 task 시작 가능.

### Phase 9 — 워치독, `!kill`, 재시도/에스컬레이션

목표: Phase 1 timeout 외의 운영 안전장치를 추가한다.

작업:
- `tasks.current_pid` 연결:
  - adapter invoke -> runCommand `onSpawn` -> taskService.updateTask(current_pid).
  - 종료 시 null 정리.
- worker watchdog 추가.
  - job 시작 시간/label/timeout budget 기록.
  - 오래 걸리는 job 감지 시 logger + task thread에 경고.
  - **watchdog은 `isRunning`을 강제 해제하지 않는다.**
- `!kill <TASK-ID>`
  - task.current_pid 조회.
  - PID에 SIGTERM/SIGKILL.
  - 해당 adapter invocation이 reject/return되도록 연결.
  - 상태는 `PM_ESCALATION` 또는 직전 안전 상태로 전환.
- 자동 재시도:
  - timeout/kill/adapter failure 연속 횟수 추적.
  - 1회 재시도.
  - 2회 연속 실패 시 `PM_ESCALATION`.

금지:
- worker 내부 플래그를 외부에서 강제 조작하지 않는다.

검증:
- kill 후 다음 queue job 진행.
- PID 정리.
- 존재하지 않는 PID 처리.
- 2회 timeout -> escalation.

### Phase 10 — 기본 명령 전환

목표: `!autotask`가 충분히 검증된 뒤 기존 `!task` 기본 동작을 새 자동 파이프라인으로
전환한다.

작업:
- `!task`를 자동 파이프라인으로 연결.
- legacy 파이프라인은 `!legacy-task`로 유지하거나 제거 여부 결정.
- help 문서 갱신.
  - `!reviewer`, `!coder` 같은 역할 기반 명령을 우선 안내.
  - `!gemini`, `!codex` 같은 CLI명 명령은 호환 alias/deprecated로 표시.
- 운영자가 원하면 bot_settings로 `task_mode = legacy|auto` 전환 가능하게 한다.

검증:
- `!task` 새 경로.
- `!legacy-task` 또는 legacy mode 회귀.
- 문서/help와 실제 명령 일치.

### Phase 11 — 죽은 코드 정리와 후속 확장 준비

목표: 자동 파이프라인 전환 후 혼란을 줄인다.

작업:
- `src/core/agentRouter.js`, `src/agents/plannerAgent.js`, `src/agents/reviewerAgent.js` 사용 여부 재평가.
- 실제 미사용이면 삭제하거나 파일 상단에 명확한 dead-code 경고 추가.
- 플랫폼 추상화와 npm 패키지화는 이 Phase에서도 구현하지 않고 별도 문서로 분리한다.

검증:
- `rg "require\\(.*agentRouter|plannerAgent|reviewerAgent"`로 실사용 여부 확인.
- 삭제 시 전체 문법/스모크 통과.

---

## 9. 향후 확장 항목 (지금은 미구현, 우선순위 낮음)

지금 당장 구현하진 않지만, 나중에 손댈 때 기존 설계와 충돌 없이 얹을 수 있도록
설계 시 유의할 점만 남겨둔다.

- **플랫폼 추상화**: 지금 Discord에 직접 의존하는 `src/discord/`(채널/스레드/포맷/
  명령 파싱)를 나중에 `PlatformAdapter` 인터페이스(3장의 `AgentAdapter`와 동일한
  패턴 — `start/sendMessage/createThread/mentionUser/onCommand` 등)로 감싸서
  카카오톡 등 다른 메신저로 교체·병행할 수 있게 만들 예정. 지금 코드를 짤 때 core
  로직(`taskService`/`worker`/`roleResolver`/PM 판단)에 discord.js 객체(Message,
  Channel 등)를 직접 넘기지 않고, 최소한의 순수 데이터(`{ channelId, userId, text }`)만
  주고받게만 해두면 나중에 어댑터로 감싸기 쉬워진다.
- **npm 설치형 패키지화**: `npm install -g` / `npx` 로 배포하는 CLI 도구 형태(예:
  `ai-manager init` / `ai-manager start`) — core와 플랫폼/에이전트 어댑터를 별도
  패키지로 쪼개는 구조. 지금은 로컬 경로 하드코딩(`WORKSPACE_DIR` 등)만 `.env`/
  `bot_settings` 기반으로 유지해두면 나중에 패키지화할 때 큰 재작업 없이 넘어갈 수 있다.

---

## 10. 기존 스펙 문서에서 발견된 별도 정리 항목 (이번 작업과 무관, 참고용)

- 1절 "Git 저장소는 없음"이라는 문구가 실제 `git add+commit`/`discardChanges`/
  `WORKSPACE_DIR`(git 저장소 경로) 사용과 모순됨. 문서 오기로 추정, 정정 필요.
- `src/core/agentRouter.js`, `src/agents/plannerAgent.js`, `src/agents/reviewerAgent.js`는
  어디서도 require되지 않는 죽은 코드. 이번 어댑터 통일 작업(3.1) 시 실제로 삭제하거나,
  삭제하지 않을 경우 파일 최상단에 `// DEAD CODE — NOT REQUIRED ANYWHERE, DO NOT EDIT`
  경고 주석 추가 권장 (다른 AI 에이전트가 이 파일을 실사용 코드로 오인해 수정하는 걸 방지).
- `src/core/manager.js`(`!dbtask` mock)는 이번 리팩터링 대상(`!task` 실제 파이프라인)과
  무관하므로 손대지 않음.
