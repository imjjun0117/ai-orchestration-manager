# Phase 17 운영 절차

Phase 17은 PostgreSQL을 역할 봇 간 제어 채널로 사용합니다. Discord token은 env/argv/log에 두지 않고 기존 `channel_credentials`에 암호화해 저장합니다.

## 적용 순서

```sh
npm run migrate:phase16
npm run migrate:phase17
npm run phase17 -- bootstrap-roles --create-postgres-roles --write-env-profiles
npm run phase17 -- provision-role manager_db manager
npm run phase17 -- provision-role planner_db planner
npm run phase17 -- provision-role coder_db coder
npm run phase17 -- provision-role reviewer_db reviewer
npm run phase17 -- provision-role qa_db qa
npm run phase17 -- provision-role summarizer_db summarizer
```

`bootstrap-roles`는 여섯 PostgreSQL login role이 모두 없는 초기 환경에서만 실행됩니다. 무작위 암호와 0600 권한의 `.env.phase17/.env.<role>` shadow 프로필을 만들며, 기존 role이나 env 디렉터리를 발견하면 암호를 변경하거나 덮어쓰지 않고 중단합니다. 개별 `provision-role` 명령은 이미 외부에서 생성한 role을 바인딩할 때 사용합니다.

`npm run phase17 -- verify-role-profiles`는 기본 여섯 프로필의 파일 권한, 평문 token 부재, 실제 `SESSION_USER`, 역할 바인딩을 읽기 전용으로 확인합니다.

각 PostgreSQL role은 자신의 `DATABASE_URL`로만 연결해야 합니다. `bot_role_principals`가 DB principal과 runtime role을 다시 확인하므로 env의 `BOT_ROLE`만 바꿔 권한을 얻을 수 없습니다.

## 실행 모드

- `MULTIBOT_ROLE_MODE=shadow`: Phase 16 Gate가 필요하며 workflow/lease/job은 기록하지만 Discord publication은 `SHADOWED`로 남기고 전송하지 않습니다.
- `MULTIBOT_ROLE_MODE=enforced`: Phase 16과 Phase 17 Gate가 모두 승인되어야 합니다.
- `ROLE_WORKER_EXECUTION=dry-run`은 shadow 검증용입니다. 실제 Coder/QA 실행에는 `ISOLATED_WORKSPACE_MODE=true`, `CODER_WRITE_ENABLED=true`, `ISOLATED_WORKSPACE_ROOT`가 필요합니다.

각 env 파일에는 `BOT_ROLE`, `BOT_INSTANCE_ID`, 역할별 `DATABASE_URL`, `MULTIBOT_ROLE_MODE`, `CHANNEL_TOKEN_MASTER_KEY`가 필요합니다. 평문 `DISCORD_TOKEN` 또는 `CHANNEL_TOKEN`은 6-bot runner가 거부합니다.

## 여섯 bot token 일괄 등록

운영자 `.env`의 `DATABASE_URL`과 `CHANNEL_TOKEN_MASTER_KEY`를 사용해 아래 명령 하나로 여섯 역할의 Discord token을 순서대로 등록할 수 있습니다.

```sh
node bot.js
# 1) Phase 17: configure six role bot tokens 선택
```

등록 순서는 `manager-01`, `planner-01`, `coder-01`, `reviewer-01`, `qa-01`, `summarizer-01`입니다. 입력값은 TTY에 표시되지 않으며 즉시 암호화되어 `channel_credentials`에 저장됩니다. 여섯 Phase 17 대상 사이에서 같은 token을 다시 입력하면 저장하지 않고 다른 token을 요구합니다.

기존 행을 먼저 삭제할 필요는 없습니다. `ACTIVE` 행은 기본값 `no`로 보존되고, `yes`를 선택하면 같은 인스턴스의 token만 교체합니다. `REVOKED` 또는 누락된 행은 바로 새 token을 입력받습니다. 중간에 취소해도 앞에서 저장을 마친 행은 유지되므로 `node bot.js`를 다시 실행해 이어서 설정할 수 있습니다. 마법사는 설정만 수행하고 bot을 자동 실행하지 않습니다.

`.env.phase17` 역할 프로필은 운영자 `.env`와 같은 `CHANNEL_TOKEN_MASTER_KEY` 및 key version을 사용해야 합니다. 새 token의 실제 Discord 로그인 유효성은 bot 시작 시 확인되며, Discord가 거부한 credential은 `REVOKED`됩니다.

## 개별 노드 실행 시 token 등록

