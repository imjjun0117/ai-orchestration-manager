const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UNAVAILABLE_COMMIT_PATTERN = /^UNAVAILABLE:[a-z0-9][a-z0-9._-]*$/;

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function canonicalizeValue(value, location = "$") {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${location} contains a non-finite number`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeValue(item, `${location}[${index}]`));
  }

  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`${location}.${key} contains an unsupported value`);
      }
      result[key] = canonicalizeValue(item, `${location}.${key}`);
    }
    return result;
  }

  throw new TypeError(`${location} contains an unsupported value`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalizeValue(value));
}

function sha256Bytes(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function hashCanonicalJson(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function normalizeRepositoryPath(input) {
  const raw = String(input || "").trim().replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`repository path must be relative: ${input}`);
  }

  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`repository path escapes the root: ${input}`);
  }
  return normalized.replace(/^\.\//, "");
}

function assertHash(value, label) {
  if (!HASH_PATTERN.test(String(value || ""))) {
    throw new Error(`${label} must use sha256:<lowercase hex>`);
  }
}

function normalizeCommitSha(value, label, { allowUnavailableCommits = false } = {}) {
  const normalized = String(value || "").trim();
  if (COMMIT_SHA_PATTERN.test(normalized)) return normalized;
  if (allowUnavailableCommits && UNAVAILABLE_COMMIT_PATTERN.test(normalized)) return normalized;
  throw new Error(`${label} must be a 40- or 64-character lowercase Git commit SHA`);
}

function git(repositoryRoot, args) {
  try {
    return childProcess.execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || "git command failed").trim();
    throw new Error(`authoritative Git verification failed: ${detail}`);
  }
}

function verifyRepositoryCommitBinding(manifest, repositoryRoot) {
  const canonicalManifest = buildSubmissionManifest(manifest);
  const root = fs.realpathSync.native(path.resolve(String(repositoryRoot || "")));
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error("authoritative repository is not a Git worktree");
  }
  for (const [label, commitSha] of [
    ["baseCommitSha", canonicalManifest.baseCommitSha],
    ["candidateCommitSha", canonicalManifest.candidateCommitSha],
  ]) {
    git(root, ["cat-file", "-e", `${commitSha}^{commit}`]);
    const resolved = git(root, ["rev-parse", `${commitSha}^{commit}`]);
    if (resolved !== commitSha) throw new Error(`${label} does not resolve to the exact manifest commit`);
  }
  if (canonicalManifest.baseCommitSha === canonicalManifest.candidateCommitSha) {
    throw new Error("baseCommitSha and candidateCommitSha must be different commits");
  }
  git(root, ["merge-base", "--is-ancestor", canonicalManifest.baseCommitSha, canonicalManifest.candidateCommitSha]);
  return {
    repositoryRoot: root,
    baseCommitSha: canonicalManifest.baseCommitSha,
    candidateCommitSha: canonicalManifest.candidateCommitSha,
  };
}

function normalizeFileEntry(entry) {
  assertPlainObject(entry, "file entry");
  const normalized = {
    path: normalizeRepositoryPath(entry.path),
    sha256: String(entry.sha256 || ""),
    mode: String(entry.mode || ""),
    type: String(entry.type || "file"),
  };
  assertHash(normalized.sha256, `file ${normalized.path} hash`);
  if (!/^[0-7]{6}$/.test(normalized.mode)) {
    throw new Error(`file ${normalized.path} mode must be a six-digit octal string`);
  }
  if (!['file', 'symlink'].includes(normalized.type)) {
    throw new Error(`file ${normalized.path} has unsupported type ${normalized.type}`);
  }
  if (normalized.type === "symlink") {
    normalized.linkTarget = String(entry.linkTarget || "");
    if (!normalized.linkTarget) {
      throw new Error(`symlink ${normalized.path} must include linkTarget`);
    }
  }
  return normalized;
}

function sortUniqueByPath(entries, label) {
  const normalized = entries.map(normalizeFileEntry).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new Error(`${label} contains duplicate path ${normalized[index].path}`);
    }
  }
  return normalized;
}

function normalizeEvidenceEntry(entry) {
  assertPlainObject(entry, "test evidence entry");
  const normalized = {
    id: String(entry.id || "").trim(),
    sha256: String(entry.sha256 || ""),
  };
  if (!normalized.id) throw new Error("test evidence entry requires id");
  assertHash(normalized.sha256, `test evidence ${normalized.id} hash`);
  return normalized;
}

function buildSubmissionManifest(input, options = {}) {
  assertPlainObject(input, "submission manifest input");
  const schemaVersion = Number(input.schemaVersion);
  const submissionRound = Number(input.submissionRound);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error("schemaVersion must be a positive integer");
  if (!Number.isInteger(submissionRound) || submissionRound < 1) throw new Error("submissionRound must be a positive integer");

  const phaseId = String(input.phaseId || "").trim();
  const submittedBy = String(input.submittedBy || "").trim();
  if (!phaseId || !submittedBy) {
    throw new Error("phaseId, submittedBy, baseCommitSha, and candidateCommitSha are required");
  }
  const baseCommitSha = normalizeCommitSha(input.baseCommitSha, "baseCommitSha", options);
  const candidateCommitSha = normalizeCommitSha(input.candidateCommitSha, "candidateCommitSha", options);

  const scalarHashes = {
    requirementsTraceHash: input.requirementsTraceHash,
    rollbackPlanHash: input.rollbackPlanHash,
    knownIssuesHash: input.knownIssuesHash,
  };
  for (const [key, value] of Object.entries(scalarHashes)) assertHash(value, key);

  const testEvidence = (input.testEvidence || [])
    .map(normalizeEvidenceEntry)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let index = 1; index < testEvidence.length; index += 1) {
    if (testEvidence[index - 1].id === testEvidence[index].id) {
      throw new Error(`testEvidence contains duplicate id ${testEvidence[index].id}`);
    }
  }

  return {
    schemaVersion,
    phaseId,
    submissionRound,
    submittedBy,
    baseCommitSha,
    candidateCommitSha,
    files: sortUniqueByPath(input.files || [], "files"),
    migrationArtifacts: sortUniqueByPath(input.migrationArtifacts || [], "migrationArtifacts"),
    testEvidence,
    requirementsTraceHash: String(input.requirementsTraceHash),
    rollbackPlanHash: String(input.rollbackPlanHash),
    knownIssuesHash: String(input.knownIssuesHash),
  };
}

function hashSubmissionManifest(manifest, options) {
  return hashCanonicalJson(buildSubmissionManifest(manifest, options));
}

function modeString(stat) {
  return (stat.mode & 0o777777).toString(8).padStart(6, "0");
}

function createFileEntry(repositoryRoot, relativePath) {
  const normalizedPath = normalizeRepositoryPath(relativePath);
  const root = fs.realpathSync.native(path.resolve(repositoryRoot));
  const absolutePath = path.resolve(root, ...normalizedPath.split("/"));
  const relativeCheck = path.relative(root, absolutePath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw new Error(`path escapes repository root: ${relativePath}`);
  }

  const realParent = fs.realpathSync.native(path.dirname(absolutePath));
  const parentCheck = path.relative(root, realParent);
  if (parentCheck.startsWith("..") || path.isAbsolute(parentCheck)) {
    throw new Error(`path parent escapes repository root: ${relativePath}`);
  }

  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(absolutePath);
    return {
      path: normalizedPath,
      type: "symlink",
      mode: modeString(stat),
      linkTarget,
      sha256: sha256Bytes(Buffer.from(linkTarget, "utf8")),
    };
  }
  if (!stat.isFile()) throw new Error(`manifest path is not a regular file or symlink: ${relativePath}`);
  const realFile = fs.realpathSync.native(absolutePath);
  const fileCheck = path.relative(root, realFile);
  if (fileCheck.startsWith("..") || path.isAbsolute(fileCheck)) {
    throw new Error(`file escapes repository root: ${relativePath}`);
  }
  return {
    path: normalizedPath,
    type: "file",
    mode: modeString(stat),
    sha256: sha256Bytes(fs.readFileSync(absolutePath)),
  };
}

module.exports = {
  COMMIT_SHA_PATTERN,
  HASH_PATTERN,
  buildSubmissionManifest,
  canonicalJson,
  createFileEntry,
  hashCanonicalJson,
  hashSubmissionManifest,
  normalizeRepositoryPath,
  sha256Bytes,
  verifyRepositoryCommitBinding,
};
