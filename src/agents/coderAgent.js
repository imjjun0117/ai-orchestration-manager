const codexCli = require("../adapters/codexCli");
const agentResultService = require("../core/agentResultService");
const contextBuilder = require("../core/contextBuilder");

/**
 * Coder(Codex) 에이전트를 실행한다: contextBuilder로 프롬프트를 조립하고,
 * codexCli 어댑터로 Codex를 호출한 뒤, 결과를 agent_results(result_type="code_diff")에 저장한다.
 *
 * 보안 범위 참고(src/core/commandGuard.js의 assertCommandAllowed 문서 참고): task에
 * skill이 선택되어 있으면 commandGuard가 "codex 런처 호출 자체"는 스킬 blocked_commands로
 * 막을 수 있지만, Codex 프로세스가 일단 실행된 뒤 내부적으로 어떤 파일을 만지는지는
 * 이 경로로 통제되지 않는다(Codex 자체의 --sandbox workspace-write에 맡겨져 있음).
 * skill allowed_commands는 이 함수 경로에서 "Codex 내부 작업"을 제한하는 장치가 아니다.
 *
 * @param {object} task tasks 테이블 레코드 (id, selected_skill_id 사용)
 * @param {object} params
 * @param {string} params.instruction Codex에게 시킬 구체적 지시문
 * @param {string} params.cwd
 */
async function runCoderAgent(task, { instruction, cwd }) {
  const prompt = await contextBuilder.buildCoderContext(task, { instruction, cwd });
  const result = await codexCli.runCodex(prompt, { cwd, taskId: task.id });

  await agentResultService.saveResult({
    taskId: task.id,
    agentName: "coder",
    resultType: result.exitCode === 0 ? "code_diff" : "error",
    content: result.stdout || result.stderr,
    modelName: "codex",
  });

  return result;
}

module.exports = {
  runCoderAgent,
};
