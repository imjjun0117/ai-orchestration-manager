const crypto = require("crypto");
const { execFileSync } = require("child_process");
const defaultDb = require("../db");
const {
  COMMIT_SHA_PATTERN,
  canonicalJson,
  normalizeRepositoryPath,
  sha256Bytes,
} = require("../delivery/canonicalSubmissionManifest");

function runGit(repositoryRoot, args, { encoding = "utf8" } = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolveCommit(repositoryRoot, commitSha) {
  if (!COMMIT_SHA_PATTERN.test(String(commitSha || ""))) throw new Error(`invalid commit SHA: ${commitSha}`);
  const resolved = runGit(repositoryRoot, ["rev-parse", "--verify", `${commitSha}^{commit}`]).trim();
  if (resolved !== commitSha) throw new Error(`commit ${commitSha} did not resolve exactly`);
  return resolved;
}

function verifyCandidateAncestry(repositoryRoot, baseCommitSha, candidateCommitSha) {
  resolveCommit(repositoryRoot, baseCommitSha);
  resolveCommit(repositoryRoot, candidateCommitSha);
  if (baseCommitSha === candidateCommitSha) throw new Error("candidate commit must differ from base commit");
  try {
    runGit(repositoryRoot, ["merge-base", "--is-ancestor", baseCommitSha, candidateCommitSha]);
  } catch (error) {
    throw new Error("base commit is not an ancestor of candidate commit");
  }
}

function changedPaths(repositoryRoot, baseCommitSha, candidateCommitSha) {
  const raw = runGit(
    repositoryRoot,
    ["diff", "--name-status", "--no-renames", "-z", baseCommitSha, candidateCommitSha],
    { encoding: null }
  );
  const fields = raw.toString("utf8").split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const relativePath = fields[index + 1];
    if (!relativePath) throw new Error("malformed git name-status output");
    changes.push({ status, path: normalizeRepositoryPath(relativePath) });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function candidateFileEntry(repositoryRoot, candidateCommitSha, change) {
  if (change.status === "D") return { path: change.path, changeType: "D", type: "deleted" };
  const line = runGit(repositoryRoot, ["ls-tree", candidateCommitSha, "--", change.path]).trim();
  const match = line.match(/^(\d{6})\s+(blob)\s+([0-9a-f]+)\t(.+)$/);
  if (!match || match[4] !== change.path) throw new Error(`candidate tree entry missing for ${change.path}`);
  const mode = match[1];
  const content = runGit(repositoryRoot, ["show", `${candidateCommitSha}:${change.path}`], { encoding: null });
  return {
    path: change.path,
    changeType: change.status,
    type: mode === "120000" ? "symlink" : "file",
    mode,
    sha256: sha256Bytes(content),
    size: content.length,
  };
}

function diffSummary(repositoryRoot, baseCommitSha, candidateCommitSha, files) {
  const raw = runGit(
    repositoryRoot,
    ["diff", "--numstat", "--no-renames", "-z", baseCommitSha, candidateCommitSha],
    { encoding: null }
  );
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (const record of raw.toString("utf8").split("\0").filter(Boolean)) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("malformed git numstat output");
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    if (added === "-" || deleted === "-") {
      binaryFiles += 1;
    } else {
      additions += Number.parseInt(added, 10);
      deletions += Number.parseInt(deleted, 10);
    }
  }
  return {
    changedFileCount: files.length,
    additions,
    deletions,
    binaryFiles,
    deletedFiles: files.filter((file) => file.changeType === "D").length,
  };
}

function buildCandidateArtifact({ repositoryRoot, taskId, baseCommitSha, candidateCommitSha, contextManifestHash }) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(contextManifestHash || ""))) {
    throw new Error("contextManifestHash must use sha256:<lowercase hex>");
  }
  verifyCandidateAncestry(repositoryRoot, baseCommitSha, candidateCommitSha);
  const diffBytes = runGit(
    repositoryRoot,
    ["diff", "--binary", "--no-ext-diff", baseCommitSha, candidateCommitSha],
    { encoding: null }
  );
  const files = changedPaths(repositoryRoot, baseCommitSha, candidateCommitSha)
    .map((change) => candidateFileEntry(repositoryRoot, candidateCommitSha, change));
  const summary = diffSummary(repositoryRoot, baseCommitSha, candidateCommitSha, files);
  const manifest = {
    schemaVersion: 1,
    artifactType: "CANDIDATE_COMMIT",
    taskId,
    baseCommitSha,
    candidateCommitSha,
    contextManifestHash,
    diffHash: sha256Bytes(diffBytes),
    summary,
    files,
  };
  return {
    manifest,
    artifactHash: sha256Bytes(Buffer.from(canonicalJson(manifest), "utf8")),
    diffHash: manifest.diffHash,
    files,
  };
}

