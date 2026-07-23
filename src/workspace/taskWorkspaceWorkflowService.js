const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const defaultDb = require("../db");
const approvalService = require("../core/approvalService");
const { isSensitivePath } = require("../core/pathGuard");
const artifactService = require("./artifactService");
const { buildExecutionContextManifest } = require("./contextManifestService");
const finalizerService = require("./finalizerService");
const { assertPhase16WriteEnabled } = require("./featureFlags");
const isolatedWorkspaceService = require("./isolatedWorkspaceService");
const workspaceLeaseService = require("./workspaceLeaseService");

function runGit(repositoryRoot, args, { encoding = "utf8" } = {}) {
  const output = execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return Buffer.isBuffer(output) ? output : output.trim();
}

function canonicalWorkspaceId(repositoryRoot) {
  const realRepository = fs.realpathSync.native(repositoryRoot);
  const digest = crypto.createHash("sha256").update(realRepository, "utf8").digest("hex").slice(0, 24);
  return `canonical:${digest}`;
}

function globPattern(pattern) {
  const normalized = String(pattern || "").replaceAll("\\", "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function assertArtifactScope(candidateArtifact, contextManifest) {
  const allowedPaths = contextManifest.allowedPaths || [];
  if (allowedPaths.length === 0) throw new Error("candidate context requires at least one allowed path");
  const matchers = allowedPaths.map(globPattern);
  const rejected = candidateArtifact.files
    .map((entry) => entry.path)
    .filter((filePath) => !matchers.some((matcher) => matcher.test(filePath)));
  if (rejected.length > 0) {
    throw new Error(`candidate changed paths outside the approved scope: ${rejected.join(", ")}`);
  }
  const sensitive = candidateArtifact.files
    .map((entry) => entry.path)
    .filter((filePath) => filePath.split("/").some((segment) => isSensitivePath(segment)));
  if (sensitive.length > 0) {
    throw new Error(`candidate includes sensitive paths that cannot be approved: ${sensitive.join(", ")}`);
  }
  const constraints = contextManifest.constraints || {};
  const summary = candidateArtifact.manifest.summary;
  if (Number.isInteger(Number(constraints.maxChangedFiles))
      && summary.changedFileCount > Number(constraints.maxChangedFiles)) {
    throw new Error("candidate exceeds the approved changed-file limit");
  }
  if (Number.isInteger(Number(constraints.maxDiffLines))
      && summary.additions + summary.deletions > Number(constraints.maxDiffLines)) {
    throw new Error("candidate exceeds the approved diff-line limit");
  }
  return true;
}

async function getTaskSnapshot(taskId, { db = defaultDb } = {}) {
  const { rows } = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (!rows[0]) throw new Error(`task ${taskId} does not exist`);
  return rows[0];
}

async function transitionTaskState(
  { taskId, expectedState, expectedVersion, nextState, currentAgent = null },
  { db = defaultDb } = {}
) {
  const { rows } = await db.query(
    `UPDATE tasks
     SET status = $4, current_agent = $5, row_version = row_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = $2 AND row_version = $3
     RETURNING *`,
    [taskId, expectedState, expectedVersion, nextState, currentAgent]
  );
  if (!rows[0]) throw new Error(`task transition compare-and-set failed: ${expectedState}@${expectedVersion}`);
  return rows[0];
}

async function getLatestTaskWorkspace(taskId, { db = defaultDb } = {}) {
  const { rows } = await db.query(
    `SELECT w.*, l.lease_owner_instance_id, l.fencing_token AS workspace_fencing_token,
            l.released_at AS workspace_lease_released_at, l.expires_at AS workspace_lease_expires_at
     FROM isolated_workspaces w
     JOIN workspace_leases l ON l.lease_id = w.lease_id
     WHERE w.task_id = $1
       AND w.status <> 'CLEANED'
       AND l.mode = 'WRITE_EXCLUSIVE'
       AND l.released_at IS NULL
       AND l.expires_at > CURRENT_TIMESTAMP
     ORDER BY w.created_at DESC
     LIMIT 1`,
    [taskId]
  );
  return rows[0] || null;
}

async function prepareTaskWorkspace(
  {
    taskId,
    expectedTaskState,
    expectedTaskVersion,
    canonicalRepository,
    baseCommitSha,
    ownerInstanceId,
    ownerOperationId = `workspace-${crypto.randomUUID()}`,
    originalRequest,
    plan = null,
    instruction,
    role = "coder",
    allowedPaths,
    allowedTools = ["codex"],
    riskLevel = "unknown",
    constraints = {},
    memoryContextManifestHash = null,
    isolationRoot,
    leaseTtlMs = 30 * 60 * 1000,
    shadowMode = false,
  },
  { db = defaultDb, env = process.env } = {}
) {
  const task = await getTaskSnapshot(taskId, { db });
  if (task.status !== expectedTaskState || Number(task.row_version) !== Number(expectedTaskVersion)) {
    throw new Error(`task state/version changed: expected ${expectedTaskState}@${expectedTaskVersion}`);
  }
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new Error("prepare requires an explicit non-empty allowedPaths scope");
  }
  const context = buildExecutionContextManifest({
    taskId,
    originalRequest: originalRequest || task.original_request,
    plan,
    instruction,
    role,
    expectedTaskState,
    expectedTaskVersion,
    allowedPaths,
    allowedTools,
    riskLevel,
    constraints,
    memoryContextManifestHash,
  });
  const effectiveIsolationRoot = isolationRoot
    || env.ISOLATED_WORKSPACE_ROOT
    || isolatedWorkspaceService.DEFAULT_ISOLATED_ROOT;
  const created = await isolatedWorkspaceService.createIsolatedWorkspace({
    taskId,
    canonicalRepository,
    baseCommitSha,
    ownerInstanceId,
    ownerOperationId,
    isolationRoot: effectiveIsolationRoot,
    shadowMode,
    leaseTtlMs,
    metadata: {
      contextManifest: context.manifest,
      contextManifestHash: context.contextManifestHash,
      isolationRoot: path.resolve(effectiveIsolationRoot),
    },
  }, { db, env });
  const workspace = await isolatedWorkspaceService.markWorkspaceActive(created.workspace.id, { db });
  return { workspace, lease: created.lease, context };
}

