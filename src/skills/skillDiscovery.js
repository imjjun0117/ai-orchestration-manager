const fs = require("fs");
const path = require("path");
const db = require("../db");
const logger = require("../../services/logger");
const { askClaude } = require("../../agents/claude");
const messageService = require("../core/messageService");
const skillRegistry = require("./skillRegistry");

const SKILLS_DIR = path.join(__dirname, "../../skills");
const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]{2,49}$/;

function isValidSkillId(id) {
  return typeof id === "string" && SKILL_ID_PATTERN.test(id);
}

function skillIdExists(id, existingSkills) {
  return existingSkills.some((s) => s.id === id);
}

/**
 * Claude 응답에서 JSON 객체 부분만 안전하게 추출한다. 지시했음에도 설명 문구나
 * 코드펜스가 섞여 나올 가능성에 대비해, 첫 '{'부터 마지막 '}'까지만 파싱을 시도한다.
 */
function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

function buildAnalysisPrompt(task, transcript, existingSkills) {
  const skillListText = existingSkills.length > 0
    ? existingSkills.map((s) => `- ${s.id}: ${s.description || s.name}`).join("\n")
    : "(등록된 skill 없음)";

  return [
    "## 완료된 작업 요청",
    task.original_request,
    "",
    "## 대화/작업 기록",
    transcript,
    "",
    "## 기존 Skill 목록",
    skillListText,
  ].join("\n");
}

/**
 * 완료(DONE)된 task를 분석하여 재사용 가치가 있는 Skill로 만들 만한지 Manager LLM(Claude)에게
 * 판단시킨다. 실패하거나 부적합하면 예외를 던지지 않고 {suitable:false}를 반환한다 - 이미
 * 커밋까지 끝난 작업의 후속 분석이므로, 여기서 문제가 생겨도 DONE 흐름 자체를 막으면 안 된다.
 * @param {object} task
 * @param {string} cwd askClaude 실행 시 필요한 cwd (runCommand의 PROJECT_ROOT 역할).
 *   이 분석 자체는 워크스페이스 파일을 읽거나 쓰지 않지만, commandGuard/pathGuard가
 *   cwd를 필수로 요구하므로 호출 시점의 워크스페이스 디렉토리를 그대로 전달한다.
 * @returns {Promise<{suitable: boolean, reason?: string, skillId?: string, name?: string,
 *   description?: string, triggers?: string[], agentType?: string, riskLevel?: string,
 *   requiredApproval?: boolean, allowedCommands?: string[], blockedCommands?: string[],
 *   promptMd?: string, checklistMd?: string}>}
 */
async function analyzeForSkillProposal(task, cwd) {
  try {
    const messages = await messageService.getTaskMessages(task.id);
    const transcript = messageService.formatMessages(messages);
    const existingSkills = await skillRegistry.listSkills();

    const systemPromptPath = path.join(__dirname, "../../prompts/skillDiscovery.md");
    const systemPrompt = fs.existsSync(systemPromptPath) ? fs.readFileSync(systemPromptPath, "utf8") : "";
    const userPrompt = buildAnalysisPrompt(task, transcript, existingSkills);
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const response = await askClaude(fullPrompt, { cwd, taskId: task.id });
    const parsed = extractJson(response);

    if (!parsed || typeof parsed !== "object") {
      logger.info(`[SkillDiscovery] task=${task.id} 응답 파싱 실패 - 스킬 제안 건너뜀`);
      return { suitable: false, reason: "응답 파싱 실패" };
    }
    if (!parsed.suitable) {
      logger.info(`[SkillDiscovery] task=${task.id} 재사용 가치 없음으로 판단: ${parsed.reason || "(이유 없음)"}`);
      return { suitable: false, reason: parsed.reason };
    }
    if (!isValidSkillId(parsed.skillId)) {
      logger.info(`[SkillDiscovery] task=${task.id} 유효하지 않은 skillId(${parsed.skillId}) - 건너뜀`);
      return { suitable: false, reason: "유효하지 않은 skillId" };
    }
    if (skillIdExists(parsed.skillId, existingSkills)) {
      logger.info(`[SkillDiscovery] task=${task.id} skillId(${parsed.skillId})가 이미 존재함 - 건너뜀`);
      return { suitable: false, reason: "skillId 중복" };
    }
    if (!parsed.promptMd || !parsed.checklistMd || !parsed.name || !parsed.description) {
      logger.info(`[SkillDiscovery] task=${task.id} 필수 필드 누락 - 건너뜀`);
      return { suitable: false, reason: "필수 필드 누락" };
    }

    return {
      suitable: true,
      skillId: parsed.skillId,
      name: String(parsed.name),
      description: String(parsed.description),
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String) : [],
      agentType: typeof parsed.agentType === "string" ? parsed.agentType : "coder",
      riskLevel: ["low", "medium", "high"].includes(parsed.riskLevel) ? parsed.riskLevel : "medium",
      requiredApproval: parsed.requiredApproval !== false,
      allowedCommands: Array.isArray(parsed.allowedCommands) ? parsed.allowedCommands.map(String) : [],
      blockedCommands: Array.isArray(parsed.blockedCommands) ? parsed.blockedCommands.map(String) : [],
      promptMd: String(parsed.promptMd),
      checklistMd: String(parsed.checklistMd),
    };
  } catch (err) {
    logger.error(`[SkillDiscovery] task=${task.id} 분석 실패`, err);
    return { suitable: false, reason: `분석 중 오류: ${err.message}` };
  }
}

