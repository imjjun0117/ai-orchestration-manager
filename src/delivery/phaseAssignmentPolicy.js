const ASSIGNMENT_ROLES = Object.freeze([
  "WORKER",
  "PLANNING_VALIDATOR",
  "DEVELOPMENT_VALIDATOR",
  "GATE_ADMIN",
]);

const VALIDATOR_ASSIGNMENT = Object.freeze({
  PLANNING: "PLANNING_VALIDATOR",
  DEVELOPMENT: "DEVELOPMENT_VALIDATOR",
});

function assertDistinctAssignments(assignments) {
  const seenActors = new Map();
  for (const role of ASSIGNMENT_ROLES) {
    const actorId = String(assignments[role] || "").trim();
    if (!actorId) throw new Error(`missing active assignment for ${role}`);
    const existingRole = seenActors.get(actorId);
    if (existingRole) {
      throw new Error(`actor ${actorId} cannot hold both ${existingRole} and ${role}`);
    }
    seenActors.set(actorId, role);
  }
  return true;
}

function assignmentRoleForValidatorType(validatorType) {
  const role = VALIDATOR_ASSIGNMENT[String(validatorType || "").toUpperCase()];
  if (!role) throw new Error(`unsupported validator type: ${validatorType}`);
  return role;
}

function credentialFingerprint(publicKeyOrCredential) {
  const crypto = require("crypto");
  const value = Buffer.isBuffer(publicKeyOrCredential)
    ? publicKeyOrCredential
    : Buffer.from(String(publicKeyOrCredential || ""), "utf8");
  if (value.length === 0) throw new Error("credential material is required");
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

module.exports = {
  ASSIGNMENT_ROLES,
  VALIDATOR_ASSIGNMENT,
  assertDistinctAssignments,
  assignmentRoleForValidatorType,
  credentialFingerprint,
};

