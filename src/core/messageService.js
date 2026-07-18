const db = require("../db");

/**
 * Task에 연결된 메시지를 messages 테이블에 저장합니다.
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.discordMessageId
 * @param {string} params.channelId
 * @param {string} params.authorId
 * @param {string} params.authorName
 * @param {string} params.role user/manager/planner/coder/reviewer/qa/system
 * @param {string} params.content
 */
async function addMessage({ taskId, discordMessageId, channelId, authorId, authorName, role, content }) {
  const { rows } = await db.query(
    `INSERT INTO messages (task_id, discord_message_id, channel_id, author_id, author_name, role, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [taskId, discordMessageId, channelId, authorId, authorName, role, content]
  );
  return rows[0];
}

/**
 * task_id에 연결된 메시지를 시간순으로 전부 조회한다.
 * (레거시 세션 파이프라인에서 in-memory history 대신 대화 맥락을 재구성할 때 사용)
 * @param {string} taskId
 */
async function getTaskMessages(taskId) {
  const { rows } = await db.query(
    "SELECT * FROM messages WHERE task_id = $1 ORDER BY created_at ASC, id ASC",
    [taskId]
  );
  return rows;
}

/**
 * 메시지 목록을 "[작성자]: 내용" 형태의 텍스트로 포맷한다. (에이전트 프롬프트용 대화 맥락)
 * @param {Array} messages
 */
function formatMessages(messages) {
  if (!messages || messages.length === 0) {
    return "(이전 대화 내역 없음)";
  }
  return messages.map((m) => `[${m.author_name}]: ${m.content}`).join("\n");
}

module.exports = {
  addMessage,
  getTaskMessages,
  formatMessages,
};
