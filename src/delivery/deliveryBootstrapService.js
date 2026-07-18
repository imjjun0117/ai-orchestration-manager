const crypto = require("crypto");
const {
  buildSubmissionManifest,
  canonicalJson,
  hashCanonicalJson,
  sha256Bytes,
  verifyRepositoryCommitBinding,
} = require("./canonicalSubmissionManifest");
const { assertDistinctAssignments, credentialFingerprint } = require("./phaseAssignmentPolicy");
const { withTransaction } = require("./deliveryDb");
const phaseService = require("./phaseService");
const submissionService = require("./phaseSubmissionService");
const validationService = require("./phaseValidationService");
const gateService = require("./phaseGateService");

function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return credentialFingerprint(der);
}

function signVerdictPayload(payload, privateKey) {
  return crypto.sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64");
}

function verifySignedVerdict(signedVerdict) {
  if (!signedVerdict || typeof signedVerdict !== "object") throw new Error("signed verdict must be an object");
  const { payload, publicKeyPem, signature } = signedVerdict;
  if (!payload || !publicKeyPem || !signature) throw new Error("signed verdict requires payload, publicKeyPem, and signature");
  const valid = crypto.verify(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    crypto.createPublicKey(publicKeyPem),
    Buffer.from(signature, "base64")
  );
  if (!valid) throw new Error(`invalid ${payload.validatorType || "unknown"} bootstrap verdict signature`);
  return { payload, credentialBinding: publicKeyFingerprint(publicKeyPem) };
}

function validateBootstrapVerdict(payload, expectedType) {
  const type = String(payload.validatorType || "").toUpperCase();
  if (type !== expectedType) throw new Error(`expected ${expectedType} verdict, received ${type || "missing"}`);
  if (payload.verdict !== "APPROVED") throw new Error(`${expectedType} bootstrap verdict must be APPROVED`);
  if (!Array.isArray(payload.evidenceArtifactIds) || payload.evidenceArtifactIds.length === 0) {
    throw new Error(`${expectedType} bootstrap verdict requires evidenceArtifactIds`);
  }
  if (!payload.signedAt || Number.isNaN(Date.parse(payload.signedAt))) {
    throw new Error(`${expectedType} bootstrap verdict requires a valid signedAt timestamp`);
  }
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  if (findings.some((finding) => ["BLOCKER", "MAJOR"].includes(String(finding.severity || "").toUpperCase()))) {
    throw new Error(`${expectedType} bootstrap verdict cannot approve with BLOCKER or MAJOR findings`);
  }
}

function verifyBootstrapPackage(
  bootstrapPackage,
  { repositoryRoot, requireRepositoryBinding = false } = {}
) {
  if (!bootstrapPackage || typeof bootstrapPackage !== "object") throw new Error("bootstrap package must be an object");
  const manifest = buildSubmissionManifest(bootstrapPackage.manifest);
  if (manifest.phaseId !== "phase-15") throw new Error("bootstrap package must target phase-15");
  const artifactBundleHash = hashCanonicalJson(manifest);
  const submissionId = String(bootstrapPackage.submissionId || "").trim();
  if (!submissionId) throw new Error("bootstrap package requires submissionId");

  const assignments = bootstrapPackage.assignments || {};
  assertDistinctAssignments(assignments);
  if (manifest.submittedBy !== assignments.WORKER) {
    throw new Error("bootstrap manifest submittedBy must match the assigned worker");
  }

  const planning = verifySignedVerdict(bootstrapPackage.planningVerdict);
  const development = verifySignedVerdict(bootstrapPackage.developmentVerdict);
  validateBootstrapVerdict(planning.payload, "PLANNING");
  validateBootstrapVerdict(development.payload, "DEVELOPMENT");

  for (const result of [planning, development]) {
    if (result.payload.phaseId !== "phase-15") throw new Error("bootstrap verdict phaseId mismatch");
    if (result.payload.phaseSubmissionId !== submissionId) throw new Error("bootstrap verdict submissionId mismatch");
    if (result.payload.artifactBundleHash !== artifactBundleHash) throw new Error("bootstrap verdict artifact hash mismatch");
  }
  if (planning.payload.validatedBy !== assignments.PLANNING_VALIDATOR) {
    throw new Error("planning verdict actor does not match assignment");
  }
  if (development.payload.validatedBy !== assignments.DEVELOPMENT_VALIDATOR) {
    throw new Error("development verdict actor does not match assignment");
  }

  const actorList = bootstrapPackage.actors || [];
  const actors = new Map(actorList.map((actor) => [actor.id, actor]));
  if (actors.size !== actorList.length) throw new Error("bootstrap package contains duplicate actor IDs");
  if (actors.size !== 4) throw new Error("bootstrap package must contain exactly four assigned actors");
  for (const actor of actorList) {
    if (!actor.id || !["HUMAN", "AGENT", "SERVICE"].includes(actor.actorType)) {
      throw new Error("bootstrap actor requires id and a supported actorType");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(String(actor.credentialBinding || ""))) {
      throw new Error(`bootstrap actor ${actor.id} has an invalid credential binding`);
    }
  }
  for (const actorId of Object.values(assignments)) {
    if (!actors.has(actorId)) throw new Error(`bootstrap package is missing actor ${actorId}`);
  }
  if (actors.get(assignments.PLANNING_VALIDATOR).credentialBinding !== planning.credentialBinding) {
    throw new Error("planning validator public key does not match credential binding");
  }
  if (actors.get(assignments.DEVELOPMENT_VALIDATOR).credentialBinding !== development.credentialBinding) {
    throw new Error("development validator public key does not match credential binding");
  }

  let repositoryBinding = null;
  if (requireRepositoryBinding || repositoryRoot) {
    if (!repositoryRoot) throw new Error("authoritative repository is required for bootstrap verification");
    repositoryBinding = verifyRepositoryCommitBinding(manifest, repositoryRoot);
  }

  return {
    manifest,
    artifactBundleHash,
    submissionId,
    assignments,
    actors: [...actors.values()],
    planning,
    development,
    repositoryBinding,
    bootstrapPackageHash: sha256Bytes(Buffer.from(canonicalJson(bootstrapPackage), "utf8")),
  };
}

