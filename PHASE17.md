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

## 장애 복구와 롤백

Manager가 watchdog을 실행하며 `npm run phase17 -- recover`로 수동 복구할 수 있습니다. lease 만료는 safe job만 retry하고 Coder/QA처럼 side effect가 가능한 job은 `NEEDS_RECONCILIATION`으로 보냅니다. Discord ack 전 장애는 correlation marker를 기준으로 reconciliation합니다.

`npm run phase17 -- readiness`는 token 원문이나 connection string을 출력하지 않고 Phase Gate, role principal, fingerprinted credential, workflow definition, live instance, queue/outbox 상태를 점검합니다.

기존 ACTIVE 자격증명에 fingerprint 메타데이터만 없는 경우 `npm run phase17 -- credential-inventory`로 비밀값 없는 상태를 확인한 뒤 `npm run phase17 -- fingerprint-credentials --confirm-fingerprint-backfill`을 실행합니다. 이 명령은 암호화된 token을 변경하거나 출력하지 않고 누락된 fingerprint만 채웁니다.

Phase 15의 네 계정을 `gate-admin→manager-01`, `planning-validator→planner-01`, `worker→coder-01`, `development-validator→reviewer-01`로 전환할 때는 `npm run phase17 -- adopt-legacy-credentials --confirm-legacy-role-mapping`을 실행합니다. 암호문은 그대로 복제되고 기존 행도 rollback 용도로 보존됩니다. 같은 Discord 계정을 쓰는 legacy bot과 Phase 17 bot을 동시에 실행하면 안 됩니다.

레거시 전환 전용으로 `npm run phase17 -- import-candidate-credentials --confirm-candidate-import`가 남아 있지만, 새 역할 token의 정상 등록 경로는 `node bot.js` 일괄 설정 또는 위의 역할 노드 직접 실행입니다. 레거시 import는 기존 ACTIVE fingerprint와 중복되거나 대상 행이 이미 있으면 전체 트랜잭션을 중단합니다.

Discord가 후보 token을 거부한 경우 `npm run phase17 -- revoke-candidate-credentials --confirm-invalid-candidate-revocation`으로 이번 import에서 만든 ACTIVE 행만 취소합니다. 행과 암호문은 삭제하지 않으며 새 token을 안전하게 재등록하면 다시 활성화할 수 있습니다.

```sh
MULTIBOT_ROLE_MODE=off npm run phase17 -- rollback --allow-destructive --confirm-phase17
```

rollback은 비종료 workflow가 있으면 거부하며, Phase 17 schema만 내리고 legacy task/Phase 16 schema는 보존합니다.
