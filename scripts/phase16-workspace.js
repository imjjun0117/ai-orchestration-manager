#!/usr/bin/env node
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false, quiet: true });

const db = require("../src/db");
const { migrateDown, migrateUp } = require("../src/db/migrationRunner");
const { listReconciliationCandidates, runtimeIsolationState } = require("../src/workspace/isolatedWorkspaceService");

function usage() {
  return [
    "Usage:",
    "  node scripts/phase16-workspace.js migrate",
    "  node scripts/phase16-workspace.js status",
    "  node scripts/phase16-workspace.js reconcile-list",
    "  node scripts/phase16-workspace.js rollback --confirm-disable-writes",
  ].join("\n");
}

async function status() {
  const migration = await db.query(
    `SELECT id, checksum, applied_at FROM schema_migrations WHERE id = '017_workspace_safety'`
  );
  const state = runtimeIsolationState();
  if (migration.rows.length === 0) return { migration: "NOT_APPLIED", activation: state };
  const counts = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM workspace_leases WHERE released_at IS NULL AND expires_at > CURRENT_TIMESTAMP) AS active_leases,
       (SELECT COUNT(*)::int FROM isolated_workspaces WHERE status <> 'CLEANED') AS open_workspaces,
       (SELECT COUNT(*)::int FROM workspace_finalizations WHERE status = 'CLAIMED') AS claimed_finalizations,
       (SELECT COUNT(*)::int FROM isolated_workspaces WHERE status = 'NEEDS_RECONCILIATION') AS reconciliation_required`
  );
  return { migration: migration.rows[0], activation: state, ...counts.rows[0] };
}

async function main() {
  const command = process.argv[2] || "status";
  if (command === "migrate") {
    const result = await migrateUp("017_workspace_safety");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await status(), null, 2)}\n`);
    return;
  }
  if (command === "reconcile-list") {
    process.stdout.write(`${JSON.stringify(await listReconciliationCandidates(), null, 2)}\n`);
    return;
  }
  if (command === "rollback") {
    if (!process.argv.includes("--confirm-disable-writes")) {
      throw new Error("rollback requires --confirm-disable-writes after CODER_WRITE_ENABLED=false");
    }
    if (String(process.env.CODER_WRITE_ENABLED || "").trim().toLowerCase() === "true") {
      throw new Error("set CODER_WRITE_ENABLED=false before rollback");
    }
    const open = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM workspace_leases WHERE released_at IS NULL AND expires_at > CURRENT_TIMESTAMP) AS active_leases,
         (SELECT COUNT(*)::int FROM workspace_finalizations WHERE status = 'CLAIMED') AS claimed_finalizations`
    );
    if (open.rows[0].active_leases || open.rows[0].claimed_finalizations) {
      throw new Error("rollback blocked while live leases or finalization claims exist");
    }
    const result = await migrateDown("017_workspace_safety", { allowDestructive: true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(usage());
}

main()
  .catch((error) => {
    process.stderr.write(`[phase16] ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
