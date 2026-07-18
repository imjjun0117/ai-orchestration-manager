const { queryOne } = require("./deliveryDb");

async function gatePhase(
  { phaseId, actorId, credentialBinding, expectedVersion, acceptWithDebt = false },
  { db } = {}
) {
  return queryOne(
    db,
    `SELECT * FROM gate_delivery_phase($1, $2, $3, $4, $5)`,
    [phaseId, actorId, credentialBinding, expectedVersion, Boolean(acceptWithDebt)]
  );
}

module.exports = {
  gatePhase,
};

