const db = require("../db");
const logger = require("../../services/logger");
const messageService = require("./messageService");
const { askGemma } = require("../../agents/gemma");

/**
 * task의 가장 최근 요약을 조회한다. 없으면 null.
 * @param {string} taskId
 */
async function getLatestSummary(taskId) {
  const { rows } = await db.query(
    "SELECT * FROM task_summaries WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1",
    [taskId]
  );
  return rows[0] || null;
}

/**
 * 새 요약을 task_summaries에 저장한다.
 * @param {string} taskId
 * @param {string} summary
 * @param {number|null} summarizedUntilMessageId 이 요약이 반영한(messages.id 기준) 마지막 메시지 id
 * @param {string} [summaryType]
 */
async function createSummary(taskId, summary, summarizedUntilMessageId, summaryType = "rolling") {
  const { rows } = await db.query(
    `INSERT INTO task_summaries (task_id, summary, summary_type, summarized_until_message_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [taskId, summary, summaryType, summarizedUntilMessageId]
  );
  return rows[0];
}

/**
 * 메시지 수가 keepRecentCount를 넘으면, 그 초과분(오래된 메시지) 중에서도 아직 어떤
 * 요약에도 반영되지 않은 "새로 늙은" 메시지만 골라 Gemma에 보내 rolling summary를
 * 갱신한다.
 *
 * 핵심: 매번 "오래된 메시지 전체"를 다시 Gemma에 넣지 않는다. 이전 요약이 이미
 * summarized_until_message_id까지 반영했다면, 이번에는 그보다 id가 큰(=아직 요약 안 된)
 * 오래된 메시지만 입력에 포함시킨다. 그래서 총 메시지 수가 아무리 늘어나도(30, 100, 1000...)
 * 한 번의 Gemma 호출에 들어가는 입력 크기는 "직전 요약 이후 새로 20개 밖으로 밀려난
 * 메시지 수"에만 비례하고, 전체 히스토리 길이에는 비례하지 않는다.
 *
 * 새로 요약할 메시지가 하나도 없으면(=이미 이 시점까지 다 반영돼 있으면) Gemma를
 * 호출하지 않고 null을 반환한다 (LLM 호출도, 새 task_summaries row도 생기지 않는다 -
 * 같은 메시지 상태에서 여러 번 호출해도 중복 요약이 쌓이지 않는다).
 *
 * 메시지 수 자체가 keepRecentCount 이하라면 애초에 요약이 필요 없으므로 이 역시 null.
 *
 * @param {string} taskId
 * @param {number} keepRecentCount 이 개수만큼은 원문 그대로 최근 대화로 남기고, 나머지를 요약 대상으로 삼는다.
 * @param {string} cwd askGemma 호출에 필요한 작업 디렉토리
 */
async function summarizeIfNeeded(taskId, keepRecentCount, cwd) {
  const allMessages = await messageService.getTaskMessages(taskId);
  if (allMessages.length <= keepRecentCount) {
    return null;
  }

  const oldMessages = allMessages.slice(0, allMessages.length - keepRecentCount);
  const oldBoundaryId = Number(oldMessages[oldMessages.length - 1].id);

  const existingSummary = await getLatestSummary(taskId);
  const lastSummarizedId = existingSummary && existingSummary.summarized_until_message_id
    ? Number(existingSummary.summarized_until_message_id)
    : 0;

  const newlyOldMessages = oldMessages.filter((m) => Number(m.id) > lastSummarizedId);

  if (newlyOldMessages.length === 0) {
    // 오래된 메시지 구간이 이전 요약에서 이미 전부 반영됨 - 새로 할 일이 없으므로 스킵.
    return null;
  }

  const summarizeInput =
    (existingSummary ? `[기존 요약]\n${existingSummary.summary}\n\n` : "") +
    `[새로 요약할 대화]\n${messageService.formatMessages(newlyOldMessages)}`;

  logger.info(
    `[ContextBuilder] task=${taskId} 새로 늙은 메시지 ${newlyOldMessages.length}개 요약 트리거 ` +
      `(전체 ${allMessages.length}개, 유지 ${keepRecentCount}개, 이전 요약 반영 지점=${lastSummarizedId})`
  );

  const summaryText = await askGemma(summarizeInput, { cwd, mode: "conversation-summary", taskId });

  const saved = await createSummary(taskId, summaryText, oldBoundaryId, "rolling");
  logger.info(
    `[ContextBuilder] task=${taskId} 요약 저장 완료 (summary_id=${saved.id}, 길이=${summaryText.length}, ` +
      `summarized_until_message_id=${oldBoundaryId})`
  );
  return saved;
}

module.exports = {
  getLatestSummary,
  createSummary,
  summarizeIfNeeded,
};
