const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildSubmissionManifest,
  canonicalJson,
  createFileEntry,
  hashCanonicalJson,
  normalizeRepositoryPath,
  sha256Bytes,
  verifyRepositoryCommitBinding,
} = require("../../src/delivery/canonicalSubmissionManifest");
const { execFileSync } = require("node:child_process");

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

function sampleManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    phaseId: "phase-15",
    submissionRound: 1,
    submittedBy: "worker-01",
    baseCommitSha: "a".repeat(40),
    candidateCommitSha: "b".repeat(40),
    files: [
      { path: "src/z.js", sha256: HASH_B, mode: "100644", type: "file" },
      { path: "src/a.js", sha256: HASH_A, mode: "100644", type: "file" },
    ],
    migrationArtifacts: [
      { path: "src/db/migrations/015.sql", sha256: HASH_C, mode: "100644", type: "file" },
    ],
    testEvidence: [
      { id: "test-b", sha256: HASH_B },
      { id: "test-a", sha256: HASH_A },
    ],
    requirementsTraceHash: HASH_A,
    rollbackPlanHash: HASH_B,
    knownIssuesHash: HASH_C,
    ...overrides,
  };
}

test("canonical JSON sorts object keys and normalizes negative zero", () => {
  assert.equal(canonicalJson({ z: -0, a: { d: 2, c: 1 } }), '{"a":{"c":1,"d":2},"z":0}');
});

test("submission manifest sorting produces a stable golden hash", () => {
  const first = buildSubmissionManifest(sampleManifest());
  const second = buildSubmissionManifest(sampleManifest({
    files: [...sampleManifest().files].reverse(),
    testEvidence: [...sampleManifest().testEvidence].reverse(),
  }));
  assert.deepEqual(first, second);
  assert.equal(
    hashCanonicalJson(first),
    "sha256:2b5f3b3535b26cfe67144d2bcb335d9c555bee7535d30dd1eb500f19141def0b"
  );
});

test("repository paths reject absolute and parent traversal", () => {
  assert.equal(normalizeRepositoryPath("./src\\example.js"), "src/example.js");
  assert.throws(() => normalizeRepositoryPath("../secret"), /escapes/);
  assert.throws(() => normalizeRepositoryPath("/etc/passwd"), /relative/);
  assert.throws(() => normalizeRepositoryPath("C:\\secret.txt"), /relative/);
});

test("duplicate file paths and invalid hashes are rejected", () => {
  assert.throws(
    () => buildSubmissionManifest(sampleManifest({ files: [sampleManifest().files[0], sampleManifest().files[0]] })),
    /duplicate path/
  );
  assert.throws(
    () => buildSubmissionManifest(sampleManifest({ requirementsTraceHash: "sha256:ABC" })),
    /lowercase hex/
  );
  assert.throws(
    () => buildSubmissionManifest(sampleManifest({ candidateCommitSha: "not-a-commit" })),
    /Git commit SHA/
  );
});

test("authoritative Git binding verifies real ancestry and rejects unknown commits", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase15-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runGit = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  runGit("init", "--quiet");
  runGit("config", "user.name", "Phase 15 Test");
  runGit("config", "user.email", "phase15@example.invalid");
  fs.writeFileSync(path.join(root, "artifact.txt"), "base\n");
  runGit("add", "artifact.txt");
  runGit("commit", "--quiet", "-m", "base");
  const baseCommitSha = runGit("rev-parse", "HEAD");
  fs.appendFileSync(path.join(root, "artifact.txt"), "candidate\n");
  runGit("add", "artifact.txt");
  runGit("commit", "--quiet", "-m", "candidate");
  const candidateCommitSha = runGit("rev-parse", "HEAD");
  const manifest = sampleManifest({ baseCommitSha, candidateCommitSha });
  assert.equal(verifyRepositoryCommitBinding(manifest, root).candidateCommitSha, candidateCommitSha);
  assert.throws(
    () => verifyRepositoryCommitBinding(sampleManifest({ baseCommitSha, candidateCommitSha: "f".repeat(40) }), root),
    /Git verification failed/
  );
});

test("file entries hash raw bytes and symlink targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase15-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "bytes.bin"), Buffer.from([0, 13, 10, 255]));
  fs.symlinkSync("bytes.bin", path.join(root, "src", "link.bin"));

  const file = createFileEntry(root, "src/bytes.bin");
  assert.equal(file.sha256, sha256Bytes(Buffer.from([0, 13, 10, 255])));
  assert.equal(file.type, "file");

  const link = createFileEntry(root, "src/link.bin");
  assert.equal(link.type, "symlink");
  assert.equal(link.linkTarget, "bytes.bin");
  assert.equal(link.sha256, sha256Bytes(Buffer.from("bytes.bin", "utf8")));
});

test("file hashing rejects parent-directory symlink escape", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase15-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phase15-outside-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(root, "escaped"));
  assert.throws(() => createFileEntry(root, "escaped/secret.txt"), /parent escapes/);
});
