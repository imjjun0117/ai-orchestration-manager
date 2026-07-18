const db = require("../db");
const { generateTaskId } = require("../utils/idGenerator");

const ACTIVE_STATUSES = Object.freeze([
  "RECEIVED",
  "PM_PLANNING",
  "AUTONOMOUS_EXECUTION",
  "PM_ESCALATION",
  "PENDING_FINAL_APPROVAL",
  "PENDING_PLAN_APPROVAL",
  "PENDING_CODEX_APPROVAL",
  "PENDING_GEMINI_APPROVAL",
  "PENDING_COMMIT_APPROVAL",
]);

const OCCUPIED_STATUSES = Object.freeze([...ACTIVE_STATUSES, "PAUSED"]);

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * 새 Task를 생성하고 tasks 테이블에 저장합니다.
 * @param {object} params
 * @param {string} params.title 작업 제목 (원본 요청 요약 용도로 원본 요청 그대로 사용)
 * @param {string} params.originalRequest 사용자 원본 요청
 * @param {string} params.createdBy 요청한 Discord 사용자명
 * @param {string} params.channelId 요청이 들어온 채널 ID
 * @param {string} [params.selectedSkillId] skillMatcher가 선택한 skill id (없으면 generic)
 * @param {string} [params.riskLevel] 선택된 skill의 위험도 (없으면 DB 기본값 'low')
 */
async function createTask({ title, originalRequest, createdBy, channelId, selectedSkillId = null, riskLevel = null }) {
  const id = await generateTaskId();
  const { rows } = await db.query(
    `INSERT INTO tasks (id, title, original_request, status, created_by, channel_id, selected_skill_id, risk_level)
     VALUES ($1, $2, $3, 'CREATED', $4, $5, $6, COALESCE($7, 'low'))
     RETURNING *`,
    [id, title, originalRequest, createdBy, channelId, selectedSkillId, riskLevel]
  );
  return rows[0];
}

/**
 * task_id로 Task를 조회합니다.
 * @param {string} taskId
 */
async function getTask(taskId) {
  const { rows } = await db.query("SELECT * FROM tasks WHERE id = $1", [taskId]);
  return rows[0] || null;
}

/**
 * Task 상태와 현재 담당 Agent를 갱신합니다. (11. Task 상태 머신 참고)
 * @param {string} taskId
 * @param {string} status
 * @param {string} currentAgent
 */
async function updateStatus(taskId, status, currentAgent) {
  const { rows } = await db.query(
    `UPDATE tasks SET status = $2, current_agent = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [taskId, status, currentAgent]
  );
  return rows[0] || null;
}

/**
 * 레거시 세션형 !task -> !approve 파이프라인용 Task를 생성한다.
 * PENDING_PLAN_APPROVAL 상태로 곧바로 시작하며, plan/round/next_action을 함께 저장한다.
 * @param {object} params
 * @param {string} params.taskPrompt 사용자 원본 작업 요청
 * @param {string} params.createdBy
 * @param {string} params.channelId
 * @param {string} params.plan Claude(Manager)가 생성한 계획 텍스트
 * @param {string} [params.selectedSkillId] skillMatcher가 선택한 skill id (없으면 generic)
 * @param {string} [params.riskLevel] 선택된 skill의 위험도 (없으면 DB 기본값 'low')
 */
async function createLegacyTask({ taskPrompt, createdBy, channelId, plan, selectedSkillId = null, riskLevel = null }) {
  const id = await generateTaskId();
  const { rows } = await db.query(
    `INSERT INTO tasks (id, title, original_request, status, created_by, channel_id, plan, round, next_action, selected_skill_id, risk_level)
     VALUES ($1, $2, $2, 'PENDING_PLAN_APPROVAL', $3, $4, $5, 0, NULL, $6, COALESCE($7, 'low'))
     RETURNING *`,
    [id, taskPrompt, createdBy, channelId, plan, selectedSkillId, riskLevel]
  );
  return rows[0];
}

/**
 * 채널 기준으로 현재 활성 상태인 task를 하나 조회한다. (가장 최근 생성분)
 * legacy PENDING_* 상태와 새 자동 파이프라인 상태를 모두 active로 취급하되,
 * PAUSED/DONE/REJECTED/CANCELLED/ROLLBACK_FAILED/QA_DONE은 비활성이다.
 * @param {string} channelId
 */
async function getActiveTaskForChannel(channelId) {
  const { rows } = await db.query(
    `SELECT * FROM tasks WHERE channel_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [channelId, ACTIVE_STATUSES]
  );
  return rows[0] || null;
}

