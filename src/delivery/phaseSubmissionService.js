const {
  buildSubmissionManifest,
  hashCanonicalJson,
  verifyRepositoryCommitBinding,
} = require("./canonicalSubmissionManifest");
const { deliveryId, queryOne } = require("./deliveryDb");

async function sealSubmission(
  {
    submissionId = deliveryId("ps"),
    phaseId,
    submissionRound,
    manifest,
    actorId,
    credentialBinding,
    expectedVersion,
  },
  { db, repositoryRoot = process.env.DELIVERY_AUTHORITATIVE_REPOSITORY } = {}
) {
  const canonicalManifest = buildSubmissionManifest(manifest);
  if (canonicalManifest.phaseId !== phaseId) {
    throw new Error(`manifest phaseId ${canonicalManifest.phaseId} does not match ${phaseId}`);
  }
  if (canonicalManifest.submissionRound !== submissionRound) {
    throw new Error(`manifest submissionRound ${canonicalManifest.submissionRound} does not match ${submissionRound}`);
  }
  if (canonicalManifest.submittedBy !== actorId) {
    throw new Error(`manifest submittedBy ${canonicalManifest.submittedBy} does not match actor ${actorId}`);
  }
  if (!repositoryRoot) throw new Error("DELIVERY_AUTHORITATIVE_REPOSITORY is required to seal a submission");
  verifyRepositoryCommitBinding(canonicalManifest, repositoryRoot);

  const artifactBundleHash = hashCanonicalJson(canonicalManifest);
  const row = await queryOne(
    db,
    `SELECT * FROM seal_phase_submission(
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
     )`,
    [
      submissionId,
      phaseId,
      submissionRound,
      canonicalManifest.baseCommitSha,
      canonicalManifest.candidateCommitSha,
      artifactBundleHash,
      canonicalManifest.schemaVersion,
      JSON.stringify(canonicalManifest),
      actorId,
      credentialBinding,
      expectedVersion,
    ]
  );
  return { submission: row, canonicalManifest, artifactBundleHash };
}

module.exports = {
  sealSubmission,
};