역할 노드를 TTY에서 직접 실행하면 해당 인스턴스의 ACTIVE Discord credential을 DB에서 먼저 조회합니다. 값이 없거나 `REVOKED`이면 token을 화면에 표시하지 않고 입력받아 즉시 암호화한 뒤, 현재 PostgreSQL principal에 바인딩된 자기 인스턴스에만 저장하고 그대로 로그인합니다.

```sh
ENV_FILE=.env.phase17/.env.qa node roleBot.js
ENV_FILE=.env.phase17/.env.summarizer node roleBot.js
# Manager는 ENV_FILE=.env.phase17/.env.manager node managerBot.js
```

ACTIVE credential이 이미 있으면 프롬프트 없이 DB 값을 사용합니다. supervisor의 stdin은 닫혀 있으므로 누락된 token을 자동 입력받지 않고 fail-closed합니다. Discord가 새 token을 거부하면 그 DB 행은 다시 `REVOKED`되고, 노드를 다시 실행하면 교체 token을 입력할 수 있습니다. token은 env, argv, 로그, Git 파일에 기록되지 않습니다.

```sh
MULTIBOT_CONTROL_DATABASE_URL='postgres://operator/...'
npm run multibot:phase17 -- \
  .env.phase17/.env.manager \
  .env.phase17/.env.planner \
  .env.phase17/.env.coder \
  .env.phase17/.env.reviewer \
  .env.phase17/.env.qa \
  .env.phase17/.env.summarizer
```

`MULTIBOT_CONTROL_DATABASE_URL`은 credential fingerprint와 DB principal binding을 preflight하는 운영자 연결이며 child process에는 전달되지 않습니다. runner는 여섯 role, instance ID, ACTIVE fingerprint, principal binding의 중복/누락을 모두 검사합니다.

로컬 운영에서는 이 값이 없으면 runner가 `PHASE17_CONTROL_ENV_FILE` 또는 기본 `.env`의 `DATABASE_URL`만 읽어 사용합니다. 해당 파일의 다른 값과 평문 token은 child process에 병합하지 않습니다.

## macOS 상시 실행

터미널 세션과 무관하게 여섯 봇을 유지하려면 `launchd` LaunchAgent를 사용합니다. 저장소의 렌더러는 shell을 거치지 않고 Node와 여섯 역할 프로필을 정확한 argv로 고정하며, plist에는 token, master key, `DATABASE_URL`을 넣지 않습니다.

```sh
npm run launchd:phase17 -- paths
npm run launchd:phase17 -- render
npm run launchd:phase17 -- verify "$HOME/Library/LaunchAgents/com.ai-manager.phase17.plist"
```

설치 전 `.env.phase17-runtime` 디렉터리를 `0700`으로 만들고 렌더링한 plist를 `~/Library/LaunchAgents/com.ai-manager.phase17.plist`에 저장합니다. LaunchAgent 파일은 `0600`, 로그는 plist의 `Umask=0077` 정책을 사용합니다. 등록은 현재 GUI 사용자 도메인의 `launchctl bootstrap gui/$(id -u) ...`로 수행합니다. `RunAtLoad`와 `KeepAlive`가 활성화되어 로그인 세션에서 비정상 종료 시 전체 supervisor를 다시 기동합니다.

서비스 전환 때는 먼저 기존 터미널 supervisor에 `SIGTERM`을 보내 여섯 인스턴스가 모두 `OFFLINE`인지 확인한 후 LaunchAgent를 등록해야 합니다. 중복 실행은 허용하지 않습니다. 설정 변경은 LaunchAgent를 `bootout`한 상태에서 역할 프로필에 적용하고 다시 `bootstrap`합니다.

실운영 전환은 여섯 프로필의 `MULTIBOT_ROLE_MODE=enforced`, `ROLE_WORKER_EXECUTION=active`를 함께 사용합니다. runner는 여섯 프로필의 모드가 하나라도 다르면 기동 전에 거부합니다. Coder/QA에는 같은 절대경로의 `ISOLATED_WORKSPACE_ROOT`, `ISOLATED_WORKSPACE_MODE=true`, `CODER_WRITE_ENABLED=true`가 필요하고 root 권한은 정확히 `0700`이어야 합니다.

Coder 프로필의 `WORKSPACE_DIR`는 백업된 bare canonical repository여야 하며 non-bare working copy는 거부됩니다. QA 프로필은 `ISOLATED_SANDBOX_BACKEND=container`, 로컬에 존재하는 고정 `SANDBOX_CONTAINER_IMAGE`, 선택적 `QA_NPM_SCRIPT`를 사용합니다. QA는 등록된 task workspace 하나만 read-write mount하고 network, root filesystem, capabilities를 차단한 컨테이너에서 실행되며 host `npm` fallback은 없습니다.

