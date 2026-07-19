const crypto = require("crypto");
const { execFileSync } = require("child_process");
const defaultDb = require("../db");
const { assertIsolatedWriteEnabled } = require("./featureFlags");
const artifactService = require("./artifactService");

function runGit(repositoryRoot, args) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertTargetRef(targetRef) {
  const value = String(targetRef || "").trim();
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.endsWith("/")) {
    throw new Error(`unsafe target ref: ${targetRef}`);
  }
  return value;
}

function assertBareCanonicalRepository(repositoryRoot) {
  const isBare = runGit(repositoryRoot, ["rev-parse", "--is-bare-repository"]);
  if (isBare !== "true") {
    throw new Error("finalizer requires a bare canonical repository; non-bare fallback is forbidden");
  }
  return true;
}

async function claimFinalization(
  {
    finalizationId = `finalization-${crypto.randomUUID()}`,
    approvalId,
    artifactId,
    workspaceId,
    leaseId,
    ownerOperationId,
    fencingToken,
    baseCommitSha,
    candidateCommitSha,
    artifactHash,
    contextManifestHash,
    targetRef,
    claimToken = crypto.randomUUID(),
    actorId,
  },
  { db = defaultDb } = {}
) {
  const { rows } = await db.query(
    `SELECT * FROM claim_candidate_finalization(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
     )`,
    [
      finalizationId,
      approvalId,
      artifactId,
      workspaceId,
      leaseId,
      ownerOperationId,
      fencingToken,
      baseCommitSha,
      candidateCommitSha,
      artifactHash,
      contextManifestHash,
      assertTargetRef(targetRef),
      claimToken,
      actorId,
    ]
  );
  return rows[0];
}

async function completeFinalization(
  { finalizationId, claimToken, status, integratedCommitSha = null, errorMessage = null, actorId },
  { db = defaultDb } = {}
) {
  const { rows } = await db.query(
    `SELECT * FROM complete_candidate_finalization($1, $2, $3, $4, $5, $6)`,
    [finalizationId, claimToken, status, integratedCommitSha, errorMessage, actorId]
  );
  return rows[0];
}

async function finalizeCandidate(
  {
    approval,
    artifact,
    finalizerLease,
    ownerOperationId,
    actorId,
    candidateRepository,
    canonicalRepository,
    targetRef = "refs/heads/main",
  },
  { db = defaultDb, env = process.env } = {}
) {
  assertIsolatedWriteEnabled(env);
  assertBareCanonicalRepository(canonicalRepository);
  const safeTargetRef = assertTargetRef(targetRef);
  const rebuilt = artifactService.buildCandidateArtifact({
    repositoryRoot: candidateRepository,
    taskId: artifact.task_id,
    baseCommitSha: artifact.base_commit_sha,
    candidateCommitSha: artifact.candidate_commit_sha,
    contextManifestHash: artifact.context_manifest_hash,
  });
  if (rebuilt.artifactHash !== artifact.artifact_hash) {
    throw new Error("candidate artifact hash changed before finalization");
  }

  const claimToken = crypto.randomUUID();
  const finalizationId = `finalization-${crypto.randomUUID()}`;
  const claim = await claimFinalization(
    {
      finalizationId,
      approvalId: approval.id,
      artifactId: artifact.id,
      workspaceId: finalizerLease.workspace_id,
      leaseId: finalizerLease.lease_id,
      ownerOperationId,
      fencingToken: finalizerLease.fencing_token,
      baseCommitSha: artifact.base_commit_sha,
      candidateCommitSha: artifact.candidate_commit_sha,
      artifactHash: artifact.artifact_hash,
      contextManifestHash: artifact.context_manifest_hash,
      targetRef: safeTargetRef,
      claimToken,
      actorId,
    },
    { db }
  );

  let refUpdated = false;
  try {
    const currentHead = runGit(canonicalRepository, ["rev-parse", safeTargetRef]);
    if (currentHead !== artifact.base_commit_sha) {
      throw new Error(`canonical ref moved: expected ${artifact.base_commit_sha}, actual ${currentHead}`);
    }
    runGit(canonicalRepository, [
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
      candidateRepository, artifact.candidate_commit_sha,
    ]);
    const fetched = runGit(canonicalRepository, ["rev-parse", "--verify", `${artifact.candidate_commit_sha}^{commit}`]);
    if (fetched !== artifact.candidate_commit_sha) throw new Error("candidate commit was not imported exactly");
    runGit(canonicalRepository, ["update-ref", safeTargetRef, artifact.candidate_commit_sha, artifact.base_commit_sha]);
    refUpdated = true;
    return await completeFinalization(
      {
        finalizationId: claim.id,
        claimToken,
        status: "SUCCEEDED",
        integratedCommitSha: artifact.candidate_commit_sha,
        actorId,
      },
      { db }
    );
  } catch (error) {
    const terminalStatus = refUpdated ? "NEEDS_RECONCILIATION" : "FAILED";
    await completeFinalization(
      {
        finalizationId: claim.id,
        claimToken,
        status: terminalStatus,
        integratedCommitSha: refUpdated ? artifact.candidate_commit_sha : null,
        errorMessage: error.message,
        actorId,
      },
      { db }
    ).catch(() => {});
    throw error;
  }
}

module.exports = {
  assertBareCanonicalRepository,
  assertTargetRef,
  claimFinalization,
  completeFinalization,
  finalizeCandidate,
};
