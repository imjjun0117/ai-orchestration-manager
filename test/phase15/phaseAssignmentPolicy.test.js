const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertDistinctAssignments,
  assignmentRoleForValidatorType,
  credentialFingerprint,
} = require("../../src/delivery/phaseAssignmentPolicy");

const assignments = {
  WORKER: "worker-01",
  PLANNING_VALIDATOR: "planning-01",
  DEVELOPMENT_VALIDATOR: "development-01",
  GATE_ADMIN: "gate-01",
};

test("all Phase 15 responsibility assignments must be distinct", () => {
  assert.equal(assertDistinctAssignments(assignments), true);
  assert.throws(
    () => assertDistinctAssignments({ ...assignments, DEVELOPMENT_VALIDATOR: assignments.WORKER }),
    /cannot hold both/
  );
  assert.throws(() => assertDistinctAssignments({ ...assignments, GATE_ADMIN: "" }), /missing active assignment/);
});

test("validator types map to fixed assignment roles", () => {
  assert.equal(assignmentRoleForValidatorType("planning"), "PLANNING_VALIDATOR");
  assert.equal(assignmentRoleForValidatorType("DEVELOPMENT"), "DEVELOPMENT_VALIDATOR");
  assert.throws(() => assignmentRoleForValidatorType("worker"), /unsupported validator type/);
});

test("credential fingerprints are deterministic and do not expose source material", () => {
  const first = credentialFingerprint("public-key-material");
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first, credentialFingerprint(Buffer.from("public-key-material")));
  assert.ok(!first.includes("public-key-material"));
});

