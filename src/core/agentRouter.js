const plannerAgent = require("../agents/plannerAgent");
const coderAgent = require("../agents/coderAgent");
const reviewerAgent = require("../agents/reviewerAgent");
const git = require("../../services/git");

const DEFAULT_REVIEWER_INSTRUCTION =
  '사용자 목적에 비추어 설계 결함, 로직 오류, 보안 취약점이 없는지 리뷰해줘. 수정이 필요하다면 구체적인 개선 지침을 남기고, 문제가 없다면 명확히 "문제 없음"이라고 밝혀줘.';

/**
 * Planner(Claude) -> Coder(Codex) -> Reviewer(Gemini) 순서로 이미 존재하는 task에 대해
 * 순차 실행하고, 각 단계 결과를 agent_results에 기록한다(각 *Agent.js가 스스로 기록).
 *
 * bot.js의 !task/!approve 상태 머신(단계마다 Discord 승인을 기다림)과는 별개의, "한 번에
 * 끝까지" 실행하는 재사용 가능한 오케스트레이션 API다. 현재 bot.js의 라이브 명령에는
 * 아직 연결돼 있지 않다 - Phase 4(큐 FIFO 순서)/git diff 원자성/스킬 자동생성 훅이
 * 이미 촘촘히 맞물려 있는 기존 !approve 파이프라인의 제어 흐름은 그대로 두고, 이
 * 모듈은 향후(예: Phase 7 QA 루프, 새로운 단발 명령) 재사용할 수 있도록 별도로 준비해
 * 둔 것이다.
 *
 * 한 단계가 실패(exitCode !== 0)하면 그 이후 단계는 실행하지 않고 그 시점까지의
 * 결과만 반환한다.
 *
 * @param {object} task tasks 테이블 레코드 (id, original_request, selected_skill_id 사용)
 * @param {object} params
 * @param {string} params.coderInstruction Coder(Codex)에게 시킬 구체적 지시문
 * @param {string} [params.reviewerInstruction] Reviewer(Gemini)에게 시킬 구체적 지시문
 *   (생략 시 기본 리뷰 지시문 사용)
 * @param {string} params.cwd
 * @returns {Promise<{
 *   planResult: {stdout,stderr,exitCode,durationMs},
 *   coderResult: {stdout,stderr,exitCode,durationMs} | null,
 *   reviewResult: {stdout,stderr,exitCode,durationMs} | null,
 * }>}
 */
async function runSequence(task, { coderInstruction, reviewerInstruction, cwd }) {
  const planResult = await plannerAgent.runPlannerAgent(task, { cwd });
  if (planResult.exitCode !== 0) {
    return { planResult, coderResult: null, reviewResult: null };
  }

  const coderResult = await coderAgent.runCoderAgent(task, { instruction: coderInstruction, cwd });
  if (coderResult.exitCode !== 0) {
    return { planResult, coderResult, reviewResult: null };
  }

  const diff = await git.getDiff(cwd);
  const reviewResult = await reviewerAgent.runReviewerAgent(task, {
    diff,
    instruction: reviewerInstruction || DEFAULT_REVIEWER_INSTRUCTION,
    cwd,
  });

  return { planResult, coderResult, reviewResult };
}

module.exports = {
  runSequence,
};
