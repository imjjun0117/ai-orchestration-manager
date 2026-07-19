const defaultDb = require("../db");
const hostIdentity = require("../core/hostIdentity");
const processService = require("../core/processService");

async function getTaskForControl(taskId, { db = defaultDb } = {}) {
  const { rows } = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (!rows[0]) throw new Error(`task ${taskId} does not exist`);
  return rows[0];
}

function assertLocalProcessOwnership(task, ownerInstanceId) {
  if (!task.current_pid) throw new Error("task has no active process");
  const localHost = hostIdentity.getHostId();
  if (task.current_host_id && task.current_host_id !== localHost) {
    throw new Error(`task process belongs to another host: ${task.current_host_id}`);
  }
  if (task.current_owner_instance_id && task.current_owner_instance_id !== ownerInstanceId) {
    throw new Error(`task process belongs to another instance: ${task.current_owner_instance_id}`);
  }
}

async function appendControlEvent(db, task, eventType, actorId, payload = {}) {
  await db.query(
    `INSERT INTO workspace_safety_events(workspace_id, task_id, event_type, actor_id, event_payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [`task:${task.id}`, task.id, eventType, actorId, JSON.stringify(payload)]
  );
}

async function pauseTaskProcess(
  { taskId, expectedVersion, ownerInstanceId, actorId = ownerInstanceId },
  { db = defaultDb, processApi = processService } = {}
) {
  const task = await getTaskForControl(taskId, { db });
  assertLocalProcessOwnership(task, ownerInstanceId);
  if (Number(task.row_version) !== Number(expectedVersion)) throw new Error("task version mismatch");
  const { rows } = await db.query(
    `UPDATE tasks
     SET control_state = 'PAUSED', status = 'PAUSED', paused_from_status = status,
         paused_at = CURRENT_TIMESTAMP, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND row_version = $2 AND control_state = 'RUNNING'
     RETURNING *`,
    [taskId, expectedVersion]
  );
  if (!rows[0]) throw new Error("task pause compare-and-set failed");
  const pausedVersion = Number(rows[0].row_version);
  try {
    const signalResult = processApi.pauseProcessTree({ pid: task.current_pid, pgid: task.current_pgid });
    await appendControlEvent(db, rows[0], "TASK_PROCESS_PAUSED", actorId, signalResult);
    return rows[0];
  } catch (error) {
    const reconciled = await db.query(
      `UPDATE tasks
       SET control_state = 'NEEDS_RECONCILIATION', status = 'NEEDS_RECONCILIATION',
           row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND row_version = $2 AND control_state = 'PAUSED'
       RETURNING *`,
      [taskId, pausedVersion]
    ).catch(() => ({ rows: [] }));
    if (reconciled.rows[0]) {
      await appendControlEvent(db, reconciled.rows[0], "TASK_PAUSE_REQUIRES_RECONCILIATION", actorId, {
        error: error.message,
        pid: task.current_pid,
        pgid: task.current_pgid,
      }).catch(() => {});
    }
    throw error;
  }
}

async function resumeTaskProcess(
  { taskId, expectedVersion, ownerInstanceId, actorId = ownerInstanceId },
  { db = defaultDb, processApi = processService } = {}
) {
  const task = await getTaskForControl(taskId, { db });
  assertLocalProcessOwnership(task, ownerInstanceId);
  if (Number(task.row_version) !== Number(expectedVersion)) throw new Error("task version mismatch");
  const { rows } = await db.query(
    `UPDATE tasks
     SET control_state = 'RUNNING', status = paused_from_status,
         paused_from_status = NULL, paused_at = NULL,
         row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND row_version = $2 AND control_state = 'PAUSED' AND paused_from_status IS NOT NULL
     RETURNING *`,
    [taskId, expectedVersion]
  );
  if (!rows[0]) throw new Error("task resume compare-and-set failed");
  try {
    const signalResult = processApi.resumeProcessTree({ pid: task.current_pid, pgid: task.current_pgid });
    await appendControlEvent(db, rows[0], "TASK_PROCESS_RESUMED", actorId, signalResult);
    return rows[0];
  } catch (error) {
    await db.query(
      `UPDATE tasks SET control_state = 'NEEDS_RECONCILIATION', status = 'NEEDS_RECONCILIATION',
       row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [taskId]
    );
    throw error;
  }
}