/**
 * 승인된 skill 제안을 실제로 /skills/<skillId>/ 에 기록한다. LLM이 생성한 skillId는
 * 신뢰할 수 없는 입력이므로, 정규식 검증 + 최종 경로가 SKILLS_DIR 바로 아래인지를
 * 한 번 더 확인한다 (경로 이탈/기존 디렉토리 덮어쓰기 방지).
 * @param {object} proposal analyzeForSkillProposal이 반환한 suitable:true 객체
 * @returns {string} 생성된 skill 디렉토리 경로
 */
function writeSkillFiles(proposal) {
  if (!isValidSkillId(proposal.skillId)) {
    throw new Error(`유효하지 않은 skillId: ${proposal.skillId}`);
  }

  const skillDir = path.join(SKILLS_DIR, proposal.skillId);
  if (path.dirname(skillDir) !== SKILLS_DIR) {
    throw new Error(`skillId가 SKILLS_DIR 밖을 가리킵니다: ${proposal.skillId}`);
  }
  if (fs.existsSync(skillDir)) {
    throw new Error(`이미 존재하는 디렉토리입니다: ${proposal.skillId}`);
  }

  fs.mkdirSync(skillDir, { recursive: true });

  const skillJson = {
    id: proposal.skillId,
    name: proposal.name,
    description: proposal.description,
    triggers: proposal.triggers,
    agentType: proposal.agentType,
    riskLevel: proposal.riskLevel,
    requiredApproval: proposal.requiredApproval,
    allowedCommands: proposal.allowedCommands,
    blockedCommands: proposal.blockedCommands,
  };

  fs.writeFileSync(path.join(skillDir, "skill.json"), JSON.stringify(skillJson, null, 2), "utf8");
  fs.writeFileSync(path.join(skillDir, "prompt.md"), proposal.promptMd, "utf8");
  fs.writeFileSync(path.join(skillDir, "checklist.md"), proposal.checklistMd, "utf8");

  return skillDir;
}

/**
 * action='skill_creation'으로 열려 있는 PENDING 승인들 중, 제안 내용(agent_results에 저장된
 * skill_proposal)의 skillId가 일치하는 것을 찾는다. !approve-skill/!reject-skill이 어떤
 * task/제안을 가리키는지 알아내는 데 쓰인다.
 * @param {string} skillId
 * @returns {Promise<{taskId: string, proposal: object} | null>}
 */
async function findPendingProposalBySkillId(skillId) {
  const { rows } = await db.query(
    `SELECT a.task_id, ar.content
     FROM approvals a
     JOIN agent_results ar ON ar.task_id = a.task_id AND ar.result_type = 'skill_proposal'
     WHERE a.action = 'skill_creation' AND a.status = 'PENDING'
     ORDER BY ar.created_at DESC`
  );

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.content);
      if (parsed.skillId === skillId) {
        return { taskId: row.task_id, proposal: parsed };
      }
    } catch (err) {
      // 저장된 content가 손상되어 있으면 건너뛴다 (이 함수가 발생시킬 오류가 아님).
    }
  }
  return null;
}

module.exports = {
  analyzeForSkillProposal,
  writeSkillFiles,
  findPendingProposalBySkillId,
  isValidSkillId,
};
