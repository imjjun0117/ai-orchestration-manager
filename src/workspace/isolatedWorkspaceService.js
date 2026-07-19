const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const defaultDb = require("../db");
const { assertIsolatedWriteEnabled, isolatedWorkspaceMode } = require("./featureFlags");
const artifactService = require("./artifactService");
const workspaceLeaseService = require("./workspaceLeaseService");

const DEFAULT_ISOLATED_ROOT = path.join(os.tmpdir(), "ai-manager-isolated-workspaces");

function safeId(value, fallback = "workspace") {
  return String(value || fallback).trim().replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || fallback;
}

function runGit(repositoryRoot, args) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureIsolationRoot(isolationRoot, canonicalRepository) {
  fs.mkdirSync(isolationRoot, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync.native(isolationRoot);
  const realCanonical = fs.realpathSync.native(canonicalRepository);
  if (realRoot === realCanonical || realRoot.startsWith(`${realCanonical}${path.sep}`)) {
    throw new Error("isolated workspace root must not be inside the canonical repository");
  }
  if (realCanonical.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("canonical repository must not be inside the isolated workspace root");
  }
  return { realRoot, realCanonical };
}

function assertManagedWorkspacePath(workspacePath, isolationRoot = DEFAULT_ISOLATED_ROOT) {
  const realRoot = fs.realpathSync.native(isolationRoot);
  const resolved = path.resolve(workspacePath);
  const parent = fs.realpathSync.native(path.dirname(resolved));
  const managedPath = path.join(parent, path.basename(resolved));
  if (managedPath === realRoot || !managedPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("workspace path is outside the managed isolation root");
  }
  if (parent !== realRoot && !parent.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("workspace parent escapes the managed isolation root");
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error("refusing to manage a symbolic-link workspace path");
  }
  if (fs.existsSync(resolved)) {
    const realWorkspace = fs.realpathSync.native(resolved);
    if (!realWorkspace.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error("workspace path escapes the managed isolation root");
    }
    return realWorkspace;
  }
  return managedPath;
}

async function createIsolatedWorkspace(
  {
    isolatedWorkspaceId = `iw-${crypto.randomUUID()}`,
    taskId,
    canonicalRepository,
    baseCommitSha,
    ownerInstanceId,
    ownerOperationId,
    isolationRoot = process.env.ISOLATED_WORKSPACE_ROOT || DEFAULT_ISOLATED_ROOT,
    shadowMode = true,
    leaseTtlMs,
    metadata = {},
  },
  { db = defaultDb, env = process.env } = {}
) {
  if (!shadowMode) assertIsolatedWriteEnabled(env);
  const { realRoot, realCanonical } = ensureIsolationRoot(isolationRoot, canonicalRepository);
  artifactService.resolveCommit(realCanonical, baseCommitSha);
  const containerPath = fs.mkdtempSync(path.join(realRoot, `${safeId(taskId)}-`));
  const repositoryPath = path.join(containerPath, "repository");
  const workspaceId = `isolated:${isolatedWorkspaceId}`;
  let lease;
  try {
    execFileSync(
      "git",
      ["clone", "--quiet", "--no-local", "--no-hardlinks", realCanonical, repositoryPath],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }
    );
    runGit(repositoryPath, ["checkout", "--quiet", "--detach", baseCommitSha]);
    runGit(repositoryPath, ["remote", "remove", "origin"]);
    lease = await workspaceLeaseService.acquireLease(
      {
        workspaceId,
        ownerInstanceId,
        ownerTaskId: taskId,
        ownerOperationId,
        mode: "WRITE_EXCLUSIVE",
        ttlMs: leaseTtlMs,
        metadata: { isolatedWorkspaceId, shadowMode },
      },
      { db }
    );
    const { rows } = await db.query(
      `INSERT INTO isolated_workspaces(
         id, task_id, workspace_id, lease_id, lease_owner_operation_id,
         canonical_repository_path, workspace_path, base_commit_sha, status, metadata_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'READY', $9::jsonb)
       RETURNING *`,
      [
        isolatedWorkspaceId,
        taskId,
        workspaceId,
        lease.lease_id,
        ownerOperationId,
        realCanonical,
        repositoryPath,
        baseCommitSha,
        JSON.stringify({ ...metadata, shadowMode }),
      ]
    );
    await db.query(
      `INSERT INTO workspace_safety_events(workspace_id, task_id, isolated_workspace_id, event_type, actor_id, event_payload)
       VALUES ($1, $2, $3, 'ISOLATED_WORKSPACE_READY', $4, $5::jsonb)`,
      [workspaceId, taskId, isolatedWorkspaceId, ownerInstanceId, JSON.stringify({ baseCommitSha, shadowMode })]
    );
    return { workspace: rows[0], lease };
  } catch (error) {
    if (lease) {
      await workspaceLeaseService.releaseLease(
        {
          leaseId: lease.lease_id,
          ownerInstanceId,
          ownerOperationId,
          fencingToken: lease.fencing_token,
        },
        { db }
      ).catch(() => {});
    }
    assertManagedWorkspacePath(containerPath, realRoot);
    fs.rmSync(containerPath, { recursive: true, force: true });
    throw error;
  }
}

async function markWorkspaceActive(isolatedWorkspaceId, { db = defaultDb } = {}) {
  const { rows } = await db.query(
    `UPDATE isolated_workspaces
     SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'READY'
     RETURNING *`,
    [isolatedWorkspaceId]
  );
  if (!rows[0]) throw new Error("isolated workspace is not READY");
  return rows[0];
}

