const os = require("node:os");
const dbDefault = require("../db");

function database(db) {
  return db || dbDefault;
}

async function register(config, identity = {}, { db } = {}) {
  const result = await database(db).query(
    `SELECT * FROM register_bot_instance($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [
      config.instanceId, config.role, config.agentEngine, identity.discordUserId || null,
      identity.discordApplicationId || null, identity.hostname || os.hostname(), identity.pid || process.pid,
      identity.processVersion || process.env.npm_package_version || "development",
      JSON.stringify(identity.cliHealth || {}), JSON.stringify(identity.workspaceHealth || {}),
    ]
  );
  return result.rows[0];
}

async function heartbeat({ instanceId, status = "ONLINE", cliHealth = {}, workspaceHealth = {} }, { db } = {}) {
  const result = await database(db).query(
    "SELECT * FROM heartbeat_bot_instance($1,$2,$3::jsonb,$4::jsonb)",
    [instanceId, status, JSON.stringify(cliHealth), JSON.stringify(workspaceHealth)]
  );
  return result.rows[0];
}

async function offline(instanceId, { db } = {}) {
  const result = await database(db).query("SELECT * FROM mark_bot_instance_offline($1)", [instanceId]);
  return result.rows[0];
}

async function team({ db } = {}) {
  const { rows } = await database(db).query(
    `SELECT i.instance_id, i.bot_role, i.agent_engine, i.status, i.current_job_id,
            i.last_heartbeat_at, i.db_health, i.cli_health_json, i.workspace_health_json,
            COUNT(j.id) FILTER (WHERE j.status IN ('QUEUED','RETRY_WAIT'))::int AS role_backlog
     FROM bot_instances i
     LEFT JOIN role_jobs j ON j.target_role = i.bot_role
     GROUP BY i.instance_id
     ORDER BY array_position(ARRAY['manager','planner','coder','reviewer','qa','summarizer'], i.bot_role), i.instance_id`
  );
  return rows;
}

async function getInstance(selector, { db } = {}) {
  const { rows } = await database(db).query(
    `SELECT instance_id, bot_role, agent_engine, status, current_job_id, started_at,
            last_heartbeat_at, db_health, cli_health_json, workspace_health_json
     FROM bot_instances WHERE instance_id = $1 OR bot_role = $1 ORDER BY instance_id`,
    [selector]
  );
  return rows;
}

module.exports = { getInstance, heartbeat, offline, register, team };
