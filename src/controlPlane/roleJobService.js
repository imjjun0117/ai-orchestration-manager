const crypto = require("node:crypto");
const dbDefault = require("../db");

function database(db) { return db || dbDefault; }

async function claim({ instanceId, leaseMs = 60_000 }, { db } = {}) {
  const { rows } = await database(db).query("SELECT * FROM claim_role_job($1,$2)", [instanceId, leaseMs]);
  return rows[0] || null;
}

async function heartbeat({ jobId, instanceId, claimToken, leaseMs = 60_000 }, { db } = {}) {
  const { rows } = await database(db).query("SELECT * FROM heartbeat_role_job($1,$2,$3,$4)", [jobId, instanceId, claimToken, leaseMs]);
  return rows[0];
}

async function complete({ jobId, instanceId, claimToken, inputArtifactHash = null, outputArtifactId = null, result = {} }, { db } = {}) {
  const response = await database(db).query(
    "SELECT * FROM complete_role_job($1,$2,$3,$4,$5,$6::jsonb)",
    [jobId, instanceId, claimToken, inputArtifactHash, outputArtifactId, JSON.stringify(result)]
  );
  return response.rows[0];
}

async function fail({ jobId, instanceId, claimToken, errorCode, errorDetail, sideEffectUncertain = false, retryDelayMs = 1_000 }, { db } = {}) {
  const fingerprint = `sha256:${crypto.createHash("sha256").update(`${errorCode}:${errorDetail || ""}`).digest("hex")}`;
  const response = await database(db).query(
    "SELECT * FROM fail_role_job($1,$2,$3,$4,$5,$6,$7,$8)",
    [jobId, instanceId, claimToken, errorCode, String(errorDetail || "").slice(0, 4000), fingerprint, Boolean(sideEffectUncertain), retryDelayMs]
  );
  return response.rows[0];
}

module.exports = { claim, complete, fail, heartbeat };
