const db = require("../db");
const claudeAdapter = require("../adapters/claudeAdapter");
const codexAdapter = require("../adapters/codexAdapter");
const geminiAdapter = require("../adapters/geminiAdapter");
const gemmaAdapter = require("../adapters/gemmaAdapter");

const ROLE_CAPABILITY = Object.freeze({
  pm: "canPlan",
  coder: "canExec",
  reviewer: "canReview",
  qa: "canExec",
  summarizer: "canSummarize",
});

const ADAPTERS = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  gemma: gemmaAdapter,
});

const VALID_ROLES = Object.freeze(Object.keys(ROLE_CAPABILITY));
const VALID_AGENTS = Object.freeze(Object.keys(ADAPTERS));

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function assertValidRole(role) {
  const normalized = normalize(role);
  if (!ROLE_CAPABILITY[normalized]) {
    throw new Error(`지원하지 않는 역할입니다: ${role}`);
  }
  return normalized;
}

function assertValidAgent(agentName) {
  const normalized = normalize(agentName);
  const adapter = ADAPTERS[normalized];
  if (!adapter) {
    throw new Error(`지원하지 않는 에이전트입니다: ${agentName}`);
  }
  return { agentName: normalized, adapter };
}

function capabilityForRole(role) {
  const normalized = assertValidRole(role);
  return ROLE_CAPABILITY[normalized];
}

function assertAgentCanServeRole(role, agentName) {
  const normalizedRole = assertValidRole(role);
  const requiredCapability = capabilityForRole(normalizedRole);
  const { agentName: normalizedAgent, adapter } = assertValidAgent(agentName);

  if (!adapter.capabilities || adapter.capabilities[requiredCapability] !== true) {
    throw new Error(
      `${normalizedAgent} 에이전트는 ${normalizedRole} 역할에 필요한 ${requiredCapability} capability가 없습니다.`
    );
  }

  return {
    role: normalizedRole,
    agentName: normalizedAgent,
    adapter,
    requiredCapability,
  };
}

async function resolveAgent(role) {
  const normalizedRole = assertValidRole(role);
  const result = await db.query(
    "SELECT role, agent_name FROM role_bindings WHERE role = $1",
    [normalizedRole]
  );

  if (result.rowCount === 0) {
    throw new Error(`${normalizedRole} 역할 바인딩을 찾을 수 없습니다.`);
  }

  return assertAgentCanServeRole(result.rows[0].role, result.rows[0].agent_name);
}

async function setRoleBinding(role, agentName, updatedBy) {
  const binding = assertAgentCanServeRole(role, agentName);
  const result = await db.query(
    `
      INSERT INTO role_bindings (role, agent_name, updated_by, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (role)
      DO UPDATE SET
        agent_name = EXCLUDED.agent_name,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING role, agent_name, updated_by, updated_at
    `,
    [binding.role, binding.agentName, updatedBy || null]
  );

  return {
    ...binding,
    row: result.rows[0],
  };
}

async function listRoleBindings() {
  const result = await db.query(
    "SELECT role, agent_name, updated_by, updated_at FROM role_bindings ORDER BY role"
  );
  const rowByRole = new Map(result.rows.map(row => [row.role, row]));

  return VALID_ROLES.map(role => {
    const row = rowByRole.get(role);
    const requiredCapability = capabilityForRole(role);
    const adapter = row ? ADAPTERS[normalize(row.agent_name)] : null;
    return {
      role,
      agentName: row ? normalize(row.agent_name) : null,
      requiredCapability,
      adapter,
      capabilities: adapter ? adapter.capabilities : null,
      updatedBy: row ? row.updated_by : null,
      updatedAt: row ? row.updated_at : null,
      valid: Boolean(adapter && adapter.capabilities && adapter.capabilities[requiredCapability] === true),
    };
  });
}

module.exports = {
  VALID_ROLES,
  VALID_AGENTS,
  ROLE_CAPABILITY,
  ADAPTERS,
  capabilityForRole,
  resolveAgent,
  setRoleBinding,
  listRoleBindings,
  _internal: {
    normalize,
    assertAgentCanServeRole,
  },
};
