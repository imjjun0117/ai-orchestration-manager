const { roleMode } = require("./roleConfig");

async function getGateState(phaseId, { db } = {}) {
  if (!db || typeof db.query !== "function") throw new Error("Gate verification requires a database connection");
  const { rows } = await db.query("SELECT id, status, accepted_at FROM delivery_phases WHERE id = $1", [phaseId]);
  return rows[0] || null;
}

async function assertRoleModeAllowed({ db, env = process.env } = {}) {
  const mode = roleMode(env);
  if (mode === "off") return { mode, phase: null };
  const predecessor = await getGateState("phase-16", { db });
  if (!predecessor || !["ACCEPTED", "ACCEPTED_WITH_DEBT"].includes(predecessor.status)) {
    throw new Error(`Phase 16 Gate must be accepted before role mode ${mode}`);
  }
  if (mode === "shadow") return { mode, phase: predecessor };
  const phase = await getGateState("phase-17", { db });
  if (!phase || !["ACCEPTED", "ACCEPTED_WITH_DEBT"].includes(phase.status)) {
    throw new Error("MULTIBOT_ROLE_MODE=enforced requires Phase 17 Gate acceptance");
  }
  return { mode, phase };
}

module.exports = { assertRoleModeAllowed, getGateState };
