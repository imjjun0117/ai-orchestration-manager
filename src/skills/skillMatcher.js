const db = require("../db");

/**
 * 사용자 요청 텍스트에서 trigger_keywords가 가장 많이 매칭되는 skill을 선택한다.
 * 매칭되는 keyword가 하나도 없으면 null을 반환한다 (generic 취급).
 * @param {string} requestText
 */
async function matchSkill(requestText) {
  const { rows } = await db.query("SELECT * FROM skills WHERE enabled = true");

  const normalizedRequest = (requestText || "").toLowerCase();

  let bestSkill = null;
  let bestScore = 0;

  for (const skill of rows) {
    const keywords = (skill.trigger_keywords || "")
      .split(",")
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean);

    const score = keywords.filter((keyword) => normalizedRequest.includes(keyword)).length;

    if (score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  return bestSkill;
}

module.exports = {
  matchSkill,
};
