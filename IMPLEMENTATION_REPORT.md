# AI Manager 구현 보고서 (Phase 1~7)

**작성일:** 2026-07-08
**대상 문서:** `AI_Manager_Detailed_Implementation_Plan(1).md` (7단계 로드맵)
**요약:** 로드맵에 정의된 Phase 1~7 전체를 구현, 각 Phase마다 재검증 라운드를 거쳐 발견된 보안/동시성/상태머신 이슈를 수정 완료했다.

---

## 목차

1. [배경: 왜 이 작업이 시작됐는가](#1-배경)
2. [Phase 1 — DB + Discord 기본](#phase-1)
3. [Phase 2 — 보안 샌드박스](#phase-2)
4. [Phase 3 — 메모리 세션의 DB 완전 이관](#phase-3)
5. [Phase 4 — Queue 기반 비동기화](#phase-4)
6. [Phase 5 — Skill Registry & Context Builder](#phase-5)
7. [Phase 6 — CLI 어댑터 & 에이전트 순차 협업](#phase-6)
8. [Phase 7 — QA Agent 추가 및 종합 안정화](#phase-7)
9. [전체 아키텍처 요약](#9-전체-아키텍처-요약)
10. [DB 스키마 전체](#10-db-스키마-전체)
11. [알려진 잔여 이슈 (블로커 아님)](#11-알려진-잔여-이슈)
12. [검증 방법론](#12-검증-방법론)

---

## 1. 배경

이 프로젝트는 Discord 기반으로 로컬 AI 에이전트(Claude, Codex, Gemini/Antigravity, Gemma4)를 오케스트레이션하는 봇이다. 개발 착수 계기는 **Gemini가 사용자 승인 없이 별개 리포지토리(CMS)의 코드를 수정하고 커밋한 보안 사고**였다. 이 사고 분석에서 시작해, "에이전트는 절대 승인 없이 워크스페이스를 바꿀 수 없다"는 원칙을 전제로 7단계 로드맵을 순차 구현했다.

이 원칙은 이후 모든 Phase의 설계 판단 기준으로 계속 작용했다 — 특히 Phase 4(큐), Phase 7(QA 게이트)에서 "자동화 범위를 어디까지 넓힐 것인가"를 결정할 때마다, "테스트 실행처럼 읽기 전용/비파괴적인 자동화는 허용하되, 코드를 바꾸는 모든 단계는 반드시 사람의 `!approve`를 거친다"는 기준으로 되돌아갔다.

---

## Phase 1 — DB + Discord 기본 <a name="phase-1"></a>

**목표:** PostgreSQL Docker 구성, DB Schema, Discord `!dbtask`/`!dbstatus` 명령과 mock War-room 파이프라인.

**산출물:**
- `docker-compose.yml`, `src/db/schema.sql`, `src/db/index.js`
- `src/core/taskService.js`, `src/core/messageService.js`, `src/core/manager.js`
- `src/discord/commandHandler.js`, `src/discord/messageFormatter.js`
- Discord 명령: `!dbtask`, `!dbstatus`, `!skill-sync`(초기), `!skills`

이 Phase에서 확립된 `tasks`/`messages`/`command_logs`/`skills` 테이블이 이후 모든 Phase의 데이터 기반이 됐다.

---

## Phase 2 — 보안 샌드박스 <a name="phase-2"></a>

**목표:** 에이전트가 로컬 명령을 실행할 때 상위 디렉토리 이탈과 시스템 파괴 명령을 방어.

### 구현
- **`src/core/pathGuard.js`**
  - `assertInsideProjectRoot(targetPath, projectRoot)`: `fs.realpathSync` + `path.resolve`로 `../`와 symlink를 모두 해석한 뒤 PROJECT_ROOT 내부인지 검증. 통과 시 realpath 정규화 경로 반환.
  - `isSensitivePath(targetPath)`: `.env`, `.pem`, `.key`, `id_rsa`, `.ssh`, `.aws`, `.gcp`, `credentials` 등 basename 패턴 차단 (`.env.example`만 예외).
  - `looksLikePath(token, cwd)`: 공백 포함 경로("`link dir/passwd`")도 `/`가 있으면 경로로 인식하도록 설계 — 초기엔 공백 있으면 경로로 안 보는 휴리스틱이 있었으나, symlink 우회 재현 테스트에서 뚫리는 것을 발견해 제거.

- **`src/core/commandGuard.js`**
  - `BLOCKED_TOKEN_SEQUENCES`: `rm`, `sudo`, `chmod`, `chown`, `mv`, `cp`, `curl`, `wget`, `ssh`, `scp`, `git push`, `git reset --hard`, `git clean`, `shutdown`, `reboot`, `drop table`, `truncate`, `delete from` 등 절대 차단.
  - `DEV_TOOL_ALLOWED_SEQUENCES`: `git status/diff/log`, `find`, `grep`, `npm test`, `npm run test`, `mvn test`.
  - `AGENT_LAUNCHER_SEQUENCES`: `claude -p`, `codex --ask-for-approval never exec`, `agy --print`, `ollama run` — 에이전트 CLI 런처는 스킬별 `allowed_commands` 검사 대상이 아님(런처 자체와 "실제 작업 도구"는 다른 개념이라는 설계 판단). `blocked_commands`는 런처 호출에도 방어심층 차원에서 적용.
  - `assertCommandAllowed(command, args, {taskId, agentName})`: 차단 목록 → 스킬 blocklist → allowlist → 스킬 allowlist 순서로 검사. 차단 시 `command_logs`에 `blocked=true`로 기록.
  - `assertArgsSafe`: 인자 중 경로로 보이는 토큰을 pathGuard로 검증.
  - `getLauncherPromptArgIndex`: 각 런처별 "자연어 프롬프트가 argvのどこにあるか"를 명시적 인덱스로 고정(휴리스틱 대신) — claude는 `-p` 다음, codex는 마지막 인자, agy는 `--print` 다음, ollama는 `run <model>` 다음.
  - `truncateForDisplay()`: 차단 사유 Discord 메시지는 300자로 자르되(런처 프롬프트가 수백~수천 자일 수 있음), `command_logs` DB에는 전체 원문 보존.

- **`services/shell.js`**: `exec` → `spawn(shell:false)`로 전환. `runCommand(command, args, {cwd, trusted, taskId, agentName})`. `trusted:true`는 `services/git.js`의 고정 복구 명령(add/commit/checkout/clean)처럼 이미 승인 절차로 보호되는 내부 명령에만 사용. `extractErrorMessage(error)` 헬퍼로 commandGuard의 plain `Error`와 spawn의 `{error,stdout,stderr}` 두 reject 형태를 모두 사람이 읽을 수 있는 메시지로 정규화.

### 재검증에서 발견/수정한 이슈
- pathGuard 공백 경로 심볼릭 링크 우회 (`"link dir/passwd"` → `/etc/passwd`) — 수정.
- `find -exec` 등으로 allowlist 우회 가능했던 것 — `DANGEROUS_FIND_FLAGS`로 무조건 차단.
- 스킬 관련 `trusted:true` 오용 — 제거.
- `agents/*.js`의 `error.stderr || error.error` 패턴이 commandGuard의 plain Error를 만나면 `"실행 실패: undefined"`가 되던 버그 — `extractErrorMessage()`로 해결.

---

## Phase 3 — 메모리 세션의 DB 완전 이관 <a name="phase-3"></a>

**목표:** `bot.js`의 휘발성 `currentSession` 메모리 상태 머신을 PostgreSQL 기반 영속 상태 머신으로 전환.

### 구현
- `tasks.status`를 상태 머신의 단일 진실 소스로 사용: `CREATED → PENDING_PLAN_APPROVAL → PENDING_CODEX_APPROVAL → PENDING_GEMINI_APPROVAL → PENDING_COMMIT_APPROVAL → DONE`, 분기로 `CANCELLED`/`REJECTED`/`ROLLBACK_FAILED`.
- `approvals` 테이블 + `approvalService.js`:
  - `openApproval(taskId, action, requestedBy)`: `INSERT ... ON CONFLICT (task_id, action) WHERE (status='PENDING') DO NOTHING` — partial unique index로 DB 레벨에서 중복 PENDING 생성을 원천 차단.
  - `resolveLatest(taskId, {approved, resolvedBy, reason})`: 단일 UPDATE문(서브쿼리로 최신 PENDING 선택 + WHERE에 `status='PENDING'` 재확인)으로 원자적 승인/반려. PostgreSQL 행 잠금 덕분에 동시 요청 시 정확히 하나만 성공.
- `session_store.json` 파일 제거, `bot_settings` 테이블로 `workspace_dir` 등 소규모 설정 영속화.
- `!reject` 시 `git.discardChanges()`로 워크스페이스 롤백 — 승인 처리와 실제 git 롤백이 어긋나면(승인은 됐는데 git 롤백 실패) `ROLLBACK_FAILED`라는 별도 상태로 불일치를 명시적으로 드러냄(REJECTED로 덮어써서 조용히 넘기지 않음).

### 재검증에서 발견/수정한 이슈
- `INSERT ... WHERE NOT EXISTS`만으로는 20-way 동시 요청 시 중복 삽입 발생(실측 확인) → partial unique index + `ON CONFLICT DO NOTHING`으로 해결, 재실측 시 정확히 1개만 삽입됨.
- `!approve`/`!reject` 동시 실행 race condition → `resolveLatest`의 단일 UPDATE 원자성으로 해결.
- git diff가 untracked 신규 파일을 감지 못하던 문제 → `git diff --no-index -- /dev/null <file>`를 untracked 파일별로 수행(`git add -N .`는 `!reject` 롤백 시 빈 파일 잔류 버그가 있어 폐기).
- 비ASCII(한글 등) untracked 파일명이 git의 C-style quoting 때문에 diff에서 누락 → byte-level octal escape 디코더(`unquoteGitPath`) 구현.

---

## Phase 4 — Queue 기반 비동기화 <a name="phase-4"></a>

**목표:** 에이전트 CLI 실행의 긴 대기시간 동안 봇이 멈추지 않고, 다중 사용자 요청 간 워크스페이스 경합을 방지.

### 구현
- **`src/queue/taskQueue.js`**: 순수 FIFO 배열 저장소(`push`/`shift`/`size`).
- **`src/queue/worker.js`**: `enqueue(jobFn, {onQueued})` — `isRunning` 플래그 기반 단일 소비 루프(Node 싱글 스레드 특성상 안전). `waitingAhead = taskQueue.size() + (isRunning ? 1 : 0)`로 실행 중인 작업까지 포함해 정확한 대기 순번 계산.
- `bot.js`의 모든 에이전트 CLI 호출 지점(10곳: `!task`, `!approve` 각 분기, `finalizeAfterReview`, `!run-codex`, `!claude/!codex/!gemini/!gemma` 단발 명령)을 `worker.enqueue()`로 감싸 직렬화.

### 재검증에서 발견/수정한 이슈 (3라운드에 걸쳐 진행)

**1라운드 — 큐 도입 자체:**
- 실제 CLI 이중 호출로 순차 실행 검증(최대 동시 실행 1개 확인).

**2라운드 — git diff 원자성 블로커:**
- `worker.enqueue()`로 CLI 호출만 감싸고 그 결과에 의존하는 `git.getDiff()`/상태전이/approval open을 큐 밖에서 하면, 다음 큐 작업이 그 사이 워크스페이스를 먼저 바꿔서 diff가 섞이는 문제 발견 → CLI 호출부터 후처리까지 전부 하나의 `worker.enqueue()` 클로저 안으로 이동.
- `finalizeAfterReview()`가 자체적으로 `worker.enqueue()`를 부르는데 호출부도 큐 안에 있으면 **교착 상태**(중첩 enqueue) 발생 가능 — `finalizeAfterReview`에서 자체 enqueue 제거, 항상 이미 큐 job 안에서 호출되는 전제로 재설계.

**3라운드 — 큐 선점 순서(FIFO) 블로커:**
- `!approve`가 `taskService.getActiveTaskForChannel()` 같은 DB 조회를 먼저 하고 나서 `worker.enqueue()`를 부르면, 그 DB 왕복(수 ms) 사이에 완전히 동기적으로 준비하는 `!gemma` 같은 명령이 먼저 큐 슬롯을 선점하는 것을 실측 확인(`!approve`가 먼저 호출됐는데 `!gemma`가 먼저 시작하는 사례 재현).
- **해결:** `!approve`/`!skip` 전체를 어떤 await도 거치지 않고 곧바로 하나의 `worker.enqueue()`로 감싸고, task 조회/분기 판단 자체를 큐 job 안으로 이동. 트레이드오프로 "승인할 게 없는" `!approve`도 큐가 밀려 있으면 응답이 늦어질 수 있으나, 순서 보장을 우선했다.

---

## Phase 5 — Skill Registry & Context Builder <a name="phase-5"></a>

**목표:** 작업별 맞춤 지시서(Skill) 매칭, 명령어 권한 적용, 컨텍스트 최적화, AI 기반 스킬 자동 축적.

### 구현
- **`src/skills/skillRegistry.js`**: `/skills/<id>/skill.json`을 스캔해 `skills` 테이블에 upsert(`allowedCommands`/`blockedCommands`/`requiredApproval` 포함). `loadSkillTemplates()`로 `prompt.md`/`checklist.md` 로딩.
- **`src/skills/skillMatcher.js`**: `trigger_keywords`(대소문자 무관) 매칭 점수가 가장 높은 skill 선택.
- **`src/core/contextBuilder.js`**: `MAX_RECENT_MESSAGES=20`, 스킬 프롬프트 주입, Planner/Coder/Reviewer용 프롬프트 조립.
- **`src/core/summaryService.js`**: 긴 대화(20개 초과)를 Gemma로 요약, `summarized_until_message_id`로 델타만 재요약(rolling summarization).
- **AI 기반 스킬 자동 축적 (`src/skills/skillDiscovery.js`)**:
  - 커밋 성공 직후 Manager LLM(Claude)이 작업 히스토리를 분석해 재사용 가치를 판단(`prompts/skillDiscovery.md`로 순수 JSON 출력 강제).
  - `isValidSkillId()`: `^[a-z][a-z0-9-]{2,49}$` 정규식 + 최종 경로가 `SKILLS_DIR` 바로 아래인지 이중 검증(LLM이 생성하는 `skillId`가 파일 경로가 되므로 신뢰할 수 없는 입력으로 취급).
  - `writeSkillFiles()`: 승인 후에만 `/skills/<id>/`에 실제 기록. 기존 skill id와 충돌하면 자동 차단.
  - Discord 명령 `!approve-skill <ID>` / `!reject-skill <ID>` 추가.

### 재검증에서 발견/수정한 이슈
- **요약 입력이 무계(unbounded)**: 라운드가 늘어날수록 매번 전체 오래된 메시지를 다시 요약 입력으로 넣던 문제(21→234자, 100→8878자로 실측). `summarized_until_message_id` 델타 추적으로 해결, 재측정 시 라운드 델타만큼만 증가(25→163→195→195→435→435).
- **Gemma "thinking trace" 오염**: `gemma4:e4b`가 기본적으로 긴 사고 과정을 출력해 요약이 수천 자로 부풀려짐 → `--hidethinking` 플래그로 해결. 이후 비TTY 환경에서 ANSI 이스케이프 코드(`\x1B[K`)가 섞여 나오는 것도 발견 → `--nowordwrap` 추가.
- **경로 이탈 방어**: `skillId: "../../evil"` 등 악의적 입력이 `writeSkillFiles()`에서 실제로 차단되는지 재현 검증.

---

## Phase 6 — CLI 어댑터 & 에이전트 순차 협업 <a name="phase-6"></a>

**목표:** 하드코딩된 에이전트 연동을 공통 인터페이스로 개선, Planner→Coder→Reviewer 순차 오케스트레이션.

**설계 결정(사용자 승인):** "추가형" 접근 — 기존 `!approve` 파이프라인의 제어 흐름(Phase 4의 FIFO/원자성 하드닝)은 전혀 건드리지 않고, 어댑터/라우터 구조를 새로 만들되 `bot.js`의 라이브 명령에는 아직 연결하지 않음.

### 구현
- **`src/adapters/claudeCli.js`, `geminiCli.js`** (신규, `codexCli.js`와 동일한 공통 인터페이스): `{stdout, stderr, exitCode, durationMs}` 반환, 실패해도 예외를 던지지 않고 `exitCode:1`로 감쌈.
- **`src/agents/reviewerAgent.js`**: 인라인 try/catch/타이밍 로직 제거, `geminiCli.js` 어댑터로 교체(동작 불변, 내부 구현만 개선).
- **`src/agents/plannerAgent.js`** (신규): Claude 기반 Planner, `claudeCli` 사용, `agent_results`에 `plan` 저장.
- **`src/core/agentRouter.js`** (신규): `runSequence(task, {coderInstruction, reviewerInstruction, cwd})` — Planner→Coder→Reviewer 순차 실행, 한 단계 실패 시 다음 단계 중단. 향후 Phase 7 QA 루프나 새 단발 명령에서 재사용 가능한 독립 모듈.
- **`bot.js` 추가형 wiring**: 제어 흐름은 그대로 두고 `!task`(plan)/`!approve` 3개 지점(Codex 1차/Gemini 리뷰/Codex 재수정)에 `agentResultService.saveResult()` 호출만 추가 — 기존 `messages` 트랜스크립트뿐 아니라 `agent_results`(종류별 구조화 저장소)에도 남도록.

### 검증
- `claudeCli`/`geminiCli` 실제 CLI 호출 확인.
- `agentRouter.runSequence` 실제 워크스페이스로 end-to-end 실행 — `agent_results` 저장 순서 `planner:plan → coder:code_diff → reviewer:review` 정확히 확인.

---

## Phase 7 — QA Agent 추가 및 종합 안정화 <a name="phase-7"></a>

**목표:** 코드 신뢰도 검증을 위한 QA 단계 도입, 테스트 실패 시 Reviewer/Coder 피드백 흐름, 최종 검증 성공 후에만 승인 대기 상태로 전환.

**설계 결정(사용자 승인):**
- QA 삽입 위치: Gemini 리뷰 통과(`next_action=finalize`) 후, Gemma 요약 **전**. 실패 시 기존 Codex 재수정 루프(revise)를 그대로 재사용.
- 테스트 명령: 워크스페이스 자동 감지(`package.json`→`npm test`, `pom.xml`→`mvn test`, 둘 다 없으면 스킵).

### 구현
- **`src/agents/qaAgent.js`** (신규):
  - `detectTestCommand(cwd)`: 자동 감지.
  - `runQaAgent(task, {cwd})`: 세 가지 판정 — `skipped:true`(테스트 설정 없음/정책 차단/러너 미설치), `passed:true`(테스트 통과), `passed:false`(실제 테스트 실패). `agent_results`에 `qa_report`로 저장.
  - **판정 분류 헬퍼:**
    - `isCommandGuardBlock(err)`: commandGuard가 던지는 plain Error(`.stdout`/`.stderr` 없음) — 정책 문제, skip 취급.
    - `isSpawnEnoent(err)`: `err.error.code === "ENOENT"` 우선 확인, 폴백으로 `extractErrorMessage()` 결과가 문자열 맨 앞에서 `^spawn \S+ ENOENT` 패턴에 매칭하는지(테스트 자체 실패 메시지에 우연히 "ENOENT" 문자열이 섞여도 오탐하지 않도록 앵커링) — 테스트 러너 미설치, skip 취급.
- **`bot.js`**:
  - `runCodexRevisionRound()` 헬퍼 신설 — 기존 Gemini 재수정 로직을 파라미터화해 추출(동작 불변). Gemini revise와 QA 실패 두 경로가 공유.
  - `runQaGatedFinalize()` 헬퍼 신설 — QA 실행 후 실패 시 `runCodexRevisionRound`(QA 실패 로그를 피드백으로), 통과/스킵 시 `finalizeAfterReview` 호출.
  - `!approve`의 Gemini finalize 분기와 `!skip` 양쪽 모두 `runQaGatedFinalize`를 거치도록 재배선.

### 재검증에서 발견/수정한 이슈
- **Maven 미설치 환경에서 QA가 infra 문제를 테스트 실패로 오분류**: `pom.xml`은 있는데 로컬에 `mvn`이 없으면 `spawn mvn ENOENT`가 "실제 테스트 실패"로 잘못 분류되어 Codex 무한 재수정 루프를 유발할 수 있었음(실측 재현). `isSpawnEnoent()` 추가로 해결 — 5개 시나리오(정책 차단/실제 실패/설정 없음/mvn 미설치/npm 미설치) + 오탐 방지 경계 케이스 전부 재현 검증 통과.

### 검증
- 실제 버그(`a - b`)가 있는 워크스페이스에서 QA 실패 → 실패 로그를 Codex에 피드백 → **Codex가 실제로 버그를 찾아 수정**(`a + b`로 변경) → 재실행한 QA 통과까지 실측 확인. `agent_results` 순서: `qa_report(fail) → code_diff(fix) → qa_report(pass)`.

---

## 9. 전체 아키텍처 요약

```
Discord 메시지
  → bot.js (messageCreate 핸들러)
    → src/core/pathGuard.js / commandGuard.js (보안 검증)
    → src/queue/worker.js (FIFO 직렬화 — 에이전트 CLI 호출 전부)
    → agents/{claude,codex,gemini,gemma}.js (CLI 실행, services/shell.js의 spawn 기반 runCommand)
    → src/adapters/{claudeCli,codexCli,geminiCli}.js (공통 인터페이스 래퍼, Phase 6)
    → src/agents/{plannerAgent,coderAgent,reviewerAgent,qaAgent}.js (agent_results 저장까지 포함)
    → src/core/agentRouter.js (Planner→Coder→Reviewer 순차 오케스트레이션, 독립 재사용 모듈)
    → src/core/{taskService,messageService,approvalService,agentResultService}.js (DB 상태 머신)
    → src/skills/{skillMatcher,skillRegistry,skillDiscovery}.js (스킬 매칭/동기화/자동 생성)
    → src/core/contextBuilder.js / summaryService.js (프롬프트 조립, rolling 요약)
  → PostgreSQL (tasks/messages/command_logs/skills/approvals/bot_settings/task_summaries/agent_results)
```

### 핵심 설계 원칙 (프로젝트 전체를 관통)
1. **승인 없는 워크스페이스 변경 금지** — 모든 코드 수정 단계는 `!approve`를 거친다. 자동화(QA 테스트 실행 등)는 비파괴적인 것만 허용.
2. **큐를 통한 워크스페이스 직렬화** — 동시에 두 에이전트 프로세스가 같은 git 저장소를 건드리지 않는다.
3. **DB가 유일한 진실 소스** — 봇 프로세스가 재시작돼도 `tasks.status`/`approvals`로 정확히 재개 가능.
4. **spawn 기반 실행 + allowlist/blocklist** — 쉘 인젝션 원천 차단, 명시적으로 허용된 명령만 통과.
5. **실패는 예외가 아니라 정상적인 판정 결과** — QA 실패, Gemini 리뷰 수정 요청 등은 시스템 오류가 아니라 파이프라인이 처리해야 할 정상 분기.

---

## 10. DB 스키마 전체

| 테이블 | 도입 Phase | 역할 |
|---|---|---|
| `tasks` | 1 (확장: 3, 5) | 상태 머신 핵심. `status`, `plan`, `round`, `next_action`, `selected_skill_id`, `risk_level` |
| `messages` | 1 | 대화 트랜스크립트 (사람이 읽는 로그) |
| `command_logs` | 2 | 실행/차단된 모든 명령 기록 (`blocked` 플래그) |
| `skills` | 1 (확장: Hotfix, 3) | `allowed_commands`/`blocked_commands`/`required_approval` 포함 |
| `approvals` | 3 | `task_id`+`action` PENDING partial unique index로 중복 방지 |
| `bot_settings` | 3 | `workspace_dir` 등 소규모 설정 (session_store.json 대체) |
| `task_summaries` | 4 | rolling 요약, `summarized_until_message_id`로 델타 추적 |
| `agent_results` | 5 (확장: 6, 7) | `result_type`(plan/code_diff/review/qa_report/skill_proposal/error)별 구조화 결과 |

---

## 11. 알려진 잔여 이슈 (블로커 아님)

`AI_MANAGER_FOLLOW_UP_NOTES.md`에 상세 기록됨. 요약:

1. **`!reject`의 코드/리뷰/커밋 롤백 분기가 큐 밖에서 `taskService.getActiveTaskForChannel()`을 호출** — Phase 4 마지막 FIFO 라운드에서 `!approve`/`!skip`만 완전히 큐 안으로 옮겼고, `!reject`는 범위 밖으로 남겨둠(Medium 우선순위, "즉시 취소해야 하는 명령이 큐 뒤에서 기다리는 게 맞는가"라는 UX 트레이드오프가 있어 별도 논의 필요).
2. **`!run-codex`도 `worker.enqueue()` 전에 DB await(`taskService.getTask`/`hasAnyActiveTask`)가 남아있음** (Low~Medium).
3. **큐 사이즈 제한 없음** — 운영 규모가 커지면 `MAX_QUEUE_SIZE`/대기 시간 안내 정책 필요 (Low, 설계 판단 필요).
4. **Pending skill proposal끼리의 `skillId` 중복 방지 미흡** — DB에 이미 등록된 skill과의 충돌은 막지만, 아직 승인 대기 중인 proposal끼리의 충돌은 안 막음 (Low~Medium).
5. **`agentRouter.js`가 아직 `bot.js` 라이브 명령에 연결되지 않음** — Phase 6에서 "추가형"으로 의도적으로 남겨둔 상태. 향후 재사용 대기.

---

## 12. 검증 방법론

각 Phase마다 다음 절차를 반복했다:
1. 실제 코드 읽기로 현재 상태 파악(가정하지 않음).
2. 실제 PostgreSQL 컨테이너, 실제 git 저장소(`/tmp` 또는 `ai-manager-test`), **실제 CLI 호출**(Claude/Codex/Gemini/Gemma)로 end-to-end 검증 — mock은 LLM 호출 비용이 큰 경우(예: 실패 시나리오 재현)에만 `require.cache` 치환으로 사용.
3. 재검증 라운드마다 발견된 이슈를 실측 로그(타임스탬프, JSON 출력)로 재현.
4. 회귀 스위트: 전체 `node -c` 문법 검사 + Phase 1~N 스모크 테스트(스킬 동기화, `!dbtask` → `QA_DONE`, ContextBuilder 유계성, approvalService 20-way 동시성, pathGuard/commandGuard 차단) 매 라운드 재실행.
5. 테스트로 생성한 DB row/`skills/` 디렉토리/임시 파일을 매번 정리.

모든 재검증 프롬프트는 기획자(사용성 관점, 실제 Discord 조작)와 개발자(코드 레벨, 재현 로그 요구) 두 역할로 분리해 작성·전달했다.
