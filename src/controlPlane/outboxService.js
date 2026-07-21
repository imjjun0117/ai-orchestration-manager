const dbDefault = require("../db");

function database(db) { return db || dbDefault; }

async function claim({ instanceId, leaseMs = 60_000 }, { db } = {}) {
  const { rows } = await database(db).query("SELECT * FROM claim_outbox_event($1,$2)", [instanceId, leaseMs]);
  return rows[0] || null;
}

async function complete({ outboxId, instanceId, claimToken }, { db } = {}) {
  const { rows } = await database(db).query("SELECT * FROM complete_outbox_event($1,$2,$3)", [outboxId, instanceId, claimToken]);
  return rows[0];
}

async function suppress({ outboxId, instanceId, claimToken }, { db } = {}) {
  const { rows } = await database(db).query("SELECT * FROM suppress_outbox_event($1,$2,$3)", [outboxId, instanceId, claimToken]);
  return rows[0];
}

async function fail({ outboxId, instanceId, claimToken, errorCode, errorDetail, uncertain = false, retryDelayMs = 1_000 }, { db } = {}) {
  const { rows } = await database(db).query(
    "SELECT * FROM fail_outbox_event($1,$2,$3,$4,$5,$6,$7)",
    [outboxId, instanceId, claimToken, errorCode, String(errorDetail || "").slice(0, 4000), Boolean(uncertain), retryDelayMs]
  );
  return rows[0];
}

module.exports = { claim, complete, fail, suppress };
