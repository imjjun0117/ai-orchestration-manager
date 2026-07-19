const crypto = require("crypto");
const defaultDb = require("../db");

const LEASE_MODES = Object.freeze(["READ_SHARED", "WRITE_EXCLUSIVE", "FINALIZE_EXCLUSIVE"]);
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

function normalizeTtlMs(value = DEFAULT_LEASE_TTL_MS) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("workspace lease ttl must be a positive integer");
  return parsed;
}

function assertLeaseMode(mode) {
  if (!LEASE_MODES.includes(mode)) throw new Error(`unsupported workspace lease mode: ${mode}`);
  return mode;
}

function workspaceLeaseId() {
  return `wl-${crypto.randomUUID()}`;
}

async function acquireLease(
  {
    leaseId = workspaceLeaseId(),
    workspaceId,
    ownerInstanceId,
    ownerTaskId = null,
    ownerOperationId,
    ownerJobId = null,
    mode,
    ttlMs = DEFAULT_LEASE_TTL_MS,
    metadata = {},
  },
  { db = defaultDb } = {}
) {
  assertLeaseMode(mode);
  if (!String(workspaceId || "").trim()) throw new Error("workspaceId is required");
  if (!String(ownerInstanceId || "").trim()) throw new Error("ownerInstanceId is required");
  if (!String(ownerOperationId || "").trim()) throw new Error("ownerOperationId is required");
  const { rows } = await db.query(
    `SELECT * FROM acquire_workspace_lease($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      leaseId,
      workspaceId,
      ownerInstanceId,
      ownerTaskId,
      ownerOperationId,
      ownerJobId,
      mode,
      normalizeTtlMs(ttlMs),
      JSON.stringify(metadata || {}),
    ]
  );
  return rows[0];
}

async function heartbeatLease(
  { leaseId, ownerInstanceId, ownerOperationId, fencingToken, ttlMs = DEFAULT_LEASE_TTL_MS },
  { db = defaultDb } = {}
) {
  const { rows } = await db.query(
    `SELECT * FROM heartbeat_workspace_lease($1, $2, $3, $4, $5)`,
    [leaseId, ownerInstanceId, ownerOperationId, fencingToken, normalizeTtlMs(ttlMs)]
  );
  return rows[0];
}

async function releaseLease(
  { leaseId, ownerInstanceId, ownerOperationId, fencingToken },
  { db = defaultDb } = {}
) {
  const { rows } = await db.query(
    `SELECT * FROM release_workspace_lease($1, $2, $3, $4)`,
    [leaseId, ownerInstanceId, ownerOperationId, fencingToken]
  );
  return rows[0];
}

async function getActiveLeases(workspaceId, { db = defaultDb } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM workspace_leases
     WHERE workspace_id = $1 AND released_at IS NULL AND expires_at > CURRENT_TIMESTAMP
     ORDER BY acquired_at, lease_id`,
    [workspaceId]
  );
  return rows;
}

async function getLockHead(workspaceId, { db = defaultDb } = {}) {
  const { rows } = await db.query(`SELECT * FROM workspace_lock_heads WHERE workspace_id = $1`, [workspaceId]);
  return rows[0] || null;
}

module.exports = {
  DEFAULT_LEASE_TTL_MS,
  LEASE_MODES,
  acquireLease,
  assertLeaseMode,
  getActiveLeases,
  getLockHead,
  heartbeatLease,
  normalizeTtlMs,
  releaseLease,
  workspaceLeaseId,
};
