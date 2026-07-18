const geminiCli = require("../adapters/geminiCli");
const agentResultService = require("../core/agentResultService");
const contextBuilder = require("../core/contextBuilder");

/**
 * Reviewer(Gemini) 에이전트를 실행한다: contextBuilder로 프롬프트(+diff)를 조립하고,
 * geminiCli 어댑터로 Gemini를 호출한 뒤, 결과를 agent_results(result_type="review")에 저장한다.
 * (Phase 6: coderAgent.js와 동일하게 전용 어댑터(geminiCli.js)를 통해 공통 인터페이스로 호출)
 * @param {object} task tasks 테이블 레코드
 * @param {object} params
 * @param {string} params.diff 현재 코드 변경사항 (git.getDiff 결과)
 * @param {string} params.instruction Gemini에게 시킬 구체적 지시문
 * @param {string} params.cwd
 */
async function runReviewerAgent(task, { diff, instruction, cwd }) {
  const prompt = await contextBuilder.buildReviewerContext(task, { diff, instruction, cwd });
  const result = await geminiCli.runGemini(prompt, { cwd, taskId: task.id });

  await agentResultService.saveResult({
    taskId: task.id,
    agentName: "reviewer",
    resultType: result.exitCode === 0 ? "review" : "error",
    content: result.stdout || result.stderr,
    modelName: "gemini",
  });

  return result;
}

module.exports = {
  runReviewerAgent,
};