async function createCandidateArtifact(
  { isolatedWorkspaceId, contextManifestHash, createdBy, artifactId },
  { db = defaultDb } = {}
) {
  const { rows } = await db.query(`SELECT * FROM isolated_workspaces WHERE id = $1`, [isolatedWorkspaceId]);
  const workspace = rows[0];
  if (!workspace || !["READY", "ACTIVE"].includes(workspace.status)) {
    throw new Error("isolated workspace is not available for candidate creation");
  }
  const candidateCommitSha = runGit(workspace.workspace_path, ["rev-parse", "HEAD"]);
  const candidateArtifact = artifactService.buildCandidateArtifact({
    repositoryRoot: workspace.workspace_path,
    taskId: workspace.task_id,
    baseCommitSha: workspace.base_commit_sha,
    candidateCommitSha,
    contextManifestHash,
  });
  const artifact = await artifactService.storeCandidateArtifact(
    {
      artifactId,
      taskId: workspace.task_id,
      workspaceId: workspace.workspace_id,
      isolatedWorkspaceId,
      createdBy,
      candidateArtifact,
    },
    { db }
  );
  await db.query(
    `UPDATE isolated_workspaces
     SET candidate_commit_sha = $2, status = 'CANDIDATE_READY', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [isolatedWorkspaceId, candidateCommitSha]
  );
  return artifact;
}

async function cleanupIsolatedWorkspace(
  { isolatedWorkspaceId, ownerInstanceId, ownerOperationId, force = false },
  { db = defaultDb, isolationRoot = process.env.ISOLATED_WORKSPACE_ROOT || DEFAULT_ISOLATED_ROOT } = {}
) {
  const transition = force
    ? await db.query(
      `UPDATE isolated_workspaces
       SET status = 'CLEANUP_PENDING', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status <> 'CLEANED'
       RETURNING *`,
      [isolatedWorkspaceId]
    )
    : await db.query(
      `UPDATE isolated_workspaces w
       SET status = 'CLEANUP_PENDING', updated_at = CURRENT_TIMESTAMP
       FROM workspace_leases l
       WHERE w.id = $1
         AND w.lease_id = l.lease_id
         AND l.lease_owner_instance_id = $2
         AND l.lease_owner_operation_id = $3
         AND w.status IN ('READY', 'ACTIVE', 'CANDIDATE_READY', 'NEEDS_RECONCILIATION')
       RETURNING w.*`,
      [isolatedWorkspaceId, ownerInstanceId, ownerOperationId]
    );
  const workspace = transition.rows[0];
  if (!workspace) throw new Error("isolated workspace does not exist");
  const leaseRows = await db.query(`SELECT * FROM workspace_leases WHERE lease_id = $1`, [workspace.lease_id]);
  const lease = leaseRows.rows[0];
  const repositoryPath = assertManagedWorkspacePath(workspace.workspace_path, isolationRoot);
  const containerPath = assertManagedWorkspacePath(path.dirname(repositoryPath), isolationRoot);
  try {
    fs.rmSync(containerPath, { recursive: true, force: true });
    if (lease && !lease.released_at) {
      await workspaceLeaseService.releaseLease(
        {
          leaseId: lease.lease_id,
          ownerInstanceId: lease.lease_owner_instance_id,
          ownerOperationId: lease.lease_owner_operation_id,
          fencingToken: lease.fencing_token,
        },
        { db }
      );
    }
    const cleaned = await db.query(
      `UPDATE isolated_workspaces
       SET status = 'CLEANED', cleaned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, cleanup_error = NULL
       WHERE id = $1 RETURNING *`,
      [isolatedWorkspaceId]
    );
    await db.query(
      `INSERT INTO workspace_safety_events(workspace_id, task_id, isolated_workspace_id, event_type, actor_id)
       VALUES ($1, $2, $3, 'ISOLATED_WORKSPACE_CLEANED', $4)`,
      [workspace.workspace_id, workspace.task_id, isolatedWorkspaceId, ownerInstanceId]
    );
    return cleaned.rows[0];
  } catch (error) {
    await db.query(
      `UPDATE isolated_workspaces
       SET status = 'NEEDS_RECONCILIATION', cleanup_error = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [isolatedWorkspaceId, error.message]
    );
    throw error;
  }
}

async function listReconciliationCandidates({ db = defaultDb } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM isolated_workspaces
     WHERE status IN ('CLEANUP_PENDING', 'NEEDS_RECONCILIATION')
        OR (status <> 'CLEANED' AND NOT EXISTS (
          SELECT 1 FROM workspace_leases l
          WHERE l.lease_id = isolated_workspaces.lease_id
            AND l.released_at IS NULL
            AND l.expires_at > CURRENT_TIMESTAMP
        ))
     ORDER BY updated_at, id`
  );
  return rows.map((workspace) => ({
    ...workspace,
    pathExists: fs.existsSync(workspace.workspace_path),
    recommendedAction: fs.existsSync(workspace.workspace_path) ? "INSPECT_AND_CLEAN" : "MARK_CLEANED",
  }));
}

function runtimeIsolationState(env = process.env) {
  return {
    isolatedWorkspaceMode: isolatedWorkspaceMode(env),
    coderWriteEnabled: String(env.CODER_WRITE_ENABLED || "").toLowerCase() === "true",
    canonicalWriteFallback: false,
  };
}

module.exports = {
  DEFAULT_ISOLATED_ROOT,
  assertManagedWorkspacePath,
  cleanupIsolatedWorkspace,
  createCandidateArtifact,
  createIsolatedWorkspace,
  ensureIsolationRoot,
  listReconciliationCandidates,
  markWorkspaceActive,
  runtimeIsolationState,
  safeId,
};