```sh
docker build --file docker/phase17-qa.Dockerfile \
  --tag ai-manager-qa:phase17-6066cd90dbb0 .
docker image inspect --format '{{.Id}}' ai-manager-qa:phase17-6066cd90dbb0
git clone --bare --no-local /absolute/path/to/ai-manager \
  /protected/runtime/path/canonical.git
```

`.dockerignore`는 build context를 Dockerfile과 `package.json`/`package-lock.json`으로 제한해 `.env` 및 역할 프로필이 daemon으로 전달되지 않게 합니다. runtime 프로필에는 mutable tag보다 위 inspect가 반환한 `sha256:...` image ID를 저장합니다. 전환 후 `npm run phase17 -- readiness`가 blocker 없이 통과한 다음 비중요 사용자 작업 한 건으로 전체 흐름을 확인합니다.

## 역할별 Discord 발신 ID 검증

Phase 17 Gate 승인 전에는 `shadow` 모드를 유지한 채 아래 명령으로 여섯 역할 계정의 실제 발신 ID를 두 차례씩 검증합니다. 스크립트는 각 계정이 같은 테스트 채널에 bot-authored `!task` 마커를 보내게 하고, Discord에서 다시 조회한 author ID와 DB의 `bot_instances` 역할 바인딩이 일치하는지 확인합니다. Manager ingress가 12개 메시지를 모두 거부하고 `discord_event_receipts`를 만들지 않은 것도 함께 검사합니다.

```sh
npm run smoke:phase17:authors -- --confirm-live-discord
# AI_WAR_ROOM_CHANNEL_ID가 비어 있고 기존 숫자형 task 채널이 정확히 하나인 경우
npm run smoke:phase17:authors -- --confirm-live-discord --use-latest-task-channel
```

root `.env`에서는 `AI_WAR_ROOM_CHANNEL_ID`와 후검증용 운영자 `DATABASE_URL`만 선택해 사용하며 legacy `DISCORD_TOKEN`은 process env나 자식 프로세스에 로드하지 않습니다. 이 값이 비어 있으면 `--use-latest-task-channel`을 명시할 수 있지만, DB에 저장된 숫자형 Discord task 채널 후보가 정확히 하나가 아니면 실행을 거부합니다. 역할 token은 각 역할 DB principal로 `channel_credentials`에서 복호화하며 출력하지 않습니다. Manager principal의 최소권한은 유지하고, `discord_event_receipts`가 0건인지 확인하는 읽기 전용 쿼리만 운영자 연결로 수행합니다. 기본 실행은 자신이 만든 테스트 메시지의 정확한 ID만 검증 후 삭제하고, 하나라도 정리하지 못하면 실패합니다. Gate 전용 smoke이므로 역할 프로필이 `enforced`이면 실행을 거부합니다.

## 강제 종료·재접속·rate-limit 검증

아래 smoke는 제어 평면이 idle이고 여섯 인스턴스가 모두 `OFFLINE`일 때만 실행됩니다. 각 역할의 실제 entrypoint를 기동하고 등록 PID를 확인한 뒤, 자신이 만든 정확한 자식 프로세스만 `SIGKILL`합니다. 같은 역할 프로필을 다시 기동해 새 PID와 기존 Discord ID로 `ONLINE` 복구되는지 확인하고 `SIGTERM`으로 정상 종료해 다시 `OFFLINE`인지 검사합니다.

```sh
npm run smoke:phase17:resilience -- --confirm-live-discord
# AI_WAR_ROOM_CHANNEL_ID가 비어 있고 기존 숫자형 task 채널이 정확히 하나인 경우
npm run smoke:phase17:resilience -- --confirm-live-discord --use-latest-task-channel
```

프로세스 재기동 후에는 여섯 Discord client가 모두 초기 Ready인지 먼저 확인하고, 현재 `discord.js`/`@discordjs/ws`의 shard Resume 경로로 통제된 연결 단절을 발생시켜 `shardReconnecting`과 `shardResume`을 검증합니다. REST rate-limit 검증은 메시지를 생성하지 않고 최근 메시지 1건 조회 endpoint만 사용합니다. Discord가 제공한 5-request/1-second bucket에서 대기 이벤트를 확인한 뒤 추가 조회가 성공해야 통과합니다. 기본 최대 요청 수는 역할당 12회이며 토큰, channel ID, Discord user ID, URL은 출력하지 않습니다.

