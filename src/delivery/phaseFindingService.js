const { deliveryId, queryOne } = require("./deliveryDb");

async function resolveFinding(
  { findingId, resolutionStatus, resolutionNote, actorId, credentialBinding },
  { db } = {}
) {
  const status = String(resolutionStatus || "").toUpperCase();
  if (!["RESOLVED", "WONT_FIX"].includes(status)) {
    throw new Error(`unsupported finding resolution: ${resolutionStatus}`);
  }
  if (!String(resolutionNote || "").trim()) throw new Error("finding resolution note is required");
  return queryOne(
    db,
    `SELECT * FROM resolve_phase_finding($1, $2, $3, $4, $5)`,
    [findingId, status, resolutionNote, actorId, credentialBinding]
  );
}

async function registerDebt(
  {
    debtId = deliveryId("debt"),
    findingId,
    debtOwnerActorId,
    riskOwnerActorId,
    dueDate,
    impactScope,
    actorId,
    credentialBinding,
  },
  { db } = {}
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || ""))) throw new Error("dueDate must use YYYY-MM-DD");
  if (!String(impactScope || "").trim()) throw new Error("impactScope is required");
  return queryOne(
    db,
    `SELECT * FROM register_phase_debt($1, $2, $3, $4, $5::date, $6, $7, $8)`,
    [
      debtId,
      findingId,
      debtOwnerActorId,
      riskOwnerActorId,
      dueDate,
      impactScope,
      actorId,
      credentialBinding,
    ]
  );
}

async function approveDebt(
  { debtId, validatorType, successorSafe, safetyRationale, actorId, credentialBinding },
  { db } = {}
) {
  const type = String(validatorType || "").toUpperCase();
  if (!["PLANNING", "DEVELOPMENT"].includes(type)) throw new Error(`unsupported validator type: ${validatorType}`);
  if (typeof successorSafe !== "boolean") throw new Error("successorSafe must be an explicit boolean");
  if (successorSafe && !String(safetyRationale || "").trim()) {
    throw new Error("safetyRationale is required when successorSafe is true");
  }
  return queryOne(
    db,
    `SELECT * FROM approve_phase_debt($1, $2, $3, $4, $5, $6)`,
    [debtId, type, successorSafe, safetyRationale || null, actorId, credentialBinding]
  );
}

async function acceptDebtRisk({ debtId, actorId, credentialBinding }, { db } = {}) {
  return queryOne(
    db,
    `SELECT * FROM accept_phase_debt_risk($1, $2, $3)`,
    [debtId, actorId, credentialBinding]
  );
}

module.exports = {
  acceptDebtRisk,
  approveDebt,
  registerDebt,
  resolveFinding,
};
