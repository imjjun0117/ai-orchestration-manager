const dbDefault = require("../db");

function runtimeInstanceId(env = process.env) {
  const role = String(env.BOT_ROLE || "").trim().toLowerCase();
  const mode = String(env.MULTIBOT_ROLE_MODE || "off").trim().toLowerCase();
  if (!["manager", "planner", "coder", "reviewer", "qa", "summarizer"].includes(role)
      || !["shadow", "enforced"].includes(mode)) {
    return "";
  }
  return String(env.BOT_INSTANCE_ID || "").trim();
}

async function getTaskSkill(taskId, { db = dbDefault, env = process.env } = {}) {
  const instanceId = runtimeInstanceId(env);
  if (instanceId) {
    const { rows } = await db.query(
      "SELECT * FROM get_phase17_task_skill($1,$2)",
      [instanceId, taskId]
    );
    return rows[0] || null;
  }
  const { rows } = await db.query(
    `SELECT s.id, s.allowed_commands, s.blocked_commands
     FROM tasks t JOIN skills s ON s.id = t.selected_skill_id
     WHERE t.id = $1`,
    [taskId]
  );
  return rows[0] || null;
}

async function appendCommandLog(entry, { db = dbDefault, env = process.env } = {}) {
  const instanceId = runtimeInstanceId(env);
  const params = [
    entry.taskId,
    entry.agentName,
    entry.fullCommand,
    entry.stdout || null,
    entry.stderr || null,
    entry.exitCode ?? null,
    Boolean(entry.blocked),
    entry.durationMs ?? null,
    Boolean(entry.timedOut),
    Boolean(entry.killed),
  ];
  if (instanceId) {
    const { rows } = await db.query(
      "SELECT append_phase17_command_log($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS id",
      [instanceId, ...params]
    );
    return rows[0]?.id || null;
  }
  const { rows } = await db.query(
    `INSERT INTO command_logs
       (task_id, agent_name, command, stdout, stderr, exit_code, blocked, duration_ms, timed_out, killed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    params
  );
  return rows[0]?.id || null;
}

async function recordTaskProcess(taskId, processIdentity, { db = dbDefault, env = process.env } = {}) {
  const instanceId = runtimeInstanceId(env);
  if (instanceId) {
    const { rows } = await db.query(
      "SELECT record_phase17_task_process($1,$2,$3,$4,$5) AS recorded",
      [instanceId, taskId, processIdentity.pid, processIdentity.pgid || null, processIdentity.hostId]
    );
    if (!rows[0]?.recorded) {
      const error = new Error("task process ownership conflicts with another active claim");
      error.code = "TASK_PROCESS_OWNERSHIP_CONFLICT";
      throw error;
    }
    return true;
  }
  const result = await db.query(
    `UPDATE tasks
     SET current_pid=$2, current_pgid=$3, current_host_id=$4,
         current_owner_instance_id=$5, updated_at=CURRENT_TIMESTAMP
     WHERE id=$1`,
    [taskId, processIdentity.pid, processIdentity.pgid || null, processIdentity.hostId, processIdentity.ownerInstanceId]
  );
  return result.rowCount > 0;
}

async function clearTaskProcess(taskId, pid, { db = dbDefault, env = process.env } = {}) {
  const instanceId = runtimeInstanceId(env);
  if (instanceId) {
    const { rows } = await db.query(
      "SELECT clear_phase17_task_process($1,$2,$3) AS cleared",
      [instanceId, taskId, pid]
    );
    return Boolean(rows[0]?.cleared);
  }
  const result = await db.query(
    `UPDATE tasks
     SET current_pid=NULL, current_pgid=NULL, current_host_id=NULL,
         current_owner_instance_id=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE id=$1 AND current_pid=$2`,
    [taskId, pid]
  );
  return result.rowCount > 0;
}

module.exports = {
  appendCommandLog,
  clearTaskProcess,
  getTaskSkill,
  recordTaskProcess,
  runtimeInstanceId,
};
