const AGENT_DISPLAY = {
  manager: { emoji: "👑", name: "Manager" },
  planner: { emoji: "📋", name: "Planner" },
  coder: { emoji: "💻", name: "Coder" },
  reviewer: { emoji: "🔍", name: "Reviewer" },
  qa: { emoji: "🧪", name: "QA" },
};

/**
 * role(manager/planner/coder/reviewer/qa)에 맞는 이름/이모지를 붙여 war-room 대화체로 포맷한다.
 * @param {string} role
 * @param {string} content
 */
function formatAgentMessage(role, content) {
  const agent = AGENT_DISPLAY[role] || { emoji: "🤖", name: role };
  return `${agent.emoji} **${agent.name}**\n${content}`;
}

module.exports = {
  formatAgentMessage,
  AGENT_DISPLAY,
};
