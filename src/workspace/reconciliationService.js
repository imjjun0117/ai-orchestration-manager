const fs = require("fs");
const { execFileSync } = require("child_process");
const defaultDb = require("../db");
const isolatedWorkspaceService = require("./isolatedWorkspaceService");

function requiredIncidentEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("incident evidence must be an object");
  }
  const incidentId = String(value.incidentId || "").trim();
  const rationale = String(value.rationale || "").trim();
  if (!incidentId || !rationale) throw new Error("incident evidence requires incidentId and rationale");
  return { ...value, incidentId, rationale };
}

function readCanonicalRef(repositoryRoot, targetRef) {
  return execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--verify", `${targetRef}^{commit}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function getWorkspaceReconciliationPlan(isolatedWorkspaceId, { db = defaultDb } = {}) {
  const { rows } = await db.query(
    `SELECT w.*, l.released_at AS lease_released_at, l.expires_at AS lease_expires_at
     FROM isolated_workspaces w
     LEFT JOIN workspace_leases l ON l.lease_id = w.lease_id
     WHERE w.id = $1`,
    [isolatedWorkspaceId]
  );
  const workspace = rows[0];
  if (!workspace) throw new Error("isolated workspace does not exist");
  const pathExists = fs.existsSync(workspace.workspace_path);
  return {
    isolatedWorkspaceId,
    taskId: workspace.task_id,
    currentStatus: workspace.status,
    pathExists,
    action: pathExists ? "OWNER_AWARE_CLEANUP" : "MARK_MISSING_WORKSPACE_CLEANED",
    expectedStatus: workspace.status,
    dryRun: true,
  };
}