## 장애 복구와 롤백

Manager가 watchdog을 실행하며 `npm run phase17 -- recover`로 수동 복구할 수 있습니다. lease 만료는 safe job만 retry하고 Coder/QA처럼 side effect가 가능한 job은 `NEEDS_RECONCILIATION`으로 보냅니다. Discord ack 전 장애는 correlation marker를 기준으로 reconciliation합니다.

자동 복구가 안전하지 않은 항목은 운영자 연결로 먼저 비밀값 없는 목록을 확인합니다.

```sh
npm run phase17 -- reconcile-list
```

목록의 `item_type`, `item_id`, `reconciliation_revision`을 사건 기록과 대조한 뒤 아래 두 결정 중 하나만 적용할 수 있습니다.

- `RETRY`: 이전 외부 부작용이 없었음을 확인한 role job, 또는 Discord correlation marker를 다시 검사할 outbox에 사용합니다. claim/lease를 지우고 재시도 예산을 정확히 한 번 확보합니다.
- `DEAD_LETTER`: 재실행하지 않고 명시적으로 실패 종결할 때 사용합니다. role job이면 node/run/task도 실패 상태로 맞춥니다.

```sh
npm run phase17 -- reconcile \
  --request-id operator-20260722-001 \
  --item-type OUTBOX_EVENT \
  --item-id outbox-example \
  --decision RETRY \
  --expected-revision 1 \
  --reason 'Discord marker 검색 결과 기존 발신이 없음을 확인했습니다.' \
  --evidence-ref incident:phase17-20260722-001 \
  --confirm-reconciliation
```

`request-id`는 같은 입력의 재실행만 멱등으로 허용하며 다른 입력에 재사용할 수 없습니다. revision이 바뀌면 compare-and-set으로 거부되므로 `reconcile-list`부터 다시 확인해야 합니다. 사유는 16자 이상, 근거 참조는 공백 없는 incident/ticket/artifact 식별자여야 합니다. 감사 행은 `phase17_reconciliation_actions`에 append-only로 남고 bot 역할 DB principal에는 이 함수가 부여되지 않습니다. token, payload, error detail은 목록이나 감사 snapshot에 포함하지 않습니다.

`npm run phase17 -- readiness`는 token 원문이나 connection string을 출력하지 않고 Phase Gate, role principal, fingerprinted credential, workflow definition, live instance, queue/outbox 상태를 점검합니다. 감사 기록 없이 남은 `NEEDS_RECONCILIATION`/`DEAD_LETTER`만 blocker로 계산합니다.

기존 ACTIVE 자격증명에 fingerprint 메타데이터만 없는 경우 `npm run phase17 -- credential-inventory`로 비밀값 없는 상태를 확인한 뒤 `npm run phase17 -- fingerprint-credentials --confirm-fingerprint-backfill`을 실행합니다. 이 명령은 암호화된 token을 변경하거나 출력하지 않고 누락된 fingerprint만 채웁니다.

Phase 15의 네 계정을 `gate-admin→manager-01`, `planning-validator→planner-01`, `worker→coder-01`, `development-validator→reviewer-01`로 전환할 때는 `npm run phase17 -- adopt-legacy-credentials --confirm-legacy-role-mapping`을 실행합니다. 암호문은 그대로 복제되고 기존 행도 rollback 용도로 보존됩니다. 같은 Discord 계정을 쓰는 legacy bot과 Phase 17 bot을 동시에 실행하면 안 됩니다.

레거시 전환 전용으로 `npm run phase17 -- import-candidate-credentials --confirm-candidate-import`가 남아 있지만, 새 역할 token의 정상 등록 경로는 `node bot.js` 일괄 설정 또는 위의 역할 노드 직접 실행입니다. 레거시 import는 기존 ACTIVE fingerprint와 중복되거나 대상 행이 이미 있으면 전체 트랜잭션을 중단합니다.

Discord가 후보 token을 거부한 경우 `npm run phase17 -- revoke-candidate-credentials --confirm-invalid-candidate-revocation`으로 이번 import에서 만든 ACTIVE 행만 취소합니다. 행과 암호문은 삭제하지 않으며 새 token을 안전하게 재등록하면 다시 활성화할 수 있습니다.

```sh
MULTIBOT_ROLE_MODE=off npm run phase17 -- rollback --allow-destructive --confirm-phase17
```

rollback은 비종료 workflow가 있으면 거부하며, Phase 17 schema만 내리고 legacy task/Phase 16 schema는 보존합니다.