async function importBootstrapPackage(bootstrapPackage, { db, repositoryRoot } = {}) {
  if (!repositoryRoot) throw new Error("authoritative repository is required for bootstrap import");
  const verified = verifyBootstrapPackage(bootstrapPackage, {
    repositoryRoot,
    requireRepositoryBinding: true,
  });
  return withTransaction(async (client) => {
    for (const actor of verified.actors) {
      await phaseService.registerActor(
        {
          id: actor.id,
          actorType: actor.actorType,
          displayName: actor.displayName,
          credentialBinding: actor.credentialBinding,
          metadata: actor.metadata || {},
        },
        { db: client }
      );
    }

    await phaseService.createPhase(
      { id: "phase-15", name: "Delivery Governance Bootstrap", sequenceNo: 15 },
      { db: client }
    );
    await phaseService.createPhase(
      {
        id: "phase-16",
        name: "Workspace Safety & Approval Binding",
        sequenceNo: 16,
        dependencies: ["phase-15"],
      },
      { db: client }
    );

    for (const [assignmentRole, actorId] of Object.entries(verified.assignments)) {
      await phaseService.assignActor(
        {
          phaseId: "phase-15",
          actorId,
          assignmentRole,
          assignedByActorId: verified.assignments.GATE_ADMIN,
        },
        { db: client }
      );
    }

    const actorById = new Map(verified.actors.map((actor) => [actor.id, actor]));
    const gateAdmin = actorById.get(verified.assignments.GATE_ADMIN);
    const worker = actorById.get(verified.assignments.WORKER);

    await phaseService.startPhase(
      {
        phaseId: "phase-15",
        actorId: gateAdmin.id,
        credentialBinding: gateAdmin.credentialBinding,
        expectedVersion: 0,
      },
      { db: client }
    );

    await submissionService.sealSubmission(
      {
        submissionId: verified.submissionId,
        phaseId: "phase-15",
        submissionRound: verified.manifest.submissionRound,
        manifest: verified.manifest,
        actorId: worker.id,
        credentialBinding: worker.credentialBinding,
        expectedVersion: 1,
      },
      { db: client, repositoryRoot }
    );

    for (const result of [verified.planning, verified.development]) {
      const payload = result.payload;
      const validationId = String(payload.validationId || `${verified.submissionId}:${payload.validatorType.toLowerCase()}:1`);
      await validationService.startValidation(
        {
          validationId,
          phaseSubmissionId: verified.submissionId,
          validatorType: payload.validatorType,
          validationAttempt: 1,
          actorId: payload.validatedBy,
          credentialBinding: result.credentialBinding,
        },
        { db: client }
      );
      await validationService.completeValidation(
        {
          validationId,
          verdict: payload.verdict,
          evidence: {
            evidenceArtifactIds: payload.evidenceArtifactIds,
            signedVerdict: payload.validatorType === "PLANNING"
              ? bootstrapPackage.planningVerdict
              : bootstrapPackage.developmentVerdict,
            credentialBinding: result.credentialBinding,
          },
          findings: payload.findings || [],
          actorId: payload.validatedBy,
          credentialBinding: result.credentialBinding,
        },
        { db: client }
      );
    }

    const { rows } = await client.query("SELECT row_version FROM delivery_phases WHERE id = 'phase-15'");
    const accepted = await gateService.gatePhase(
      {
        phaseId: "phase-15",
        actorId: gateAdmin.id,
        credentialBinding: gateAdmin.credentialBinding,
        expectedVersion: rows[0].row_version,
      },
      { db: client }
    );

    await client.query(
      `INSERT INTO phase_gate_events(phase_id, phase_submission_id, event_type, actor_id, event_payload)
       VALUES ('phase-15', $1, 'BOOTSTRAP_ACCEPTED', $2, $3::jsonb)`,
      [
        verified.submissionId,
        gateAdmin.id,
        JSON.stringify({
          artifactBundleHash: verified.artifactBundleHash,
          bootstrapPackageHash: verified.bootstrapPackageHash,
        }),
      ]
    );

    return { accepted, verified };
  }, { db });
}

module.exports = {
  importBootstrapPackage,
  publicKeyFingerprint,
  signVerdictPayload,
  verifyBootstrapPackage,
  verifySignedVerdict,
};