async function reconcileWorkspace(
  { isolatedWorkspaceId, expectedStatus, actorId, incidentEvidence, apply = false },
  { db = defaultDb, isolationRoot } = {}
) {
  const plan = await getWorkspaceReconciliationPlan(isolatedWorkspaceId, { db });
  if (!apply) return plan;
  const evidence = requiredIncidentEvidence(incidentEvidence);
  if (plan.currentStatus !== expectedStatus) throw new Error("workspace reconciliation compare-and-set failed");
  if (plan.pathExists) {
    const cleaned = await isolatedWorkspaceService.cleanupIsolatedWorkspace({
      isolatedWorkspaceId,
      ownerInstanceId: actorId,
      ownerOperationId: `reconcile:${evidence.incidentId}`,
      force: true,
    }, { db, isolationRoot });
    return { ...plan, dryRun: false, result: cleaned };
  }

  const pool = typeof db.connect === "function" ? db : db.pool;
  if (!pool || typeof pool.connect !== "function") throw new Error("workspace reconciliation requires a transactional database pool");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT * FROM isolated_workspaces WHERE id = $1 FOR UPDATE`,
      [isolatedWorkspaceId]
    );
    const workspace = locked.rows[0];
    if (!workspace || workspace.status !== expectedStatus) {
      throw new Error("workspace reconciliation compare-and-set failed");
    }
    if (fs.existsSync(workspace.workspace_path)) {
      throw new Error("workspace path reappeared; rerun reconciliation planning");
    }
    const updated = await client.query(
      `UPDATE isolated_workspaces
       SET status = 'CLEANED', cleaned_at = CURRENT_TIMESTAMP, cleanup_error = NULL,
           updated_at = CURRENT_TIMESTAMP,
           metadata_json = metadata_json || jsonb_build_object('reconciliationEvidence', $3::jsonb)
       WHERE id = $1 AND status = $2
       RETURNING *`,
      [isolatedWorkspaceId, expectedStatus, JSON.stringify(evidence)]
    );
    if (!updated.rows[0]) throw new Error("workspace reconciliation compare-and-set failed");
    await client.query(
      `UPDATE workspace_leases SET released_at = COALESCE(released_at, CURRENT_TIMESTAMP)
       WHERE lease_id = $1`,
      [workspace.lease_id]
    );
    await client.query(
      `INSERT INTO workspace_safety_events(
         workspace_id, task_id, isolated_workspace_id, event_type, actor_id, event_payload
       ) VALUES ($1, $2, $3, 'MISSING_WORKSPACE_RECONCILED', $4, $5::jsonb)`,
      [workspace.workspace_id, workspace.task_id, workspace.id, actorId, JSON.stringify(evidence)]
    );
    await client.query("COMMIT");
    return { ...plan, dryRun: false, result: updated.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getFinalizationReconciliationPlan(finalizationId, { db = defaultDb } = {}) {
  const { rows } = await db.query(
    `SELECT f.*, w.canonical_repository_path
     FROM workspace_finalizations f
     JOIN artifacts a ON a.id = f.artifact_id
     JOIN isolated_workspaces w ON w.id = a.isolated_workspace_id
     WHERE f.id = $1`,
    [finalizationId]
  );
  const finalization = rows[0];
  if (!finalization) throw new Error("finalization does not exist");
  const observedRefSha = readCanonicalRef(finalization.canonical_repository_path, finalization.target_ref);
  let recommendedAction = "MANUAL_INSPECTION";
  if (observedRefSha === finalization.candidate_commit_sha) recommendedAction = "MARK_SUCCEEDED";
  if (observedRefSha === finalization.base_commit_sha) recommendedAction = "MARK_FAILED";
  return {
    finalizationId,
    taskId: finalization.task_id,
    currentStatus: finalization.status,
    expectedStatus: finalization.status,
    targetRef: finalization.target_ref,
    baseCommitSha: finalization.base_commit_sha,
    candidateCommitSha: finalization.candidate_commit_sha,
    observedRefSha,
    recommendedAction,
    dryRun: true,
  };
}

async function listFinalizationReconciliationCandidates({ db = defaultDb } = {}) {
  const { rows } = await db.query(
    `SELECT f.id
     FROM workspace_finalizations f
     LEFT JOIN workspace_leases l ON l.lease_id = f.lease_id
     WHERE f.status = 'NEEDS_RECONCILIATION'
        OR (f.status = 'CLAIMED' AND (l.released_at IS NOT NULL OR l.expires_at <= CURRENT_TIMESTAMP))
     ORDER BY f.updated_at, f.id`
  );
  const results = [];
  for (const row of rows) {
    try {
      results.push(await getFinalizationReconciliationPlan(row.id, { db }));
    } catch (error) {
      results.push({ finalizationId: row.id, recommendedAction: "MANUAL_INSPECTION", error: error.message });
    }
  }
  return results;
}

async function reconcileFinalization(
  { finalizationId, expectedStatus, terminalStatus, actorId, incidentEvidence, apply = false },
  { db = defaultDb } = {}
) {
  const plan = await getFinalizationReconciliationPlan(finalizationId, { db });
  if (!apply) return plan;
  const evidence = requiredIncidentEvidence(incidentEvidence);
  if (plan.currentStatus !== expectedStatus) throw new Error("finalization reconciliation compare-and-set failed");
  const terminal = String(terminalStatus || "").toUpperCase();
  if (terminal === "SUCCEEDED" && plan.observedRefSha !== plan.candidateCommitSha) {
    throw new Error("cannot mark SUCCEEDED because the canonical ref is not the approved candidate");
  }
  if (terminal === "FAILED" && plan.observedRefSha !== plan.baseCommitSha) {
    throw new Error("cannot mark FAILED because the canonical ref no longer equals the approved base");
  }
  const { rows } = await db.query(
    `SELECT * FROM reconcile_candidate_finalization($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      finalizationId,
      expectedStatus,
      terminal,
      terminal === "SUCCEEDED" ? plan.observedRefSha : null,
      JSON.stringify(evidence),
      actorId,
    ]
  );
  return { ...plan, dryRun: false, result: rows[0] };
}

module.exports = {
  getFinalizationReconciliationPlan,
  getWorkspaceReconciliationPlan,
  listFinalizationReconciliationCandidates,
  readCanonicalRef,
  reconcileFinalization,
  reconcileWorkspace,
  requiredIncidentEvidence,
};
