const crypto = require("node:crypto");
const dbDefault = require("../db");

function stablePayload({ role, jobType, result }) {
  return JSON.stringify({ jobType, result, role });
}

async function storeResultArtifact({ taskId, role, jobType, result, createdBy }, { db = dbDefault } = {}) {
  const payload = stablePayload({ role, jobType, result });
  const artifactHash = `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
  const id = `artifact-${crypto.randomUUID()}`;
  const { rows } = await db.query(
    `INSERT INTO artifacts(
       id, task_id, artifact_type, artifact_hash, manifest_json, file_manifest_json, created_by
     ) VALUES ($1,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6)
     RETURNING *`,
    [id, taskId, `ROLE_${String(role).toUpperCase()}_${jobType}`, artifactHash, payload, createdBy]
  );
  return rows[0];
}

module.exports = { stablePayload, storeResultArtifact };
