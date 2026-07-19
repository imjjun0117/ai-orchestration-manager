function enabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function isolatedWorkspaceMode(env = process.env) {
  return enabled(env.ISOLATED_WORKSPACE_MODE);
}

function coderWriteEnabled(env = process.env) {
  return enabled(env.CODER_WRITE_ENABLED);
}

function assertIsolatedWriteEnabled(env = process.env) {
  if (!isolatedWorkspaceMode(env)) {
    throw new Error("ISOLATED_WORKSPACE_MODE=true is required; canonical write fallback is forbidden");
  }
  if (!coderWriteEnabled(env)) {
    throw new Error("CODER_WRITE_ENABLED=true is required after Phase 16 Gate acceptance");
  }
  return true;
}

async function getPhase16GateState({ db } = {}) {
  if (!db || typeof db.query !== "function") {
    throw new Error("Phase 16 Gate verification requires a database connection");
  }
  const { rows } = await db.query(
    `SELECT id, status, accepted_at
     FROM delivery_phases
     WHERE id = 'phase-16'`
  );
  return rows[0] || null;
}

async function assertPhase16WriteEnabled({ db, env = process.env } = {}) {
  assertIsolatedWriteEnabled(env);
  const phase = await getPhase16GateState({ db });
  if (!phase || phase.status !== "ACCEPTED") {
    const status = phase ? phase.status : "NOT_FOUND";
    throw new Error(`Phase 16 Gate must be ACCEPTED before isolated writes are enabled (current: ${status})`);
  }
  return phase;
}

module.exports = {
  assertIsolatedWriteEnabled,
  assertPhase16WriteEnabled,
  coderWriteEnabled,
  enabled,
  getPhase16GateState,
  isolatedWorkspaceMode,
};
