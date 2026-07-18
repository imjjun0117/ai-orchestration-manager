const { assignmentRoleForValidatorType } = require("./phaseAssignmentPolicy");
const { deliveryId, queryOne } = require("./deliveryDb");

const VERDICTS = Object.freeze(["APPROVED", "CHANGES_REQUESTED", "BLOCKED"]);
const FINDING_SEVERITIES = Object.freeze(["BLOCKER", "MAJOR", "MINOR", "NOTE"]);
const FINDING_CATEGORIES = Object.freeze([
  "GENERAL",
  "REQUIREMENTS",
  "SECURITY",
  "DATA_INTEGRITY",
  "ROLLBACK",
  "OPERATIONS",
  "PERFORMANCE",
]);

function normalizeFinding(finding, index) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw new TypeError(`finding ${index + 1} must be an object`);
  }
  const severity = String(finding.severity || "").toUpperCase();
  const category = String(finding.category || "GENERAL").toUpperCase();
  if (!FINDING_SEVERITIES.includes(severity)) throw new Error(`finding ${index + 1} has invalid severity`);
  if (!FINDING_CATEGORIES.includes(category)) throw new Error(`finding ${index + 1} has invalid category`);
  const title = String(finding.title || "").trim();
  const detail = String(finding.detail || "").trim();
  if (!title || !detail) throw new Error(`finding ${index + 1} requires title and detail`);
  return {
    id: finding.id ? String(finding.id) : undefined,
    findingKey: String(finding.findingKey || `finding-${index + 1}`),
    severity,
    category,
    title,
    detail,
    evidence: finding.evidence || [],
  };
}

async function startValidation(
  {
    validationId = deliveryId("pv"),
    phaseSubmissionId,
    validatorType,
    validationAttempt,
    actorId,
    credentialBinding,
  },
  { db } = {}
) {
  const normalizedType = String(validatorType || "").toUpperCase();
  assignmentRoleForValidatorType(normalizedType);
  return queryOne(
    db,
    `SELECT * FROM start_phase_validation($1, $2, $3, $4, $5, $6)`,
    [validationId, phaseSubmissionId, normalizedType, validationAttempt, actorId, credentialBinding]
  );
}

async function completeValidation(
  { validationId, verdict, evidence = [], findings = [], actorId, credentialBinding },
  { db } = {}
) {
  const normalizedVerdict = String(verdict || "").toUpperCase();
  if (!VERDICTS.includes(normalizedVerdict)) throw new Error(`unsupported verdict: ${verdict}`);
  const normalizedFindings = findings.map(normalizeFinding);
  if (normalizedVerdict === "APPROVED" && normalizedFindings.some((finding) => finding.severity === "BLOCKER")) {
    throw new Error("APPROVED validation cannot contain BLOCKER findings");
  }
  return queryOne(
    db,
    `SELECT * FROM complete_phase_validation($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
    [
      validationId,
      normalizedVerdict,
      JSON.stringify(evidence),
      JSON.stringify(normalizedFindings),
      actorId,
      credentialBinding,
    ]
  );
}

async function failValidationAttempt(
  { validationId, terminalStatus = "INFRA_FAILED", evidence = [], actorId, credentialBinding },
  { db } = {}
) {
  const status = String(terminalStatus || "").toUpperCase();
  if (!["INFRA_FAILED", "CANCELLED"].includes(status)) {
    throw new Error(`unsupported failed validation status: ${terminalStatus}`);
  }
  return queryOne(
    db,
    `SELECT * FROM fail_phase_validation_attempt($1, $2, $3::jsonb, $4, $5)`,
    [validationId, status, JSON.stringify(evidence), actorId, credentialBinding]
  );
}

module.exports = {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  VERDICTS,
  completeValidation,
  failValidationAttempt,
  normalizeFinding,
  startValidation,
};

