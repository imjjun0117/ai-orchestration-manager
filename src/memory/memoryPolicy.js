const MEMORY_TIERS = Object.freeze(["LONG", "EPISODIC", "SHORT"]);
const SECURITY_CLASSIFICATIONS = Object.freeze(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]);
const RETRIEVAL_ROLES = Object.freeze(["planner", "coder", "reviewer", "qa", "summarizer"]);
const MEMORY_MODES = Object.freeze(["off", "shadow", "enforced"]);

const ROLE_TOKEN_BUDGETS = Object.freeze({
  planner: 3_000,
  coder: 4_000,
  reviewer: 4_000,
  qa: 2_000,
  summarizer: 3_000,
});

function boundedInteger(name, value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value === undefined || value === null || value === "" ? fallback : value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function memoryMode(env = process.env) {
  const mode = String(env.TIERED_MEMORY_MODE || "off").trim().toLowerCase();
  if (!MEMORY_MODES.includes(mode)) {
    throw new Error(`TIERED_MEMORY_MODE must be one of: ${MEMORY_MODES.join(", ")}`);
  }
  return mode;
}

function roleTokenBudget(role, env = process.env) {
  if (!RETRIEVAL_ROLES.includes(role)) throw new Error(`unsupported memory retrieval role: ${role}`);
  const roleKey = `MEMORY_TOKEN_BUDGET_${role.toUpperCase()}`;
  return boundedInteger(roleKey, env[roleKey], ROLE_TOKEN_BUDGETS[role], 256, 32_000);
}

function loadMemoryPolicy(role, env = process.env) {
  return Object.freeze({
    mode: memoryMode(env),
    role,
    tokenBudget: roleTokenBudget(role, env),
    candidateLimit: boundedInteger("MEMORY_CANDIDATE_LIMIT", env.MEMORY_CANDIDATE_LIMIT, 40, 1, 100),
    selectedLimit: boundedInteger("MEMORY_SELECTED_LIMIT", env.MEMORY_SELECTED_LIMIT, 12, 1, 30),
    retrievalTimeoutMs: boundedInteger("MEMORY_RETRIEVAL_TIMEOUT_MS", env.MEMORY_RETRIEVAL_TIMEOUT_MS, 2_000, 100, 30_000),
    concurrency: boundedInteger("MEMORY_RETRIEVAL_CONCURRENCY", env.MEMORY_RETRIEVAL_CONCURRENCY, 2, 1, 16),
    queueLimit: boundedInteger("MEMORY_RETRIEVAL_QUEUE_LIMIT", env.MEMORY_RETRIEVAL_QUEUE_LIMIT, 8, 0, 128),
    chunkTokens: boundedInteger("MEMORY_CHUNK_TOKENS", env.MEMORY_CHUNK_TOKENS, 512, 64, 4_096),
    chunkOverlapTokens: boundedInteger("MEMORY_CHUNK_OVERLAP_TOKENS", env.MEMORY_CHUNK_OVERLAP_TOKENS, 48, 0, 512),
  });
}

function normalizedIdentifier(name, value, maximum = 160) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || !/^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]*$/.test(normalized)) {
    throw new Error(`${name} contains unsupported characters or length`);
  }
  if (normalized.split("/").includes("..")) throw new Error(`${name} cannot contain parent traversal`);
  return normalized;
}

function taskProjectKey(task) {
  if (task && String(task.memory_project_key || "").trim()) {
    return normalizedIdentifier("memory project key", task.memory_project_key, 200);
  }
  if (task && String(task.channel_id || "").trim()) {
    return normalizedIdentifier("memory project key", `discord-channel:${task.channel_id}`, 200);
  }
  if (task && String(task.id || "").trim()) {
    return normalizedIdentifier("memory project key", `task:${task.id}`, 200);
  }
  throw new Error("task project key cannot be derived");
}

module.exports = {
  MEMORY_MODES,
  MEMORY_TIERS,
  RETRIEVAL_ROLES,
  ROLE_TOKEN_BUDGETS,
  SECURITY_CLASSIFICATIONS,
  boundedInteger,
  loadMemoryPolicy,
  memoryMode,
  normalizedIdentifier,
  roleTokenBudget,
  taskProjectKey,
};
