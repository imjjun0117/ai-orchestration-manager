#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false, quiet: true });

const db = require("../src/db");
const { migrateDown, migrateUp } = require("../src/db/migrationRunner");
const { listReconciliationCandidates, runtimeIsolationState } = require("../src/workspace/isolatedWorkspaceService");
const { getPhase16GateState } = require("../src/workspace/featureFlags");
const approvalService = require("../src/core/approvalService");
const reconciliationService = require("../src/workspace/reconciliationService");
const sandboxService = require("../src/workspace/sandboxService");
const taskControlService = require("../src/workspace/taskControlService");
const workflowService = require("../src/workspace/taskWorkspaceWorkflowService");

const PHASE16_MIGRATIONS = Object.freeze(["017_workspace_safety", "017_workspace_safety_rework"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/phase16-workspace.js migrate",
    "  node scripts/phase16-workspace.js status",
    "  node scripts/phase16-workspace.js prepare <request.json>",
    "  node scripts/phase16-workspace.js sandbox-run <request.json>",
    "  node scripts/phase16-workspace.js candidate-approval <request.json>",
    "  node scripts/phase16-workspace.js approval-show <approval-id>",
    "  node scripts/phase16-workspace.js approval-approve <request.json>",
    "  node scripts/phase16-workspace.js approval-reject <request.json>",
    "  node scripts/phase16-workspace.js control-pause|control-resume|control-kill <request.json>",
    "  node scripts/phase16-workspace.js reconcile-list",
    "  node scripts/phase16-workspace.js reconcile-workspace <request.json> [--apply]",
    "  node scripts/phase16-workspace.js reconcile-finalization <request.json> [--apply]",
    "  node scripts/phase16-workspace.js reconcile-processes <request.json> [--apply]",
    "  node scripts/phase16-workspace.js rollback --confirm-disable-writes",
  ].join("\n");
}

function readRequest(argument) {
  if (!argument) throw new Error(usage());
  const requestPath = fs.realpathSync.native(path.resolve(argument));
  const stat = fs.statSync(requestPath);
  if (!stat.isFile()) throw new Error("request path must be a regular JSON file");
  const parsed = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request JSON must contain an object");
  }
  return parsed;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function status() {
  const migration = await db.query(
    `SELECT id, checksum, applied_at
     FROM schema_migrations
     WHERE id = ANY($1::text[])
     ORDER BY id`,
    [PHASE16_MIGRATIONS]
  );
  const state = {
    ...runtimeIsolationState(),
    gate: await getPhase16GateState({ db }),
  };
  if (migration.rows.length === 0) return { migrations: "NOT_APPLIED", activation: state };
  const counts = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM workspace_leases WHERE released_at IS NULL AND expires_at > CURRENT_TIMESTAMP) AS active_leases,
       (SELECT COUNT(*)::int FROM isolated_workspaces WHERE status <> 'CLEANED') AS open_workspaces,
       (SELECT COUNT(*)::int FROM workspace_finalizations WHERE status = 'CLAIMED') AS claimed_finalizations,
       (SELECT COUNT(*)::int FROM isolated_workspaces WHERE status = 'NEEDS_RECONCILIATION') AS workspace_reconciliation_required,
       (SELECT COUNT(*)::int FROM workspace_finalizations WHERE status = 'NEEDS_RECONCILIATION') AS finalization_reconciliation_required,
       (SELECT COUNT(*)::int FROM tasks WHERE control_state = 'NEEDS_RECONCILIATION') AS task_reconciliation_required`
  );
  return { migrations: migration.rows, activation: state, ...counts.rows[0] };
}

async function main() {
  const command = process.argv[2] || "status";
  if (command === "migrate") {
    const results = [];
    for (const migrationId of PHASE16_MIGRATIONS) results.push(await migrateUp(migrationId));
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  if (command === "status") {
    print(await status());
    return;
  }
  if (command === "prepare") {
    const result = await workflowService.prepareTaskWorkspace(readRequest(process.argv[3]));
    print({
      workspaceId: result.workspace.id,
      taskId: result.workspace.task_id,
      workspacePath: result.workspace.workspace_path,
      status: result.workspace.status,
      leaseId: result.lease.lease_id,
      fencingToken: result.lease.fencing_token,
      contextManifestHash: result.context.contextManifestHash,
    });
    return;
  }
  if (command === "sandbox-run") {
    const request = readRequest(process.argv[3]);
    print(await sandboxService.runSandboxed(request));
    return;
  }
  if (command === "candidate-approval") {
    const result = await workflowService.prepareCandidateApproval(readRequest(process.argv[3]));
    print(result.display);
    return;
  }
  if (command === "approval-show") {
    const approvalId = Number(process.argv[3]);
    if (!Number.isInteger(approvalId) || approvalId <= 0) throw new Error("approval-show requires a numeric approval ID");
    print(await approvalService.getBoundApprovalDisplay({ approvalId }));
    return;
  }
  if (command === "approval-approve") {
    print(await workflowService.finalizeApprovedCandidate(readRequest(process.argv[3])));
    return;
  }
  if (command === "approval-reject") {
    print(await workflowService.rejectCandidateApproval(readRequest(process.argv[3])));
    return;
  }
  if (["control-pause", "control-resume", "control-kill"].includes(command)) {
    const request = readRequest(process.argv[3]);
    const operation = {
      "control-pause": taskControlService.pauseTaskProcess,
      "control-resume": taskControlService.resumeTaskProcess,
      "control-kill": taskControlService.killTaskProcess,
    }[command];
    print(await operation(request));
    return;
  }
  if (command === "reconcile-list") {
    print({
      workspaces: await listReconciliationCandidates(),
      finalizations: await reconciliationService.listFinalizationReconciliationCandidates(),
      processes: await taskControlService.inspectTaskProcesses({}),
    });
    return;
  }
  if (command === "reconcile-workspace" || command === "reconcile-finalization") {
    const request = readRequest(process.argv[3]);
    const apply = process.argv.includes("--apply");
    if (request.apply === true && !apply) throw new Error("an apply request also requires the explicit --apply CLI flag");
    const operation = command === "reconcile-workspace"
      ? reconciliationService.reconcileWorkspace
      : reconciliationService.reconcileFinalization;
    print(await operation({ ...request, apply: request.apply === true && apply }));
    return;
  }
  if (command === "reconcile-processes") {
    const request = readRequest(process.argv[3]);
    const apply = request.apply === true && process.argv.includes("--apply");
    if (request.apply === true && !process.argv.includes("--apply")) {
      throw new Error("an apply request also requires the explicit --apply CLI flag");
    }
    print(apply
      ? await taskControlService.reconcileOrphanedTaskProcesses({ actorId: request.actorId })
      : await taskControlService.inspectTaskProcesses({}));
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
    const results = [];
    for (const migrationId of [...PHASE16_MIGRATIONS].reverse()) {
      results.push(await migrateDown(migrationId, { allowDestructive: true }));
    }
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
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