/**
 * 봇 전체에 진행 중인 active task가 있는지 확인한다.
 * (!project로 워크스페이스를 바꾸거나 새 !task를 시작할 때, 동시에 여러 task가
 * 같은 워크스페이스/git 저장소를 건드리지 않도록 하는 가드로 쓰인다.)
 */
async function hasAnyActiveTask() {
  const { rows } = await db.query(`SELECT id FROM tasks WHERE status = ANY($1) LIMIT 1`, [ACTIVE_STATUSES]);
  return rows.length > 0;
}

async function getOccupiedTaskForChannel(channelId, { excludeTaskId = null } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM tasks
     WHERE channel_id = $1
       AND status = ANY($2)
       AND ($3::text IS NULL OR id != $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [channelId, OCCUPIED_STATUSES, excludeTaskId]
  );
  return rows[0] || null;
}

async function getAnyOccupiedTask({ excludeTaskId = null } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM tasks
     WHERE status = ANY($1)
       AND ($2::text IS NULL OR id != $2)
     ORDER BY created_at DESC
     LIMIT 1`,
    [OCCUPIED_STATUSES, excludeTaskId]
  );
  return rows[0] || null;
}

async function hasAnyOccupiedTask({ excludeTaskId = null } = {}) {
  const occupiedTask = await getAnyOccupiedTask({ excludeTaskId });
  return Boolean(occupiedTask);
}

const UPDATABLE_FIELDS = [
  "status",
  "round",
  "next_action",
  "plan",
  "current_agent",
  "risk_level",
  "paused_at",
  "paused_from_status",
  "pause_requested",
  "discord_thread_id",
  "current_pid",
  "current_pgid",
  "current_host_id",
  "current_owner_instance_id",
  "role_overrides",
];

/**
 * 정해진 필드(UPDATABLE_FIELDS)만 갱신하는 범용 업데이터.
 * @param {string} taskId
 * @param {object} fields status/round/next_action/plan/current_agent/risk_level 중 갱신할 값들
 */
async function updateTask(taskId, fields) {
  const keys = Object.keys(fields).filter((key) => UPDATABLE_FIELDS.includes(key));
  if (keys.length === 0) return getTask(taskId);

  const setClauses = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
  const values = keys.map((key) => fields[key]);

  const { rows } = await db.query(
    `UPDATE tasks SET ${setClauses}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
    [taskId, ...values]
  );
  return rows[0] || null;
}

async function requestPause(taskId) {
  const { rows } = await db.query(
    `UPDATE tasks
     SET pause_requested = TRUE, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [taskId]
  );
  return rows[0] || null;
}

async function pauseTask(taskId, fromStatus) {
  const { rows } = await db.query(
    `UPDATE tasks
     SET status = 'PAUSED',
         pause_requested = FALSE,
         paused_from_status = $2,
         paused_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [taskId, fromStatus]
  );
  return rows[0] || null;
}

async function resumeTask(taskId) {
  const task = await getTask(taskId);
  if (!task || task.status !== "PAUSED" || !task.paused_from_status) {
    return null;
  }

  const { rows } = await db.query(
    `UPDATE tasks
     SET status = $2,
         pause_requested = FALSE,
         paused_from_status = NULL,
         paused_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'PAUSED'
     RETURNING *`,
    [taskId, task.paused_from_status]
  );
  return rows[0] || null;
}

module.exports = {
  ACTIVE_STATUSES,
  OCCUPIED_STATUSES,
  createTask,
  createLegacyTask,
  getAnyOccupiedTask,
  getTask,
  getActiveTaskForChannel,
  getOccupiedTaskForChannel,
  hasAnyActiveTask,
  hasAnyOccupiedTask,
  isActiveStatus,
  requestPause,
  pauseTask,
  resumeTask,
  updateStatus,
  updateTask,
};
