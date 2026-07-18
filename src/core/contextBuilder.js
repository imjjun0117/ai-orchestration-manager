const logger = require("../../services/logger");
const messageService = require("./messageService");
const summaryService = require("./summaryService");
const skillRegistry = require("../skills/skillRegistry");

// 에이전트 프롬프트에 원문 그대로 넣어줄 최근 메시지 개수. 이보다 오래된 메시지는
// summaryService가 요약해 task_summaries에 저장하고, 여기서는 요약본만 사용한다.
// (LLM에 전체 대화 로그를 매번 통째로 보내지 않기 위함 - 라운드가 늘어나도 프롬프트
// 크기가 무한정 커지지 않는다.)
const MAX_RECENT_MESSAGES = 20;

/**
 * 선택된 skill의 prompt.md/checklist.md를 에이전트 프롬프트 말미에 붙일 텍스트로 만든다.
 * 선택된 skill이 없거나 템플릿이 비어 있으면 빈 문자열을 반환한다.
 * @param {string} selectedSkillId
 */
function buildSkillGuidance(selectedSkillId) {
  if (!selectedSkillId) return "";

  const { prompt, checklist } = skillRegistry.loadSkillTemplates(selectedSkillId);
  if (!prompt && !checklist) return "";

  return `\n\n[선택된 스킬 가이드라인]\n${prompt}\n\n[스킬 검증 체크리스트]\n${checklist}`;
}

/**
 * task_id의 대화 맥락을 "이전 요약 + 최근 메시지"로 압축해 구성한다.
 * 메시지가 MAX_RECENT_MESSAGES를 넘으면 그 초과분을 먼저 요약(summaryService)해 둔 뒤,
 * 최신 요약 + 최근 메시지만 반환한다.
 * @param {string} taskId
 * @param {string} cwd 요약 생성(Gemma 호출)에 필요한 작업 디렉토리
 */
async function buildRecentContext(taskId, cwd) {
  await summaryService.summarizeIfNeeded(taskId, MAX_RECENT_MESSAGES, cwd);

  const allMessages = await messageService.getTaskMessages(taskId);
  const recentMessages = allMessages.slice(-MAX_RECENT_MESSAGES);
  const latestSummary = await summaryService.getLatestSummary(taskId);

  const parts = [];
  if (latestSummary) {
    parts.push(`[이전 대화 요약]\n${latestSummary.summary}`);
  }
  parts.push(`[최근 대화 (최대 ${MAX_RECENT_MESSAGES}개)]\n${messageService.formatMessages(recentMessages)}`);

  const context = parts.join("\n\n");
  logger.info(
    `[ContextBuilder] task=${taskId} 컨텍스트 생성: 전체 메시지 ${allMessages.length}개 중 최근 ${recentMessages.length}개 사용` +
      `${latestSummary ? " + 요약 1개 포함" : ""} (길이=${context.length}자)`
  );
  return context;
}

/**
 * Planner(Claude Manager)용 프롬프트를 조립한다. 최초 !task 단계라 아직 task/대화 히스토리가
 * 없으므로 요약이나 최근 메시지 없이 사용자 원본 요청만으로 구성한다.
 * @param {object} params
 * @param {string} params.taskPrompt 사용자 원본 작업 요청
 * @param {string} params.systemPrompt prompts/manager.md 내용
 */
function buildPlannerContext({ taskPrompt, systemPrompt }) {
  return `${systemPrompt}\n\n사용자 작업 요청:\n"${taskPrompt}"\n\n위 요청에 대해 분석 및 계획을 작성해줘.`;
}

/**
 * Coder(Codex)용 프롬프트를 조립한다: 요약 + 최근 대화 + 이번 단계 지시문 + 스킬 가이드라인.
 * @param {object} task tasks 테이블 레코드 (id, selected_skill_id 사용)
 * @param {object} params
 * @param {string} params.instruction 이번 호출에서 Codex에게 구체적으로 시킬 지시문
 * @param {string} params.cwd
 */
async function buildCoderContext(task, { instruction, cwd }) {
  const recent = await buildRecentContext(task.id, cwd);
  return `${recent}\n\n${instruction}` + buildSkillGuidance(task.selected_skill_id);
}

/**
 * Reviewer(Gemini)용 프롬프트를 조립한다: 요약 + 최근 대화 + 현재 Git Diff + 지시문 + 스킬 가이드라인.
 * @param {object} task tasks 테이블 레코드
 * @param {object} params
 * @param {string} params.diff 현재 코드 변경사항 (git.getDiff 결과)
 * @param {string} params.instruction 이번 호출에서 Gemini에게 구체적으로 시킬 지시문
 * @param {string} params.cwd
 */
async function buildReviewerContext(task, { diff, instruction, cwd }) {
  const recent = await buildRecentContext(task.id, cwd);
  return (
    `${recent}\n\n[현재 코드 Git Diff]\n\`\`\`diff\n${diff}\n\`\`\`\n\n${instruction}` +
    buildSkillGuidance(task.selected_skill_id)
  );
}

module.exports = {
  MAX_RECENT_MESSAGES,
  buildSkillGuidance,
  buildPlannerContext,
  buildCoderContext,
  buildReviewerContext,
};
