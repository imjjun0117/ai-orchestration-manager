const fs = require("fs");
const path = require("path");
const defaultDb = require("../db");
const { assertIsolatedWriteEnabled, assertPhase16WriteEnabled } = require("./featureFlags");
const { DEFAULT_ISOLATED_ROOT } = require("./isolatedWorkspaceService");

const WRITE_CAPABLE_AGENTS = Object.freeze(new Set(["coder", "codex", "qa"]));

function policyError(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "WORKSPACE_POLICY_BLOCKED";
  return error;
}

function requiresIsolatedWorkspace(agentName) {
  return WRITE_CAPABLE_AGENTS.has(String(agentName || "").trim().toLowerCase());
}

function assertAgentWorkspace({ agentName, cwd, env = process.env }) {
  if (!requiresIsolatedWorkspace(agentName)) return { enforced: false };
  assertIsolatedWriteEnabled(env);
  const isolationRoot = env.ISOLATED_WORKSPACE_ROOT || DEFAULT_ISOLATED_ROOT;
  if (!fs.existsSync(isolationRoot)) throw new Error("isolated workspace root does not exist");
  const realRoot = fs.realpathSync.native(isolationRoot);
  const realCwd = fs.realpathSync.native(cwd);
  if (realCwd === realRoot || !realCwd.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`${agentName} execution requires a task-isolated workspace; canonical fallback is forbidden`);
  }
  return { enforced: true, realRoot, realCwd };
}

async function assertRegisteredAgentWorkspace(
  { agentName, taskId, cwd, env = process.env },
  { db = defaultDb } = {}
) {
  let pathPolicy;
  try {
    pathPolicy = assertAgentWorkspace({ agentName, cwd, env });
  } catch (error) {
    throw policyError(error.message, error);
  }
  if (!pathPolicy.enforced) return pathPolicy;
  if (!String(taskId || "").trim()) {
    throw policyError(`${agentName} execution requires a task ID and registered isolated workspace`);
  }
  let rows;
  try {
    await assertPhase16WriteEnabled({ db, env });
    ({ rows } = await db.query(
      `SELECT w.id, w.workspace_id, w.lease_owner_operation_id, l.fencing_token
       FROM isolated_workspaces w
       JOIN workspace_leases l ON l.lease_id = w.lease_id
       WHERE w.task_id = $1
         AND w.workspace_path = $2
         AND w.status IN ('READY', 'ACTIVE', 'CANDIDATE_READY')
         AND l.mode = 'WRITE_EXCLUSIVE'
         AND l.released_at IS NULL
         AND l.expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
      [taskId, pathPolicy.realCwd]
    ));
  } catch (error) {
    throw policyError(`registered isolated workspace verification failed: ${error.message}`, error);
  }
  if (!rows[0]) {
    throw policyError(`${agentName} execution requires a live registered task workspace and write lease`);
  }
  return { ...pathPolicy, registration: rows[0] };
}

module.exports = {
  WRITE_CAPABLE_AGENTS,
  assertAgentWorkspace,
  assertRegisteredAgentWorkspace,
  policyError,
  requiresIsolatedWorkspace,
};
