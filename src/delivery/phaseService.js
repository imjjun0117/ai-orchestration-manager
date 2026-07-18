const { ASSIGNMENT_ROLES } = require("./phaseAssignmentPolicy");
const { queryOne, resolveDb, withTransaction } = require("./deliveryDb");

async function registerActor({ id, actorType, displayName, credentialBinding, metadata = {} }, { db } = {}) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(credentialBinding || ""))) {
    throw new Error("credentialBinding must use sha256:<lowercase hex>");
  }
  return queryOne(
    db,
    `INSERT INTO delivery_actors(id, actor_type, display_name, credential_binding, metadata_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [id, actorType, displayName, credentialBinding, JSON.stringify(metadata)]
  );
}

async function createPhase({ id, name, sequenceNo, dependencies = [] }, { db } = {}) {
  const execute = async (client) => {
    const phase = await queryOne(
      client,
      `INSERT INTO delivery_phases(id, name, sequence_no)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, name, sequenceNo]
    );
    for (const dependencyId of dependencies) {
      await client.query(
        `INSERT INTO phase_dependencies(phase_id, depends_on_phase_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, dependencyId]
      );
    }
    return phase;
  };

  if (db && typeof db.release === "function") return execute(db);
  return withTransaction(execute, { db });
}

async function assignActor({ phaseId, actorId, assignmentRole, assignedByActorId = null, validUntil = null }, { db } = {}) {
  if (!ASSIGNMENT_ROLES.includes(assignmentRole)) {
    throw new Error(`unsupported assignment role: ${assignmentRole}`);
  }
  return queryOne(
    db,
    `INSERT INTO phase_assignments(
       phase_id, actor_id, assignment_role, assigned_by_actor_id, valid_until
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [phaseId, actorId, assignmentRole, assignedByActorId, validUntil]
  );
}

async function replaceAssignment(
  { phaseId, assignmentRole, newActorId, reason, actorId, credentialBinding, expectedVersion },
  { db } = {}
) {
  if (!ASSIGNMENT_ROLES.includes(assignmentRole)) {
    throw new Error(`unsupported assignment role: ${assignmentRole}`);
  }
  if (!String(reason || "").trim()) throw new Error("assignment replacement reason is required");
  return queryOne(
    db,
    `SELECT * FROM replace_phase_assignment($1, $2, $3, $4, $5, $6, $7)`,
    [phaseId, assignmentRole, newActorId, reason, actorId, credentialBinding, expectedVersion]
  );
}

async function startPhase({ phaseId, actorId, credentialBinding, expectedVersion }, { db } = {}) {
  return queryOne(
    db,
    `SELECT * FROM start_delivery_phase($1, $2, $3, $4)`,
    [phaseId, actorId, credentialBinding, expectedVersion]
  );
}

async function startRework({ phaseId, actorId, credentialBinding, expectedVersion }, { db } = {}) {
  return queryOne(
    db,
    `SELECT * FROM start_phase_rework($1, $2, $3, $4)`,
    [phaseId, actorId, credentialBinding, expectedVersion]
  );
}

async function cancelPhase({ phaseId, reason, actorId, credentialBinding, expectedVersion }, { db } = {}) {
  if (!String(reason || "").trim()) throw new Error("cancellation reason is required");
  return queryOne(
    db,
    `SELECT * FROM cancel_delivery_phase($1, $2, $3, $4, $5)`,
    [phaseId, reason, actorId, credentialBinding, expectedVersion]
  );
}

async function getPhaseStatus(phaseId, { db } = {}) {
  const client = resolveDb(db);
  const phase = await queryOne(client, `SELECT * FROM delivery_phases WHERE id = $1`, [phaseId]);
  if (!phase) return null;
  const latestSubmission = phase.latest_submission_id
    ? await queryOne(client, `SELECT * FROM phase_submissions WHERE id = $1`, [phase.latest_submission_id])
    : null;
  const { rows: assignments } = await client.query(
    `SELECT pa.assignment_role, pa.actor_id, a.display_name, pa.valid_from, pa.valid_until
     FROM phase_assignments pa
     JOIN delivery_actors a ON a.id = pa.actor_id
     WHERE pa.phase_id = $1 AND pa.revoked_at IS NULL
     ORDER BY pa.assignment_role`,
    [phaseId]
  );
  const { rows: validationHistory } = await client.query(
    `SELECT v.*
     FROM phase_validations v
     JOIN phase_submissions s ON s.id = v.phase_submission_id
     WHERE s.phase_id = $1
     ORDER BY s.submission_round DESC, v.validator_type, v.validation_attempt DESC`,
    [phaseId]
  );
  const latestValidations = [];
  for (const validatorType of ["PLANNING", "DEVELOPMENT"]) {
    const latest = validationHistory.find((validation) => validation.validator_type === validatorType);
    if (latest) latestValidations.push(latest);
  }
  const { rows: openFindings } = await client.query(
    `SELECT f.*
     FROM phase_validation_findings f
     JOIN phase_validations v ON v.id = f.phase_validation_id
     JOIN phase_submissions s ON s.id = v.phase_submission_id
     WHERE s.phase_id = $1
       AND s.id = $2
       AND f.status <> 'RESOLVED'
     ORDER BY f.created_at`,
    [phaseId, phase.latest_submission_id]
  );
  const { rows: debts } = await client.query(
    `SELECT d.*, f.severity, f.category, f.status AS finding_status,
            COALESCE(jsonb_agg(jsonb_build_object(
              'validatorType', da.validator_type,
              'approvedByActorId', da.approved_by_actor_id,
              'successorSafe', da.successor_safe,
              'safetyRationale', da.safety_rationale
            )) FILTER (WHERE da.debt_id IS NOT NULL), '[]'::jsonb) AS approvals
     FROM phase_debts d
     JOIN phase_validation_findings f ON f.id = d.finding_id
     JOIN phase_validations v ON v.id = f.phase_validation_id
     JOIN phase_submissions s ON s.id = v.phase_submission_id
     LEFT JOIN phase_debt_approvals da ON da.debt_id = d.id
     WHERE s.phase_id = $1
     GROUP BY d.id, f.severity, f.category, f.status
     ORDER BY d.created_at`,
    [phaseId]
  );
  const { rows: dependencies } = await client.query(
    `SELECT d.depends_on_phase_id, predecessor.status,
            a.activated_at, a.activated_by_submission_id
     FROM phase_dependencies d
     JOIN delivery_phases predecessor ON predecessor.id = d.depends_on_phase_id
     LEFT JOIN phase_dependency_activations a
       ON a.phase_id = d.phase_id AND a.depends_on_phase_id = d.depends_on_phase_id
     WHERE d.phase_id = $1
     ORDER BY predecessor.sequence_no`,
    [phaseId]
  );
  const { rows: successors } = await client.query(
    `SELECT d.phase_id, successor.status,
            a.activated_at, a.activated_by_submission_id
     FROM phase_dependencies d
     JOIN delivery_phases successor ON successor.id = d.phase_id
     LEFT JOIN phase_dependency_activations a
       ON a.phase_id = d.phase_id AND a.depends_on_phase_id = d.depends_on_phase_id
     WHERE d.depends_on_phase_id = $1
     ORDER BY successor.sequence_no`,
    [phaseId]
  );
  const { rows: recentGateEvents } = await client.query(
    `SELECT * FROM phase_gate_events WHERE phase_id = $1 ORDER BY id DESC LIMIT 50`,
    [phaseId]
  );
  const requiredRoles = new Set(ASSIGNMENT_ROLES);
  for (const assignment of assignments) requiredRoles.delete(assignment.assignment_role);
  const blockers = [];
  if (phase.status !== "PLANNED") blockers.push(`phase status is ${phase.status}, expected PLANNED`);
  if (requiredRoles.size > 0) blockers.push(`missing assignments: ${[...requiredRoles].join(", ")}`);
  for (const dependency of dependencies) {
    if (!dependency.activated_at) blockers.push(`dependency ${dependency.depends_on_phase_id} is not activated`);
  }
  return {
    phase,
    latestSubmission,
    assignments,
    latestValidations,
    validationHistory,
    openFindings,
    debts,
    dependencies,
    successors,
    recentGateEvents,
    startReadiness: { ready: blockers.length === 0, blockers },
  };
}

module.exports = {
  assignActor,
  cancelPhase,
  createPhase,
  getPhaseStatus,
  registerActor,
  replaceAssignment,
  startPhase,
  startRework,
};
