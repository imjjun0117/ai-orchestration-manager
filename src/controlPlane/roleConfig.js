const crypto = require("node:crypto");

const ROLES = Object.freeze(["manager", "planner", "coder", "reviewer", "qa", "summarizer"]);
const MODES = Object.freeze(["off", "shadow", "enforced"]);
const ROLE_DEFINITIONS = Object.freeze({
  manager: { displayName: "AI Manager", engine: "orchestrator", commands: ["!task", "!autotask", "!team", "!health", "!roles", "!instance"] },
  planner: { displayName: "AI Planner", engine: "claude", commands: ["!pm"] },
  coder: { displayName: "AI Coder", engine: "codex", commands: ["!coder"] },
  reviewer: { displayName: "AI Reviewer", engine: "gemini", commands: ["!reviewer"] },
  qa: { displayName: "AI QA", engine: "test-runner", commands: ["!qa"] },
  summarizer: { displayName: "AI Summarizer", engine: "gemma", commands: ["!summary"] },
});

function required(name, value) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function roleMode(env = process.env) {
  const mode = String(env.MULTIBOT_ROLE_MODE || "off").trim().toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`MULTIBOT_ROLE_MODE must be one of: ${MODES.join(", ")}`);
  return mode;
}

function loadRoleConfig(env = process.env) {
  const role = required("BOT_ROLE", env.BOT_ROLE).toLowerCase();
  if (!ROLES.includes(role)) throw new Error(`BOT_ROLE must be one of: ${ROLES.join(", ")}`);
  const instanceId = required("BOT_INSTANCE_ID", env.BOT_INSTANCE_ID);
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(instanceId)) throw new Error("BOT_INSTANCE_ID contains unsupported characters");
  const definition = ROLE_DEFINITIONS[role];
  return Object.freeze({
    role,
    instanceId,
    mode: roleMode(env),
    agentEngine: String(env.AGENT_ENGINE || definition.engine).trim(),
    displayName: definition.displayName,
    databaseUrl: required("DATABASE_URL", env.DATABASE_URL),
    heartbeatMs: positiveInteger("BOT_HEARTBEAT_MS", env.BOT_HEARTBEAT_MS, 10_000),
    jobLeaseMs: positiveInteger("ROLE_JOB_LEASE_MS", env.ROLE_JOB_LEASE_MS, 60_000),
    jobPollMs: positiveInteger("ROLE_JOB_POLL_MS", env.ROLE_JOB_POLL_MS, 1_000),
    executionMode: executionMode(env),
  });
}

function positiveInteger(name, value, fallback) {
  const parsed = Number.parseInt(String(value || fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function executionMode(env = process.env) {
  const value = String(env.ROLE_WORKER_EXECUTION || "dry-run").trim().toLowerCase();
  if (!["disabled", "dry-run", "active"].includes(value)) {
    throw new Error("ROLE_WORKER_EXECUTION must be disabled, dry-run, or active");
  }
  return value;
}

function validateSixRoleSet(configs) {
  if (!Array.isArray(configs) || configs.length !== ROLES.length) throw new Error("exactly six role configurations are required");
  const roles = new Set();
  const instances = new Set();
  const fingerprints = new Set();
  for (const config of configs) {
    if (!ROLES.includes(config.role)) throw new Error(`unsupported role: ${config.role}`);
    if (roles.has(config.role)) throw new Error(`duplicate BOT_ROLE: ${config.role}`);
    if (instances.has(config.instanceId)) throw new Error(`duplicate BOT_INSTANCE_ID: ${config.instanceId}`);
    roles.add(config.role);
    instances.add(config.instanceId);
    if (config.tokenFingerprint) {
      if (fingerprints.has(config.tokenFingerprint)) throw new Error("Discord credentials must be distinct for all six roles");
      fingerprints.add(config.tokenFingerprint);
    }
  }
  for (const role of ROLES) if (!roles.has(role)) throw new Error(`missing BOT_ROLE: ${role}`);
  return true;
}

function credentialFingerprint(token) {
  return `sha256:${crypto.createHash("sha256").update(String(token)).digest("hex")}`;
}

module.exports = {
  MODES,
  ROLES,
  ROLE_DEFINITIONS,
  credentialFingerprint,
  executionMode,
  loadRoleConfig,
  roleMode,
  validateSixRoleSet,
};
