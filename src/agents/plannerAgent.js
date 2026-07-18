const fs = require("fs");
const path = require("path");
const claudeCli = require("../adapters/claudeCli");
const agentResultService = require("../core/agentResultService");
const contextBuilder = require("../core/contextBuilder");

const MANAGER_PROMPT_PATH = path.join(__dirname, "../../prompts/manager.md");

/**
 * Planner(Claude) 에이전트를 실행한다: prompts/manager.md + task.original_request로
 * 프롬프트를 조립하고, claudeCli 어댑터로 Claude를 호출한 뒤, 결과를
 * agent_results(result_type="plan")에 저장한다. (coderAgent.js/reviewerAgent.js와
 * 동일한 패턴 - 이미 생성된 task를 대상으로 한다는 점이 다름: bot.js의 라이브 !task
 * 명령은 계획을 먼저 뽑은 "뒤에" task를 만들지만, 이 함수는 agentRouter.js처럼
 * task_id가 이미 있는 재사용 경로를 위한 것이다.)
 * @param {object} task tasks 테이블 레코드 (id, original_request 사용)
 * @param {object} params
 * @param {string} params.cwd
 */
async function runPlannerAgent(task, { cwd }) {
  const systemPrompt = fs.existsSync(MANAGER_PROMPT_PATH)
    ? fs.readFileSync(MANAGER_PROMPT_PATH, "utf8")
    : "";
  const prompt = contextBuilder.buildPlannerContext({ taskPrompt: task.original_request, systemPrompt });
  const result = await claudeCli.runClaude(prompt, { cwd });

  await agentResultService.saveResult({
    taskId: task.id,
    agentName: "planner",
    resultType: result.exitCode === 0 ? "plan" : "error",
    content: result.stdout || result.stderr,
    modelName: "claude",
  });

  return result;
}

module.exports = {
  runPlannerAgent,
};
