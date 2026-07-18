const fs = require("fs");
const path = require("path");
const db = require("../db");

const SKILLS_DIR = path.join(__dirname, "../../skills");

/**
 * /skills 폴더를 스캔해 각 하위 디렉토리의 skill.json을 읽어온다.
 * skill.json이 없는 디렉토리는 건너뛴다.
 */
function scanSkills() {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }

  const dirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const skills = [];
  for (const dir of dirs) {
    const skillJsonPath = path.join(SKILLS_DIR, dir, "skill.json");
    if (!fs.existsSync(skillJsonPath)) continue;

    try {
      const raw = fs.readFileSync(skillJsonPath, "utf8");
      const skill = JSON.parse(raw);
      skills.push(skill);
    } catch (err) {
      throw new Error(`skill.json 파싱 실패 (${dir}): ${err.message}`);
    }
  }

  return skills;
}

/**
 * 스캔한 skill.json 내용을 skills 테이블과 동기화한다 (upsert).
 * 이미 DB에 있던 enabled 상태는 건드리지 않는다 (사용자가 끈 skill을 되살리지 않기 위함).
 */
async function syncSkills() {
  const skills = scanSkills();

  for (const skill of skills) {
    const triggerKeywords = (skill.triggers || []).join(",");
    const allowedCommands = skill.allowedCommands || [];
    const blockedCommands = skill.blockedCommands || [];
    const requiredApproval = skill.requiredApproval !== undefined ? skill.requiredApproval : true;

    await db.query(
      `INSERT INTO skills (id, name, description, trigger_keywords, agent_type, risk_level, allowed_commands, blocked_commands, required_approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         trigger_keywords = EXCLUDED.trigger_keywords,
         agent_type = EXCLUDED.agent_type,
         risk_level = EXCLUDED.risk_level,
         allowed_commands = EXCLUDED.allowed_commands,
         blocked_commands = EXCLUDED.blocked_commands,
         required_approval = EXCLUDED.required_approval,
         updated_at = CURRENT_TIMESTAMP`,
      [
        skill.id,
        skill.name,
        skill.description,
        triggerKeywords,
        skill.agentType,
        skill.riskLevel,
        allowedCommands,
        blockedCommands,
        requiredApproval,
      ]
    );
  }

  return skills;
}

/**
 * skills 테이블 전체 목록을 조회한다.
 */
async function listSkills() {
  const { rows } = await db.query("SELECT * FROM skills ORDER BY id");
  return rows;
}

/**
 * skill의 prompt.md/checklist.md 템플릿 파일을 로딩한다.
 * 에이전트에게 보낼 지시 콘텍스트에 병합할 때 사용하는 준비용 헬퍼.
 * 파일이 없으면 해당 필드는 빈 문자열로 반환한다.
 * @param {string} skillId
 * @returns {{prompt: string, checklist: string}}
 */
function loadSkillTemplates(skillId) {
  const skillDir = path.join(SKILLS_DIR, skillId);
  const promptPath = path.join(skillDir, "prompt.md");
  const checklistPath = path.join(skillDir, "checklist.md");

  return {
    prompt: fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "",
    checklist: fs.existsSync(checklistPath) ? fs.readFileSync(checklistPath, "utf8") : "",
  };
}

module.exports = {
  scanSkills,
  syncSkills,
  listSkills,
  loadSkillTemplates,
};
