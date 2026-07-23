const { roleMode } = require("./roleConfig");
const { memoryMode } = require("../memory/memoryPolicy");

async function getGateState(phaseId, { db } = {}) {
  if (!db || typeof db.query !== "function") throw new Error("Gate verification requires a database connection");
  const { rows } = await db.query("SELECT id, status, accepted_at FROM delivery_phases WHERE id = $1", [phaseId]);
  return rows[0] || null;
}

async function getTieredMemoryShadowQuality({ db, minimumReports = 5 } = {}) {
  if (!db || typeof db.query !== "function") throw new Error("shadow quality verification requires a database connection");
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS reports,
            COUNT(DISTINCT role)::int AS covered_roles,
            COUNT(DISTINCT role) FILTER (WHERE selection.non_short_items > 0)::int AS memory_roles,
            COUNT(*) FILTER (WHERE status = 'FALLBACK')::int AS fallbacks,
            COALESCE(SUM(selection.non_short_items), 0)::int AS non_short_selected_items
     FROM memory_context_manifests manifest
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS non_short_items
       FROM jsonb_array_elements(manifest.manifest_json->'entries') entry
       WHERE entry->>'tier' <> 'SHORT'
     ) selection
     WHERE mode = 'shadow'`
  );
  const state = rows[0] || {
    reports: 0, covered_roles: 0, memory_roles: 0, fallbacks: 0, non_short_selected_items: 0,
  };
  return {
    ...state,
    ready: Number(state.reports) >= minimumReports
      && Number(state.covered_roles) >= 5
      && Number(state.memory_roles) >= 5
      && Number(state.fallbacks) === 0
      && Number(state.non_short_selected_items) >= minimumReports,
  };
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

async function assertTieredMemoryModeAllowed({ db, env = process.env } = {}) {
  const mode = memoryMode(env);
  if (mode === "off") return { mode, phase: null };
  const predecessor = await getGateState("phase-17", { db });
  if (!predecessor || !["ACCEPTED", "ACCEPTED_WITH_DEBT"].includes(predecessor.status)) {
    throw new Error(`Phase 17 Gate must be accepted before tiered memory mode ${mode}`);
  }
  if (mode === "shadow") return { mode, phase: predecessor };
  const phase = await getGateState("phase-18", { db });
  if (!phase || !["ACCEPTED", "ACCEPTED_WITH_DEBT"].includes(phase.status)) {
    throw new Error("TIERED_MEMORY_MODE=enforced requires Phase 18 Gate acceptance");
  }
  const quality = await getTieredMemoryShadowQuality({ db });
  if (!quality.ready) {
    throw new Error("TIERED_MEMORY_MODE=enforced requires successful five-role shadow quality evidence");
  }
  return { mode, phase, shadowQuality: quality };
}

module.exports = {
  assertRoleModeAllowed,
  assertTieredMemoryModeAllowed,
  getGateState,
  getTieredMemoryShadowQuality,
};
