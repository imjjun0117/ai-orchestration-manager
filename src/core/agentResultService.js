const db = require("../db");

/**
 * 에이전트 실행 결과를 agent_results에 저장한다.
 * messages(대화 트랜스크립트)와 달리, "이 task의 최신 code_diff/review가 뭐였나"처럼
 * 종류(result_type) 기준으로 바로 조회하기 위한 구조화 저장소다.
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.agentName 예: "coder", "reviewer"
 * @param {string} params.resultType 예: "plan", "code_diff", "review", "qa_report", "summary", "error"
 * @param {string} params.content
 * @param {string} [params.modelName] 예: "codex", "gemini"
 */
async function saveResult({ taskId, agentName, resultType, content, modelName }) {
  const { rows } = await db.query(
    `INSERT INTO agent_results (task_id, agent_name, result_type, content, model_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [taskId, agentName, resultType, content, modelName]
  );
  return rows[0];
}

/**
 * task_id의 모든 에이전트 결과를 시간순으로 조회한다.
 * @param {string} taskId
 */
async function getResultsForTask(taskId) {
  const { rows } = await db.query(
    "SELECT * FROM agent_results WHERE task_id = $1 ORDER BY created_at ASC, id ASC",
    [taskId]
  );
  return rows;
}

/**
 * task_id의 특정 result_type 중 가장 최근 것을 조회한다. (예: 최신 code_diff)
 * @param {string} taskId
 * @param {string} resultType
 */
async function getLatestResultByType(taskId, resultType) {
  const { rows } = await db.query(
    `SELECT * FROM agent_results WHERE task_id = $1 AND result_type = $2
     ORDER BY created_at DESC LIMIT 1`,
    [taskId, resultType]
  );
  return rows[0] || null;
}

module.exports = {
  saveResult,
  getResultsForTask,
  getLatestResultByType,
};
