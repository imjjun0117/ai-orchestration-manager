const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./index");

const MIGRATIONS = Object.freeze({
  "015_delivery_governance": {
    up: path.join(__dirname, "migrations", "015_delivery_governance.up.sql"),
    down: path.join(__dirname, "migrations", "015_delivery_governance.down.sql"),
  },
  "015_delivery_governance_security": {
    up: path.join(__dirname, "migrations", "015_delivery_governance_security.up.sql"),
    down: path.join(__dirname, "migrations", "015_delivery_governance_security.down.sql"),
  },
  "015_delivery_governance_rework": {
    up: path.join(__dirname, "migrations", "015_delivery_governance_rework.up.sql"),
    down: path.join(__dirname, "migrations", "015_delivery_governance_rework.down.sql"),
  },
  "015_delivery_governance_operations": {
    up: path.join(__dirname, "migrations", "015_delivery_governance_operations.up.sql"),
    down: path.join(__dirname, "migrations", "015_delivery_governance_operations.down.sql"),
  },
  "016_channel_credentials": {
    up: path.join(__dirname, "migrations", "016_channel_credentials.up.sql"),
    down: path.join(__dirname, "migrations", "016_channel_credentials.down.sql"),
  },
  "017_workspace_safety": {
    up: path.join(__dirname, "migrations", "017_workspace_safety.up.sql"),
    down: path.join(__dirname, "migrations", "017_workspace_safety.down.sql"),
  },
  "017_workspace_safety_rework": {
    up: path.join(__dirname, "migrations", "017_workspace_safety_rework.up.sql"),
    down: path.join(__dirname, "migrations", "017_workspace_safety_rework.down.sql"),
  },
  "018_durable_control_plane": {
    up: path.join(__dirname, "migrations", "018_durable_control_plane.up.sql"),
    down: path.join(__dirname, "migrations", "018_durable_control_plane.down.sql"),
  },
  "019_phase17_credential_enrollment": {
    up: path.join(__dirname, "migrations", "019_phase17_credential_enrollment.up.sql"),
    down: path.join(__dirname, "migrations", "019_phase17_credential_enrollment.down.sql"),
  },
  "020_phase17_operator_reconciliation": {
    up: path.join(__dirname, "migrations", "020_phase17_operator_reconciliation.up.sql"),
    down: path.join(__dirname, "migrations", "020_phase17_operator_reconciliation.down.sql"),
  },
  "021_phase17_workflow_approvals": {
    up: path.join(__dirname, "migrations", "021_phase17_workflow_approvals.up.sql"),
    down: path.join(__dirname, "migrations", "021_phase17_workflow_approvals.down.sql"),
  },
  "022_phase17_canary_hardening": {
    up: path.join(__dirname, "migrations", "022_phase17_canary_hardening.up.sql"),
    down: path.join(__dirname, "migrations", "022_phase17_canary_hardening.down.sql"),
  },
});

function migrationSource(id, direction) {
  const migration = MIGRATIONS[id];
  if (!migration) throw new Error(`unknown migration: ${id}`);
  if (!["up", "down"].includes(direction)) throw new Error(`unsupported migration direction: ${direction}`);
  return fs.readFileSync(migration[direction], "utf8");
}

function checksum(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

async function ensureLedger(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       checksum TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  );
}

async function migrateUp(id, { pool = db.pool } = {}) {
  const source = migrationSource(id, "up");
  const sourceChecksum = checksum(source);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`migration:${id}`]);
    await ensureLedger(client);
    const { rows } = await client.query("SELECT checksum FROM schema_migrations WHERE id = $1", [id]);
    if (rows[0]) {
      if (rows[0].checksum !== sourceChecksum) {
        throw new Error(`applied migration ${id} checksum does not match the current file`);
      }
      await client.query("COMMIT");
      return { id, direction: "up", applied: false, checksum: sourceChecksum };
    }
    await client.query(source);
    await client.query("INSERT INTO schema_migrations(id, checksum) VALUES ($1, $2)", [id, sourceChecksum]);
    await client.query("COMMIT");
    return { id, direction: "up", applied: true, checksum: sourceChecksum };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function migrateDown(id, { pool = db.pool, allowDestructive = false } = {}) {
  if (!allowDestructive) {
    throw new Error("down migration requires allowDestructive=true");
  }
  const source = migrationSource(id, "down");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`migration:${id}`]);
    await ensureLedger(client);
    const { rows } = await client.query("SELECT checksum FROM schema_migrations WHERE id = $1", [id]);
    if (!rows[0]) {
      await client.query("COMMIT");
      return { id, direction: "down", applied: false };
    }
    await client.query(source);
    await client.query("DELETE FROM schema_migrations WHERE id = $1", [id]);
    await client.query("COMMIT");
    return { id, direction: "down", applied: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  MIGRATIONS,
  checksum,
  migrateDown,
  migrateUp,
  migrationSource,
};
