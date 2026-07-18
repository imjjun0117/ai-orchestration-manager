const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  publicKeyFingerprint,
  signVerdictPayload,
  verifyBootstrapPackage,
} = require("../../src/delivery/deliveryBootstrapService");
const { hashCanonicalJson } = require("../../src/delivery/canonicalSubmissionManifest");
const { credentialFingerprint } = require("../../src/delivery/phaseAssignmentPolicy");

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

function publicPem(publicKey) {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function buildPackage() {
  const planningKeys = crypto.generateKeyPairSync("ed25519");
  const developmentKeys = crypto.generateKeyPairSync("ed25519");
  const manifest = {
    schemaVersion: 1,
    phaseId: "phase-15",
    submissionRound: 1,
    submittedBy: "worker-01",
    baseCommitSha: "a".repeat(40),
    candidateCommitSha: "b".repeat(40),
    files: [{ path: "src/a.js", sha256: HASH_A, mode: "100644", type: "file" }],
    migrationArtifacts: [{ path: "src/db/migrations/015.sql", sha256: HASH_B, mode: "100644", type: "file" }],
    testEvidence: [{ id: "unit", sha256: HASH_C }],
    requirementsTraceHash: HASH_A,
    rollbackPlanHash: HASH_B,
    knownIssuesHash: HASH_C,
  };
  const artifactBundleHash = hashCanonicalJson(manifest);
  const submissionId = "ps-phase15-1";
  const planningPayload = {
    validationId: "pv-phase15-planning-1",
    validatorType: "PLANNING",
    phaseId: "phase-15",
    phaseSubmissionId: submissionId,
    artifactBundleHash,
    verdict: "APPROVED",
    validatedBy: "planning-01",
    evidenceArtifactIds: ["planning-evidence"],
    findings: [],
    signedAt: "2026-07-18T00:00:00.000Z",
  };
  const developmentPayload = {
    validationId: "pv-phase15-development-1",
    validatorType: "DEVELOPMENT",
    phaseId: "phase-15",
    phaseSubmissionId: submissionId,
    artifactBundleHash,
    verdict: "APPROVED",
    validatedBy: "development-01",
    evidenceArtifactIds: ["development-evidence"],
    findings: [],
    signedAt: "2026-07-18T00:00:00.000Z",
  };
  const planningPublicPem = publicPem(planningKeys.publicKey);
  const developmentPublicPem = publicPem(developmentKeys.publicKey);
  return {
    manifest,
    submissionId,
    assignments: {
      WORKER: "worker-01",
      PLANNING_VALIDATOR: "planning-01",
      DEVELOPMENT_VALIDATOR: "development-01",
      GATE_ADMIN: "gate-01",
    },
    actors: [
      { id: "worker-01", actorType: "AGENT", displayName: "Worker", credentialBinding: credentialFingerprint("worker") },
      { id: "planning-01", actorType: "HUMAN", displayName: "Planning", credentialBinding: publicKeyFingerprint(planningPublicPem) },
      { id: "development-01", actorType: "HUMAN", displayName: "Development", credentialBinding: publicKeyFingerprint(developmentPublicPem) },
      { id: "gate-01", actorType: "SERVICE", displayName: "Gate", credentialBinding: credentialFingerprint("gate") },
    ],
    planningVerdict: {
      payload: planningPayload,
      publicKeyPem: planningPublicPem,
      signature: signVerdictPayload(planningPayload, planningKeys.privateKey),
    },
    developmentVerdict: {
      payload: developmentPayload,
      publicKeyPem: developmentPublicPem,
      signature: signVerdictPayload(developmentPayload, developmentKeys.privateKey),
    },
  };
}

test("two independent signed verdicts verify against one canonical bundle hash", () => {
  const bootstrapPackage = buildPackage();
  const verified = verifyBootstrapPackage(bootstrapPackage);
  assert.equal(verified.artifactBundleHash, bootstrapPackage.planningVerdict.payload.artifactBundleHash);
  assert.equal(verified.artifactBundleHash, bootstrapPackage.developmentVerdict.payload.artifactBundleHash);
  assert.match(verified.bootstrapPackageHash, /^sha256:[0-9a-f]{64}$/);
});

test("tampering with a signed verdict is rejected", () => {
  const bootstrapPackage = buildPackage();
  bootstrapPackage.planningVerdict.payload.verdict = "CHANGES_REQUESTED";
  assert.throws(() => verifyBootstrapPackage(bootstrapPackage), /invalid PLANNING bootstrap verdict signature/);
});

test("validator credential binding must match the signing public key", () => {
  const bootstrapPackage = buildPackage();
  const planningActor = bootstrapPackage.actors.find((actor) => actor.id === "planning-01");
  planningActor.credentialBinding = credentialFingerprint("some-other-key");
  assert.throws(() => verifyBootstrapPackage(bootstrapPackage), /public key does not match credential binding/);
});

test("worker, validators, and gate administrator cannot share an actor", () => {
  const bootstrapPackage = buildPackage();
  bootstrapPackage.assignments.DEVELOPMENT_VALIDATOR = bootstrapPackage.assignments.WORKER;
  assert.throws(() => verifyBootstrapPackage(bootstrapPackage), /cannot hold both/);
});

test("bootstrap approval rejects BLOCKER and MAJOR findings", () => {
  const bootstrapPackage = buildPackage();
  const payload = {
    ...bootstrapPackage.planningVerdict.payload,
    findings: [{ severity: "MAJOR", title: "missing rollback" }],
  };
  const replacementKeys = crypto.generateKeyPairSync("ed25519");
  const replacementPem = publicPem(replacementKeys.publicKey);
  bootstrapPackage.planningVerdict = {
    payload,
    publicKeyPem: replacementPem,
    signature: signVerdictPayload(payload, replacementKeys.privateKey),
  };
  bootstrapPackage.actors.find((actor) => actor.id === "planning-01").credentialBinding = publicKeyFingerprint(replacementPem);
  assert.throws(() => verifyBootstrapPackage(bootstrapPackage), /cannot approve with BLOCKER or MAJOR/);
});