async function runCoderStage(input, { db = defaultDb, env = process.env, runCoder } = {}) {
  if (typeof runCoder !== "function") throw new Error("runCoderStage requires a runCoder callback");
  const prepared = await prepareTaskWorkspace(input, { db, env });
  const heartbeatEveryMs = Math.max(1000, Math.min(60_000, Math.floor(Number(input.leaseTtlMs || 30 * 60 * 1000) / 3)));
  let heartbeatError = null;
  let heartbeatInFlight = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatInFlight || heartbeatError) return;
    heartbeatInFlight = true;
    try {
      await workspaceLeaseService.heartbeatLease({
        leaseId: prepared.lease.lease_id,
        ownerInstanceId: prepared.lease.lease_owner_instance_id,
        ownerOperationId: prepared.lease.lease_owner_operation_id,
        fencingToken: prepared.lease.fencing_token,
        ttlMs: Number(input.leaseTtlMs || 30 * 60 * 1000),
      }, { db });
    } catch (error) {
      heartbeatError = error;
    } finally {
      heartbeatInFlight = false;
    }
  }, heartbeatEveryMs);
  heartbeat.unref?.();
  try {
    const result = await runCoder({
      taskId: input.taskId,
      cwd: prepared.workspace.workspace_path,
      contextManifest: prepared.context.manifest,
      contextManifestHash: prepared.context.contextManifestHash,
    });
    if (heartbeatError) throw new Error(`workspace lease heartbeat failed during coder execution: ${heartbeatError.message}`);
    await workspaceLeaseService.heartbeatLease({
      leaseId: prepared.lease.lease_id,
      ownerInstanceId: prepared.lease.lease_owner_instance_id,
      ownerOperationId: prepared.lease.lease_owner_operation_id,
      fencingToken: prepared.lease.fencing_token,
      ttlMs: Number(input.leaseTtlMs || 30 * 60 * 1000),
    }, { db });
    return { ...prepared, result };
  } catch (error) {
    await db.query(
      `UPDATE isolated_workspaces
       SET status = 'NEEDS_RECONCILIATION', cleanup_error = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [prepared.workspace.id, error.message]
    ).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function commitWorkspaceChanges(workspace, commitMessage) {
  const repository = workspace.workspace_path;
  const status = runGit(repository, ["status", "--porcelain=v1", "-z"], { encoding: null });
  if (status.length > 0) {
    runGit(repository, ["add", "--all"]);
    runGit(repository, [
      "-c", "user.name=AI Manager Worker",
      "-c", "user.email=worker@ai-manager.invalid",
      "commit", "--quiet", "-m", String(commitMessage || `task: ${workspace.task_id}`).slice(0, 200),
    ]);
  }
  const candidateCommitSha = runGit(repository, ["rev-parse", "HEAD"]);
  if (candidateCommitSha === workspace.base_commit_sha) {
    throw new Error("candidate workspace has no committed changes");
  }
  return candidateCommitSha;
}

async function prepareCandidateApproval(
  {
    taskId,
    expectedTaskState,
    expectedTaskVersion,
    requestedBy,
    finalizerActorId,
    targetRef = "refs/heads/main",
    approvalTtlMs = 15 * 60 * 1000,
    finalizerLeaseTtlMs = 20 * 60 * 1000,
    commitMessage,
  },
  { db = defaultDb, env = process.env } = {}
) {
  await assertPhase16WriteEnabled({ db, env });
  const task = await getTaskSnapshot(taskId, { db });
  if (task.status !== expectedTaskState || Number(task.row_version) !== Number(expectedTaskVersion)) {
    throw new Error(`task state/version changed: expected ${expectedTaskState}@${expectedTaskVersion}`);
  }
  const workspace = await getLatestTaskWorkspace(taskId, { db });
  if (!workspace || !["ACTIVE", "READY"].includes(workspace.status)) {
    throw new Error("task has no active isolated workspace");
  }
  finalizerService.assertBareCanonicalRepository(workspace.canonical_repository_path);
  const contextManifest = workspace.metadata_json && workspace.metadata_json.contextManifest;
  const contextManifestHash = workspace.metadata_json && workspace.metadata_json.contextManifestHash;
  if (!contextManifest || !contextManifestHash) throw new Error("workspace context manifest is missing");

  const candidateCommitSha = commitWorkspaceChanges(workspace, commitMessage);
  const candidateArtifact = artifactService.buildCandidateArtifact({
    repositoryRoot: workspace.workspace_path,
    taskId,
    baseCommitSha: workspace.base_commit_sha,
    candidateCommitSha,
    contextManifestHash,
  });
  assertArtifactScope(candidateArtifact, contextManifest);
  const artifact = await artifactService.storeCandidateArtifact({
    taskId,
    workspaceId: workspace.workspace_id,
    isolatedWorkspaceId: workspace.id,
    createdBy: requestedBy,
    candidateArtifact,
  }, { db });
  await db.query(
    `UPDATE isolated_workspaces
     SET candidate_commit_sha = $2, status = 'CANDIDATE_READY', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status IN ('READY', 'ACTIVE')`,
    [workspace.id, candidateCommitSha]
  );

  const canonicalId = canonicalWorkspaceId(workspace.canonical_repository_path);
  const finalizerOperationId = `finalize-${crypto.randomUUID()}`;
  const finalizerLease = await workspaceLeaseService.acquireLease({
    workspaceId: canonicalId,
    ownerInstanceId: finalizerActorId,
    ownerTaskId: taskId,
    ownerOperationId: finalizerOperationId,
    mode: "FINALIZE_EXCLUSIVE",
    ttlMs: finalizerLeaseTtlMs,
    metadata: { artifactId: artifact.id, isolatedWorkspaceId: workspace.id },
  }, { db });
  try {
    const approval = await approvalService.openBoundApproval({
      taskId,
      action: "commit_approval_phase16",
      requestedBy,
      artifactId: artifact.id,
      artifactHash: artifact.artifact_hash,
      contextManifestHash: artifact.context_manifest_hash,
      baseCommitSha: artifact.base_commit_sha,
      candidateCommitSha: artifact.candidate_commit_sha,
      workspaceId: canonicalId,
      leaseOwnerOperationId: finalizerOperationId,
      fencingToken: finalizerLease.fencing_token,
      delegationScope: {
        allowedActorIds: [finalizerActorId],
        allowedTargetRefs: [finalizerService.assertTargetRef(targetRef)],
      },
      expectedTaskState,
      expectedTaskVersion,
      expiresAt: new Date(Date.now() + approvalTtlMs),
    }, { db });
    const display = await approvalService.getBoundApprovalDisplay({ approvalId: approval.id }, { db });
    return { workspace, artifact, finalizerLease, approval, display };
  } catch (error) {
    await workspaceLeaseService.releaseLease({
      leaseId: finalizerLease.lease_id,
      ownerInstanceId: finalizerLease.lease_owner_instance_id,
      ownerOperationId: finalizerLease.lease_owner_operation_id,
      fencingToken: finalizerLease.fencing_token,
    }, { db }).catch(() => {});
    throw error;
  }
}

async function approvalExecutionContext(approvalId, { db = defaultDb } = {}) {
  const { rows } = await db.query(
    `SELECT p.id AS approval_id, p.task_id, p.status AS approval_status,
            p.workspace_id AS finalizer_workspace_id,
            p.lease_owner_operation_id, p.fencing_token,
            p.expected_task_state, p.expected_task_version,
            p.delegation_scope, p.expires_at,
            a.id AS artifact_id, a.base_commit_sha, a.candidate_commit_sha,
            a.artifact_hash, a.context_manifest_hash,
            w.id AS isolated_workspace_id, w.canonical_repository_path, w.workspace_path,
            w.status AS isolated_workspace_status, w.cleanup_error AS isolated_workspace_cleanup_error,
            w.metadata_json AS workspace_metadata_json,
            w.lease_id AS isolated_lease_id,
            wl.lease_owner_instance_id AS isolated_owner_instance_id,
            wl.lease_owner_operation_id AS isolated_owner_operation_id,
            fl.lease_id AS finalizer_lease_id,
            fl.lease_owner_instance_id AS finalizer_owner_instance_id,
            fl.lease_owner_operation_id AS finalizer_owner_operation_id,
            fl.fencing_token AS finalizer_fencing_token,
            fl.expires_at AS finalizer_expires_at,
            fl.released_at AS finalizer_released_at
     FROM approvals p
     JOIN artifacts a ON a.id = p.artifact_id
     JOIN isolated_workspaces w ON w.id = a.isolated_workspace_id
     JOIN workspace_leases wl ON wl.lease_id = w.lease_id
     JOIN workspace_leases fl
       ON fl.workspace_id = p.workspace_id
      AND fl.lease_owner_operation_id = p.lease_owner_operation_id
      AND fl.fencing_token = p.fencing_token
     WHERE p.id = $1`,
    [approvalId]
  );
  if (!rows[0]) throw new Error("bound approval execution context does not exist");
  return rows[0];
}

async function settleCandidateTaskAndWorkspace(
  { context, taskStatus },
  { db = defaultDb } = {}
) {
  let task = await getTaskSnapshot(context.task_id, { db });
  if (task.status === context.expected_task_state
      && Number(task.row_version) === Number(context.expected_task_version)) {
    const transitioned = await db.query(
      `UPDATE tasks
       SET status = $4, control_state = 'RUNNING', row_version = row_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = $2 AND row_version = $3
       RETURNING *`,
      [context.task_id, context.expected_task_state, context.expected_task_version, taskStatus]
    );
    task = transitioned.rows[0] || await getTaskSnapshot(context.task_id, { db });
  }
  const taskSettled = task.status === taskStatus
    && Number(task.row_version) === Number(context.expected_task_version) + 1;

  let cleanup = null;
  let cleanupError = null;
  const workspace = await db.query(
    "SELECT status FROM isolated_workspaces WHERE id = $1",
    [context.isolated_workspace_id]
  );
  if (workspace.rows[0]?.status !== "CLEANED") {
    try {
      cleanup = await isolatedWorkspaceService.cleanupIsolatedWorkspace({
        isolatedWorkspaceId: context.isolated_workspace_id,
        ownerInstanceId: context.isolated_owner_instance_id,
        ownerOperationId: context.isolated_owner_operation_id,
      }, { db, isolationRoot: context.workspace_metadata_json.isolationRoot });
    } catch (error) {
      cleanupError = error.message;
    }
  }
  return {
    task,
    cleanup,
    reconciliationRequired: !taskSettled || Boolean(cleanupError),
    cleanupError,
  };
}

async function finalizeApprovedCandidate(
  { approvalId, resolvedBy, actorId, targetRef = null },
  { db = defaultDb, env = process.env } = {}
) {
  await assertPhase16WriteEnabled({ db, env });
  const display = await approvalService.getBoundApprovalDisplay({ approvalId }, { db });
  if (!display) throw new Error("bound approval does not exist");
  if (display.finalization) {
    const existing = await db.query(
      `SELECT f.*, w.status AS isolated_workspace_status
       FROM workspace_finalizations f
       JOIN artifacts a ON a.id = f.artifact_id
       LEFT JOIN isolated_workspaces w ON w.id = a.isolated_workspace_id
       WHERE f.id = $1`,
      [display.finalization.id]
    );
    if (existing.rows[0] && existing.rows[0].status === "SUCCEEDED") {
      const context = await approvalExecutionContext(approvalId, { db });
      const settlement = await settleCandidateTaskAndWorkspace({ context, taskStatus: "DONE" }, { db });
      return {
        finalization: existing.rows[0],
        ...settlement,
        alreadyCompleted: true,
      };
    }
    throw new Error(`approval already has finalization ${display.finalization.id} in ${display.finalization.status}`);
  }
  const chosenRef = finalizerService.assertTargetRef(targetRef || display.allowedTargetRefs[0]);
  if (!display.allowedActorIds.includes(actorId) || !display.allowedTargetRefs.includes(chosenRef)) {
    throw new Error("actor or target ref is outside the displayed approval delegation");
  }
  let approval;
  if (display.status === "PENDING") {
    ({ resolved: approval } = await approvalService.resolveDisplayedBoundApproval({
      approvalId,
      approved: true,
      resolvedBy,
    }, { db }));
  } else if (display.status === "APPROVED") {
    const context = await approvalExecutionContext(approvalId, { db });
    approval = { ...context, id: context.approval_id };
  } else {
    throw new Error(`approval cannot be finalized from status ${display.status}`);
  }
  const context = await approvalExecutionContext(approvalId, { db });
  const finalizerLease = {
    workspace_id: context.finalizer_workspace_id,
    lease_id: context.finalizer_lease_id,
    lease_owner_operation_id: context.finalizer_owner_operation_id,
    fencing_token: context.finalizer_fencing_token,
  };
  const artifact = {
    id: context.artifact_id,
    task_id: context.task_id,
    base_commit_sha: context.base_commit_sha,
    candidate_commit_sha: context.candidate_commit_sha,
    artifact_hash: context.artifact_hash,
    context_manifest_hash: context.context_manifest_hash,
  };
  const finalized = await finalizerService.finalizeCandidate({
    approval,
    artifact,
    finalizerLease,
    ownerOperationId: context.finalizer_owner_operation_id,
    actorId,
    candidateRepository: context.workspace_path,
    canonicalRepository: context.canonical_repository_path,
    targetRef: chosenRef,
  }, { db, env });
  const settlement = await settleCandidateTaskAndWorkspace({ context, taskStatus: "DONE" }, { db });
  return {
    finalization: finalized,
    ...settlement,
  };
}

async function rejectCandidateApproval(
  { approvalId, resolvedBy, reason = "candidate rejected" },
  { db = defaultDb } = {}
) {
  const display = await approvalService.getBoundApprovalDisplay({ approvalId }, { db });
  if (!display) throw new Error("bound approval does not exist");
  let resolved;
  if (display.status === "PENDING") {
    ({ resolved } = await approvalService.resolveDisplayedBoundApproval({
      approvalId,
      approved: false,
      resolvedBy,
      reason,
    }, { db }));
  } else if (display.status === "REJECTED") {
    resolved = { id: approvalId, status: "REJECTED" };
  } else {
    throw new Error(`approval cannot be rejected from status ${display.status}`);
  }
  const context = await approvalExecutionContext(approvalId, { db });
  if (!context.finalizer_released_at) {
    await workspaceLeaseService.releaseLease({
      leaseId: context.finalizer_lease_id,
      ownerInstanceId: context.finalizer_owner_instance_id,
      ownerOperationId: context.finalizer_owner_operation_id,
      fencingToken: context.finalizer_fencing_token,
    }, { db });
  }
  const settlement = await settleCandidateTaskAndWorkspace({ context, taskStatus: "REJECTED" }, { db });
  return { approval: resolved, ...settlement };
}

module.exports = {
  approvalExecutionContext,
  assertArtifactScope,
  canonicalWorkspaceId,
  commitWorkspaceChanges,
  finalizeApprovedCandidate,
  getLatestTaskWorkspace,
  getTaskSnapshot,
  globPattern,
  prepareCandidateApproval,
  prepareTaskWorkspace,
  rejectCandidateApproval,
  runCoderStage,
  settleCandidateTaskAndWorkspace,
  transitionTaskState,
};