function describeCandidateArtifact(candidateArtifact) {
  const { manifest, artifactHash, diffHash, files } = candidateArtifact;
  const summary = manifest.summary || {};
  const riskSignals = [];
  if (summary.deletedFiles > 0) riskSignals.push("DELETES_FILES");
  if (summary.binaryFiles > 0) riskSignals.push("CHANGES_BINARY_FILES");
  if (summary.changedFileCount > 20) riskSignals.push("LARGE_FILE_SET");
  if ((summary.additions || 0) + (summary.deletions || 0) > 1000) riskSignals.push("LARGE_DIFF");
  const changedPaths = files.map((file) => file.path);
  if (changedPaths.some((filePath) => /(^|\/)\.env(?:\.|$)|\.(?:pem|key)$/i.test(filePath))) {
    riskSignals.push("CHANGES_SENSITIVE_PATHS");
  }
  if (changedPaths.some((filePath) => /(^|\/)migrations?\//i.test(filePath))) {
    riskSignals.push("CHANGES_DATABASE_MIGRATION");
  }
  if (changedPaths.some((filePath) => filePath.startsWith(".github/workflows/"))) {
    riskSignals.push("CHANGES_CI_WORKFLOW");
  }
  if (changedPaths.some((filePath) => /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)$/.test(filePath))) {
    riskSignals.push("CHANGES_DEPENDENCY_LOCK");
  }
  return {
    artifactHash,
    diffHash,
    contextManifestHash: manifest.contextManifestHash,
    baseCommitSha: manifest.baseCommitSha,
    candidateCommitSha: manifest.candidateCommitSha,
    changedPaths,
    summary,
    riskSignals,
  };
}

async function storeCandidateArtifact(
  {
    artifactId = `artifact-${crypto.randomUUID()}`,
    taskId,
    workspaceId,
    isolatedWorkspaceId,
    createdBy,
    candidateArtifact,
  },
  { db = defaultDb } = {}
) {
  const { manifest, artifactHash, diffHash, files } = candidateArtifact;
  const { rows } = await db.query(
    `INSERT INTO artifacts(
       id, task_id, workspace_id, isolated_workspace_id, artifact_type,
       artifact_hash, diff_hash, context_manifest_hash, base_commit_sha,
       candidate_commit_sha, manifest_json, file_manifest_json, created_by
     ) VALUES ($1, $2, $3, $4, 'CANDIDATE_COMMIT', $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
     RETURNING *`,
    [
      artifactId,
      taskId,
      workspaceId,
      isolatedWorkspaceId,
      artifactHash,
      diffHash,
      manifest.contextManifestHash,
      manifest.baseCommitSha,
      manifest.candidateCommitSha,
      JSON.stringify(manifest),
      JSON.stringify(files),
      createdBy,
    ]
  );
  return rows[0];
}

async function getArtifact(artifactId, { db = defaultDb } = {}) {
  const { rows } = await db.query(`SELECT * FROM artifacts WHERE id = $1`, [artifactId]);
  return rows[0] || null;
}

module.exports = {
  buildCandidateArtifact,
  changedPaths,
  describeCandidateArtifact,
  diffSummary,
  getArtifact,
  resolveCommit,
  storeCandidateArtifact,
  verifyCandidateAncestry,
};
