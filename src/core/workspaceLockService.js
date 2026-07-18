const fs = require("fs");
const path = require("path");
const db = require("../db");
const hostIdentity = require("./hostIdentity");
const logger = require("../../services/logger");

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;

class WorkspaceLockBusyError extends Error {
  constructor(lock) {
    const owner = lock ? `${lock.owner_host_id || "unknown-host"}/${lock.owner_instance_id || "unknown"}:${lock.owner_pid || "?"}` : "unknown";
    super(`Workspace lock is held by ${owner}`);
    this.name = "WorkspaceLockBusyError";
    this.lock = lock || null;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveLockTtlMs(explicitTtlMs = null) {
  if (explicitTtlMs !== null && explicitTtlMs !== undefined) {
    return parsePositiveInt(explicitTtlMs, DEFAULT_LOCK_TTL_MS);
  }
  return parsePositiveInt(process.env.WORKSPACE_LOCK_TTL_MS, DEFAULT_LOCK_TTL_MS);
}

function resolveHeartbeatMs(lockTtlMs) {
  const configured = parsePositiveInt(process.env.WORKSPACE_LOCK_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
  return Math.min(configured, Math.max(1000, Math.floor(lockTtlMs / 3)));
}

function normalizeWorkspaceKey(workspaceDir) {
  const trimmed = String(workspaceDir || "").trim();
  if (!trimmed) return "";
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync.native(resolved);
  } catch (err) {
    return resolved;
  }
}

async function getLock(workspaceKey) {
  const { rows } = await db.query(
    `SELECT * FROM workspace_locks WHERE workspace_key = $1`,
    [workspaceKey]
  );
  return rows[0] || null;
}

async function acquireLock({
  workspaceDir,
  ownerHostId = hostIdentity.getHostId(),
  ownerInstanceId,
  ownerPid = process.pid,
  taskId = null,
  commandLabel = null,
  ttlMs = null,
}) {
  const workspaceKey = normalizeWorkspaceKey(workspaceDir);
  if (!workspaceKey) {
    throw new Error("workspace lock 획득 실패: workspaceDir가 비어 있습니다.");
  }

  const lockTtlMs = resolveLockTtlMs(ttlMs);
  const { rows } = await db.query(
    `INSERT INTO workspace_locks
       (workspace_key, owner_host_id, owner_instance_id, owner_pid, task_id, command_label, acquired_at, heartbeat_at, expires_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($7::int * INTERVAL '1 millisecond'))
     ON CONFLICT (workspace_key) DO UPDATE
       SET owner_host_id = EXCLUDED.owner_host_id,
           owner_instance_id = EXCLUDED.owner_instance_id,
           owner_pid = EXCLUDED.owner_pid,
           task_id = EXCLUDED.task_id,
           command_label = EXCLUDED.command_label,
           acquired_at = CURRENT_TIMESTAMP,
           heartbeat_at = CURRENT_TIMESTAMP,
           expires_at = CURRENT_TIMESTAMP + ($7::int * INTERVAL '1 millisecond'),
           updated_at = CURRENT_TIMESTAMP
     WHERE workspace_locks.expires_at < CURRENT_TIMESTAMP
        OR (
          workspace_locks.owner_host_id = $2
          AND workspace_locks.owner_instance_id = $3
          AND workspace_locks.owner_pid = $4
        )
     RETURNING *`,
    [workspaceKey, ownerHostId, ownerInstanceId, ownerPid, taskId, commandLabel, lockTtlMs]
  );

  if (rows[0]) {
    logger.info(`[WorkspaceLock] acquired workspace=${workspaceKey} owner=${ownerHostId}/${ownerInstanceId}:${ownerPid} task=${taskId || "-"} label=${commandLabel || "-"}`);
    return rows[0];
  }

  throw new WorkspaceLockBusyError(await getLock(workspaceKey));
}

async function heartbeatLock({ workspaceDir, ownerHostId = hostIdentity.getHostId(), ownerInstanceId, ownerPid = process.pid, ttlMs = null }) {
  const workspaceKey = normalizeWorkspaceKey(workspaceDir);
  const lockTtlMs = resolveLockTtlMs(ttlMs);
  const { rows } = await db.query(
    `UPDATE workspace_locks
     SET heartbeat_at = CURRENT_TIMESTAMP,
         expires_at = CURRENT_TIMESTAMP + ($5::int * INTERVAL '1 millisecond'),
         updated_at = CURRENT_TIMESTAMP
     WHERE workspace_key = $1
       AND owner_instance_id = $2
       AND owner_pid = $3
       AND owner_host_id = $4
     RETURNING *`,
    [workspaceKey, ownerInstanceId, ownerPid, ownerHostId, lockTtlMs]
  );
  return rows[0] || null;
}

async function releaseLock({ workspaceDir, ownerHostId = hostIdentity.getHostId(), ownerInstanceId, ownerPid = process.pid }) {
  const workspaceKey = normalizeWorkspaceKey(workspaceDir);
  const { rows } = await db.query(
    `DELETE FROM workspace_locks
     WHERE workspace_key = $1
       AND owner_instance_id = $2
       AND owner_pid = $3
       AND owner_host_id = $4
     RETURNING *`,
    [workspaceKey, ownerInstanceId, ownerPid, ownerHostId]
  );
  if (rows[0]) {
    logger.info(`[WorkspaceLock] released workspace=${workspaceKey} owner=${ownerHostId}/${ownerInstanceId}:${ownerPid}`);
  }
  return rows[0] || null;
}

async function withWorkspaceLock(options, fn) {
  const lockTtlMs = resolveLockTtlMs(options.ttlMs);
  const heartbeatMs = resolveHeartbeatMs(lockTtlMs);
  await acquireLock({ ...options, ttlMs: lockTtlMs });
  let heartbeatTimer = null;

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      heartbeatLock({ ...options, ttlMs: lockTtlMs }).catch((err) => {
        logger.error("[WorkspaceLock] heartbeat 실패", err);
      });
    }, heartbeatMs);
    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
  }

  try {
    return await fn();
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await releaseLock(options);
  }
}

function isLockBusyError(err) {
  return err instanceof WorkspaceLockBusyError || (err && err.name === "WorkspaceLockBusyError");
}

module.exports = {
  DEFAULT_LOCK_TTL_MS,
  WorkspaceLockBusyError,
  acquireLock,
  getLock,
  heartbeatLock,
  isLockBusyError,
  normalizeWorkspaceKey,
  releaseLock,
  resolveLockTtlMs,
  withWorkspaceLock,
};
