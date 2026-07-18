-- Phase 1: tasks / messages 테이블
-- Phase 2(보안): command_logs 테이블 추가
-- Phase 3: skills 테이블 추가
-- Skill Registry Hotfix: skills.allowed_commands/blocked_commands/required_approval 추가
-- 레거시 세션 파이프라인 DB 이관: tasks.plan/round/next_action, approvals, bot_settings 추가
-- Phase 4: task_summaries 테이블 추가 (Context Builder - 대화가 길어지면 오래된 부분을 요약)
-- Phase 5: agent_results 테이블 추가 (Codex Adapter - 에이전트 실행 결과를 종류별로 구조화 저장)
-- (agent_runs 등은 이후 Phase에서 추가)

CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(50) PRIMARY KEY,
  title TEXT NOT NULL,
  original_request TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
  current_agent VARCHAR(50),
  selected_skill_id VARCHAR(100),
  risk_level VARCHAR(20) DEFAULT 'low',
  created_by VARCHAR(100),
  channel_id VARCHAR(100),
  plan TEXT,
  round INTEGER DEFAULT 0,
  next_action VARCHAR(20),
  paused_at TIMESTAMPTZ,
  paused_from_status TEXT,
  pause_requested BOOLEAN DEFAULT FALSE,
  discord_thread_id TEXT,
  current_pid INTEGER,
  current_pgid INTEGER,
  current_host_id TEXT,
  current_owner_instance_id TEXT,
  role_overrides JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS pause_requested BOOLEAN DEFAULT FALSE;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS current_pid INTEGER;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS current_pgid INTEGER;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS current_host_id TEXT;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS current_owner_instance_id TEXT;

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE CASCADE,
  discord_message_id VARCHAR(100),
  channel_id VARCHAR(100),
  author_id VARCHAR(100),
  author_name VARCHAR(100),
  role VARCHAR(50),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS command_logs (
  id BIGSERIAL PRIMARY KEY,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE CASCADE,
  agent_name VARCHAR(50),
  command TEXT NOT NULL,
  stdout TEXT,
  stderr TEXT,
  exit_code INTEGER,
  blocked BOOLEAN DEFAULT FALSE,
  duration_ms INTEGER,
  timed_out BOOLEAN DEFAULT FALSE,
  killed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE command_logs
  ADD COLUMN IF NOT EXISTS timed_out BOOLEAN DEFAULT FALSE;

ALTER TABLE command_logs
  ADD COLUMN IF NOT EXISTS killed BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS skills (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  trigger_keywords TEXT,
  agent_type VARCHAR(50),
  risk_level VARCHAR(20),
  allowed_commands TEXT[],
  blocked_commands TEXT[],
  required_approval BOOLEAN DEFAULT TRUE,
  enabled BOOLEAN DEFAULT TRUE,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approvals (
  id BIGSERIAL PRIMARY KEY,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  requested_by VARCHAR(50),
  approved_by VARCHAR(100),
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- !project 로 지정하는 workspaceDir 등, 세션 파일(session_store.json) 대신 DB에 두는 소규모 설정 값 저장소
CREATE TABLE IF NOT EXISTS bot_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Phase 11: 다중 Discord 봇/다중 프로세스가 같은 git workspace를 동시에 건드리지
-- 못하도록 DB에 workspace 단위 전역 락을 둔다. owner_pid는 같은 호스트 내 긴급 진단용이고,
-- Phase 12에서 host/process-tree ownership을 더 보강할 예정이다.
CREATE TABLE IF NOT EXISTS workspace_locks (
  workspace_key TEXT PRIMARY KEY,
  owner_host_id TEXT NOT NULL DEFAULT 'unknown',
  owner_instance_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE SET NULL,
  command_label TEXT,
  acquired_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workspace_locks_expires_at
  ON workspace_locks (expires_at);

ALTER TABLE workspace_locks
  ADD COLUMN IF NOT EXISTS owner_host_id TEXT NOT NULL DEFAULT 'unknown';

-- 대화가 길어지면(contextBuilder.MAX_RECENT_MESSAGES 초과) 오래된 메시지를 Gemma로
-- 요약해 여기 저장한다. 에이전트 프롬프트에는 전체 메시지 대신 최신 요약 + 최근 메시지만 전달한다.
-- summarized_until_message_id: 이 요약이 messages.id 기준 어디까지 반영했는지 기록한다.
-- 다음 요약 시점에는 이 id보다 큰(=아직 요약에 안 들어간) "오래된" 메시지만 새로 입력에
-- 넣어서, 매번 오래된 메시지 전체를 다시 요약하지 않고 rolling 방식으로 이어붙인다.
CREATE TABLE IF NOT EXISTS task_summaries (
  id BIGSERIAL PRIMARY KEY,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  summary_type VARCHAR(50) DEFAULT 'latest',
  summarized_until_message_id BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 에이전트 실행 결과를 종류별(plan/code_diff/review/qa_report/summary/error)로 구조화 저장.
-- messages가 사람이 읽는 대화 트랜스크립트라면, agent_results는 "이 task의 최신 code_diff는
-- 뭐였나" 같은 걸 타입 기준으로 바로 조회하기 위한 구조화된 결과 저장소다.
CREATE TABLE IF NOT EXISTS agent_results (
  id BIGSERIAL PRIMARY KEY,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE CASCADE,
  agent_name VARCHAR(50) NOT NULL,
  result_type VARCHAR(50),
  content TEXT NOT NULL,
  model_name VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_bindings (
  role TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

INSERT INTO role_bindings (role, agent_name) VALUES
  ('pm', 'claude'),
  ('coder', 'codex'),
  ('reviewer', 'gemini'),
  ('qa', 'codex'),
  ('summarizer', 'gemma')
ON CONFLICT (role) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_skill ON tasks(selected_skill_id);
CREATE INDEX IF NOT EXISTS idx_tasks_channel_id ON tasks(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_task_id ON messages(task_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_command_logs_task_id ON command_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_task_summaries_task_id ON task_summaries(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_results_task_id ON agent_results(task_id);
CREATE INDEX IF NOT EXISTS idx_role_bindings_agent_name ON role_bindings(agent_name);

-- 같은 task/action에 PENDING approval이 동시에 두 개 이상 생기는 것을 DB 레벨에서 원천 차단
-- (INSERT ... WHERE NOT EXISTS만으로는 진짜 동시 요청 하에서 race가 발생함 - approvalService.openApproval 참고)
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_unique_pending
  ON approvals (task_id, action) WHERE (status = 'PENDING');