async function killTaskProcess(
  { taskId, expectedVersion, ownerInstanceId, actorId = ownerInstanceId, killGraceMs = 5000 },
  { db = defaultDb, processApi = processService } = {}
) {
  const task = await getTaskForControl(taskId, { db });
  assertLocalProcessOwnership(task, ownerInstanceId);
  if (Number(task.row_version) !== Number(expectedVersion)) throw new Error("task version mismatch");
  const requested = await db.query(
    `UPDATE tasks
     SET control_state = 'CANCEL_REQUESTED', status = 'CANCEL_REQUESTED',
         row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND row_version = $2
       AND control_state IN ('RUNNING', 'PAUSED', 'CANCEL_REQUESTED')
     RETURNING *`,
    [taskId, expectedVersion]
  );
  if (!requested.rows[0]) throw new Error("task cancel compare-and-set failed");
  const cancelVersion = Number(requested.rows[0].row_version);
  try {
    await appendControlEvent(db, requested.rows[0], "TASK_CANCEL_REQUESTED", actorId, {
      pid: task.current_pid,
      pgid: task.current_pgid,
    });
    const result = await processApi.killProcessTree({
      pid: task.current_pid,
      pgid: task.current_pgid,
      killGraceMs,
    });
    const { rows } = await db.query(
      `UPDATE tasks
       SET control_state = 'CANCELLED', status = 'CANCELLED', current_pid = NULL, current_pgid = NULL,
           current_host_id = NULL, current_owner_instance_id = NULL,
           row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND row_version = $2 AND control_state = 'CANCEL_REQUESTED'
       RETURNING *`,
      [taskId, cancelVersion]
    );
    if (!rows[0]) throw new Error("task kill compare-and-set failed");
    await appendControlEvent(db, rows[0], "TASK_PROCESS_KILLED", actorId, result);
    return { task: rows[0], process: result };
  } catch (error) {
    await db.query(
      `UPDATE tasks SET control_state = 'NEEDS_RECONCILIATION', status = 'NEEDS_RECONCILIATION',
       row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND row_version = $2`,
      [taskId, cancelVersion]
    );
    throw error;
  }
}

async function reconcileOrphanedTaskProcesses(
  { actorId = "phase16-watchdog" } = {},
  { db = defaultDb, processApi = processService, hostId = hostIdentity.getHostId() } = {}
) {
  const { rows } = await db.query(
    `SELECT * FROM tasks
     WHERE current_pid IS NOT NULL
       AND current_host_id = $1
       AND control_state IN ('RUNNING', 'PAUSED', 'CANCEL_REQUESTED')
     ORDER BY id`,
    [hostId]
  );
  const outcomes = [];
  for (const task of rows) {
    let alive;
    try {
      alive = task.current_pgid && process.platform !== "win32"
        ? processApi.isProcessGroupAlive(task.current_pgid)
        : processApi.isProcessAlive(task.current_pid);
    } catch (error) {
      outcomes.push({ taskId: task.id, action: "INSPECTION_FAILED", error: error.message });
      continue;
    }
    if (alive) {
      outcomes.push({ taskId: task.id, action: "PROCESS_ALIVE" });
      continue;
    }
    const reconciled = await db.query(
      `UPDATE tasks
       SET control_state = 'NEEDS_RECONCILIATION', status = 'NEEDS_RECONCILIATION',
           current_pid = NULL, current_pgid = NULL, current_host_id = NULL,
           current_owner_instance_id = NULL, row_version = row_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND row_version = $2 AND current_pid = $3
       RETURNING *`,
      [task.id, task.row_version, task.current_pid]
    );
    if (!reconciled.rows[0]) {
      outcomes.push({ taskId: task.id, action: "STATE_CHANGED_DURING_RECONCILIATION" });
      continue;
    }
    await appendControlEvent(db, reconciled.rows[0], "ORPHANED_TASK_REQUIRES_RECONCILIATION", actorId, {
      previousPid: task.current_pid,
      previousPgid: task.current_pgid,
      previousControlState: task.control_state,
    });
    outcomes.push({ taskId: task.id, action: "NEEDS_RECONCILIATION" });
  }
  return outcomes;
}

async function inspectTaskProcesses(
  {},
  { db = defaultDb, processApi = processService, hostId = hostIdentity.getHostId() } = {}
) {
  const { rows } = await db.query(
    `SELECT * FROM tasks
     WHERE current_pid IS NOT NULL
       AND current_host_id = $1
       AND control_state IN ('RUNNING', 'PAUSED', 'CANCEL_REQUESTED')
     ORDER BY id`,
    [hostId]
  );
  return rows.map((task) => {
    try {
      const alive = task.current_pgid && process.platform !== "win32"
        ? processApi.isProcessGroupAlive(task.current_pgid)
        : processApi.isProcessAlive(task.current_pid);
      return {
        taskId: task.id,
        rowVersion: Number(task.row_version),
        controlState: task.control_state,
        pid: task.current_pid,
        pgid: task.current_pgid,
        alive,
        recommendedAction: alive ? "NO_ACTION" : "MARK_NEEDS_RECONCILIATION",
      };
    } catch (error) {
      return {
        taskId: task.id,
        rowVersion: Number(task.row_version),
        controlState: task.control_state,
        pid: task.current_pid,
        pgid: task.current_pgid,
        alive: null,
        recommendedAction: "MANUAL_INSPECTION",
        error: error.message,
      };
    }
  });
}

module.exports = {
  assertLocalProcessOwnership,
  getTaskForControl,
  inspectTaskProcesses,
  killTaskProcess,
  pauseTaskProcess,
  reconcileOrphanedTaskProcesses,
  resumeTaskProcess,
};
