#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");
const envFile = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(repoRoot, ".env");

if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile, override: false });
}

if (!process.env.LOG_FILE) {
  const phase13LogDir = path.join(os.tmpdir(), "ai-manager-phase13-logs");
  fs.mkdirSync(phase13LogDir, { recursive: true });
  process.env.LOG_FILE = path.join(phase13LogDir, `phase13-${process.pid}.log`);
}

const db = require("../src/db");
const workspaceLockService = require("../src/core/workspaceLockService");
const shell = require("../services/shell");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

function decodeConfig(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function parseArgs(argv) {
  const args = {
    workers: 8,
    holdMs: 1500,
    ttlMs: 5000,
    workspace: null,
    skipProcessSmoke: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--workers") {
      args.workers = Number.parseInt(argv[++i], 10);
    } else if (value === "--hold-ms") {
      args.holdMs = Number.parseInt(argv[++i], 10);
    } else if (value === "--ttl-ms") {
      args.ttlMs = Number.parseInt(argv[++i], 10);
    } else if (value === "--workspace") {
      args.workspace = path.resolve(argv[++i]);
    } else if (value === "--skip-process-smoke") {
      args.skipProcessSmoke = true;
    } else if (value === "--help" || value === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!Number.isInteger(args.workers) || args.workers < 2) {
    throw new Error("--workers must be an integer >= 2");
  }
  if (!Number.isInteger(args.holdMs) || args.holdMs < 100) {
    throw new Error("--hold-ms must be an integer >= 100");
  }
  if (!Number.isInteger(args.ttlMs) || args.ttlMs < 500) {
    throw new Error("--ttl-ms must be an integer >= 500");
  }
  if (args.ttlMs <= args.holdMs + 500) {
    throw new Error("--ttl-ms must be at least 500ms longer than --hold-ms for stable contention checks");
  }

  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: npm run stress:locks -- [--workers 8] [--workspace /tmp/workspace]",
      "",
      "Runs local Postgres-backed stress checks for workspace locks and task process ownership.",
      "No Discord token or agent CLI is required.",
    ].join("\n")
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function redactDatabaseUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "****";
    if (parsed.username) parsed.username = parsed.username ? "****" : "";
    return parsed.toString();
  } catch (err) {
    return "<configured>";
  }
}

async function assertDatabaseReady() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Set it in .env or ENV_FILE before running this script.");
  }

  await db.query("SELECT 1");
  const { rows } = await db.query(
    `SELECT
       to_regclass('public.tasks') AS tasks_table,
       to_regclass('public.workspace_locks') AS workspace_locks_table,
       to_regclass('public.command_logs') AS command_logs_table`
  );
  const ready = rows[0] || {};
  if (!ready.tasks_table || !ready.workspace_locks_table || !ready.command_logs_table) {
    throw new Error("Required tables are missing. Apply src/db/schema.sql before running Phase 13 stress checks.");
  }
}

async function deleteLocksFor(workspaceDirs) {
  const keys = [...new Set(workspaceDirs.map(workspaceLockService.normalizeWorkspaceKey).filter(Boolean))];
  if (keys.length > 0) {
    await db.query("DELETE FROM workspace_locks WHERE workspace_key = ANY($1)", [keys]);
  }
  return keys;
}

function buildWorkspaceVariants(baseWorkspace, symlinkWorkspace) {
  const variants = [
    baseWorkspace,
    `${baseWorkspace}${path.sep}`,
    `${path.dirname(baseWorkspace)}${path.sep}.${path.sep}${path.basename(baseWorkspace)}`,
  ];
  if (symlinkWorkspace) {
    variants.push(symlinkWorkspace);
  }
  return variants;
}

function parseWorkerResult(stdout, stderr, code) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith("{"));
  if (!jsonLine) {
    return { kind: "error", message: `worker exited without JSON result (code=${code})`, stdout, stderr };
  }
  try {
    return JSON.parse(jsonLine);
  } catch (err) {
    return { kind: "error", message: `worker JSON parse failed: ${err.message}`, stdout, stderr };
  }
}

function runWorker(config) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, "--worker", encodeConfig(config)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BOT_INSTANCE_ID: config.ownerInstanceId,
        HOST_INSTANCE_ID: config.ownerHostId,
        LOG_FILE: config.logFile,
        WORKSPACE_LOCK_TTL_MS: String(config.ttlMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({
        code,
        result: parseWorkerResult(stdout, stderr, code),
        stdout,
        stderr,
      });
    });
  });
}

async function runWorkerMode(encoded) {
  const config = decodeConfig(encoded);
  await sleep(Math.max(0, config.startAt - Date.now()));

  try {
    const lock = await workspaceLockService.acquireLock({
      workspaceDir: config.workspaceDir,
      ownerHostId: config.ownerHostId,
      ownerInstanceId: config.ownerInstanceId,
      ownerPid: process.pid,
      commandLabel: "phase13-stress-worker",
      ttlMs: config.ttlMs,
    });
    await sleep(config.holdMs);
    await workspaceLockService.releaseLock({
      workspaceDir: config.workspaceDir,
      ownerHostId: config.ownerHostId,
      ownerInstanceId: config.ownerInstanceId,
      ownerPid: process.pid,
    });
    console.log(JSON.stringify({
      kind: "acquired",
      ownerInstanceId: config.ownerInstanceId,
      workspaceKey: lock.workspace_key,
      pid: process.pid,
    }));
  } catch (err) {
    if (workspaceLockService.isLockBusyError(err)) {
      console.log(JSON.stringify({
        kind: "busy",
        ownerInstanceId: config.ownerInstanceId,
        workspaceKey: err.lock ? err.lock.workspace_key : null,
        lockOwnerHostId: err.lock ? err.lock.owner_host_id : null,
        lockOwnerInstanceId: err.lock ? err.lock.owner_instance_id : null,
      }));
    } else {
      console.log(JSON.stringify({
        kind: "error",
        ownerInstanceId: config.ownerInstanceId,
        name: err.name,
        message: err.message,
      }));
      process.exitCode = 1;
    }
  } finally {
    await db.pool.end();
  }
}

async function runContentionStress({ workerCount, workspaceVariants, tempRoot, holdMs, ttlMs }) {
  const expectedKeys = await deleteLocksFor(workspaceVariants);
  assert(expectedKeys.length === 1, `workspace path variants should normalize to one key, got ${expectedKeys.length}: ${expectedKeys.join(", ")}`);

  const startAt = Date.now() + 800;
  const workers = Array.from({ length: workerCount }, (_, index) => {
    const ownerInstanceId = `phase13-worker-${index + 1}`;
    return runWorker({
      workspaceDir: workspaceVariants[index % workspaceVariants.length],
      ownerHostId: "phase13-host",
      ownerInstanceId,
      startAt,
      holdMs,
      ttlMs,
      logFile: path.join(tempRoot, `${ownerInstanceId}.log`),
    });
  });

  const results = await Promise.all(workers);
  const workerErrors = results.filter((entry) => entry.code !== 0 || entry.result.kind === "error");
  if (workerErrors.length > 0) {
    throw new Error(`worker errors: ${JSON.stringify(workerErrors.map((entry) => entry.result), null, 2)}`);
  }

  const acquired = results.filter((entry) => entry.result.kind === "acquired");
  const busy = results.filter((entry) => entry.result.kind === "busy");
  assert(acquired.length === 1, `expected exactly 1 acquired worker, got ${acquired.length}`);
  assert(busy.length === workerCount - 1, `expected ${workerCount - 1} busy workers, got ${busy.length}`);

  for (const entry of results) {
    assert(entry.result.workspaceKey === expectedKeys[0], `worker used unexpected workspace key: ${entry.result.workspaceKey}`);
  }

  const lock = await workspaceLockService.getLock(expectedKeys[0]);
  assert(!lock, `lock should be released after contention test, still held by ${lock && lock.owner_instance_id}`);
  return {
    workspaceKey: expectedKeys[0],
    acquired: acquired[0].result.ownerInstanceId,
    busy: busy.length,
  };
}

async function runOwnerSafetySmoke(workspaceDir) {
  await deleteLocksFor([workspaceDir]);
  const lock = await workspaceLockService.acquireLock({
    workspaceDir,
    ownerHostId: "phase13-host-a",
    ownerInstanceId: "phase13-owner-a",
    ownerPid: 11111,
    commandLabel: "phase13-owner-safety",
    ttlMs: 5000,
  });

  const wrongHostRelease = await workspaceLockService.releaseLock({
    workspaceDir,
    ownerHostId: "phase13-host-b",
    ownerInstanceId: "phase13-owner-a",
    ownerPid: 11111,
  });
  const wrongPidRelease = await workspaceLockService.releaseLock({
    workspaceDir,
    ownerHostId: "phase13-host-a",
    ownerInstanceId: "phase13-owner-a",
    ownerPid: 22222,
  });
  const wrongHeartbeat = await workspaceLockService.heartbeatLock({
    workspaceDir,
    ownerHostId: "phase13-host-b",
    ownerInstanceId: "phase13-owner-a",
    ownerPid: 11111,
    ttlMs: 5000,
  });

  assert(!wrongHostRelease, "wrong host must not release a lock");
  assert(!wrongPidRelease, "wrong pid must not release a lock");
  assert(!wrongHeartbeat, "wrong host must not heartbeat a lock");

  const stillHeld = await workspaceLockService.getLock(lock.workspace_key);
  assert(stillHeld && stillHeld.owner_host_id === "phase13-host-a", "lock owner changed during wrong-owner checks");

  const released = await workspaceLockService.releaseLock({
    workspaceDir,
    ownerHostId: "phase13-host-a",
    ownerInstanceId: "phase13-owner-a",
    ownerPid: 11111,
  });
  assert(released, "correct owner should release the lock");
  return lock.workspace_key;
}

async function runTtlTakeoverSmoke(workspaceDir) {
  await deleteLocksFor([workspaceDir]);
  const first = await workspaceLockService.acquireLock({
    workspaceDir,
    ownerHostId: "phase13-host-a",
    ownerInstanceId: "phase13-ttl-a",
    ownerPid: 33333,
    commandLabel: "phase13-ttl-a",
    ttlMs: 250,
  });
  await sleep(450);
  const second = await workspaceLockService.acquireLock({
    workspaceDir,
    ownerHostId: "phase13-host-b",
    ownerInstanceId: "phase13-ttl-b",
    ownerPid: 44444,
    commandLabel: "phase13-ttl-b",
    ttlMs: 5000,
  });
  assert(first.workspace_key === second.workspace_key, "TTL takeover changed workspace key unexpectedly");
  assert(second.owner_instance_id === "phase13-ttl-b", "expired lock was not taken over by second owner");
  await workspaceLockService.releaseLock({
    workspaceDir,
    ownerHostId: "phase13-host-b",
    ownerInstanceId: "phase13-ttl-b",
    ownerPid: 44444,
  });
  return second.workspace_key;
}

async function waitForTaskProcess(taskId, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { rows } = await db.query(
      `SELECT current_pid, current_pgid, current_host_id, current_owner_instance_id
       FROM tasks
       WHERE id = $1`,
      [taskId]
    );
    const task = rows[0];
    if (task && task.current_pid) {
      return task;
    }
    await sleep(50);
  }
  throw new Error(`task process fields were not populated within ${timeoutMs}ms`);
}

async function runTaskProcessOwnershipSmoke() {
  const taskId = `TASK-PHASE13-${Date.now().toString().slice(-10)}`;
  await db.query(
    `INSERT INTO tasks (id, title, original_request, status, channel_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [taskId, "Phase 13 process ownership smoke", "Phase 13 process ownership smoke", "AUTONOMOUS_EXECUTION", "phase13-channel", "phase13"]
  );

  const oldBotInstanceId = process.env.BOT_INSTANCE_ID;
  const oldHostInstanceId = process.env.HOST_INSTANCE_ID;
  process.env.BOT_INSTANCE_ID = "phase13-shell";
  process.env.HOST_INSTANCE_ID = "phase13-host-shell";

  let running = null;
  try {
    running = shell.runCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 1000);"],
      {
        cwd: repoRoot,
        trusted: true,
        taskId,
        agentName: "phase13-stress",
        timeoutMs: 5000,
      }
    );

    const taskWhileRunning = await waitForTaskProcess(taskId);
    assert(taskWhileRunning.current_host_id === "phase13-host-shell", `unexpected host id: ${taskWhileRunning.current_host_id}`);
    assert(taskWhileRunning.current_owner_instance_id === "phase13-shell", `unexpected owner instance: ${taskWhileRunning.current_owner_instance_id}`);
    assert(taskWhileRunning.current_pid > 0, "current_pid should be positive while command is running");
    if (process.platform !== "win32") {
      assert(taskWhileRunning.current_pgid === taskWhileRunning.current_pid, "current_pgid should match detached child pid on POSIX");
    }

    await running;

    const { rows } = await db.query(
      `SELECT current_pid, current_pgid, current_host_id, current_owner_instance_id
       FROM tasks
       WHERE id = $1`,
      [taskId]
    );
    const taskAfterRun = rows[0];
    assert(taskAfterRun && !taskAfterRun.current_pid && !taskAfterRun.current_pgid && !taskAfterRun.current_host_id && !taskAfterRun.current_owner_instance_id, "task process fields should be cleared after command exit");
    return taskId;
  } finally {
    if (running) {
      await running.catch(() => {});
    }
    if (oldBotInstanceId === undefined) {
      delete process.env.BOT_INSTANCE_ID;
    } else {
      process.env.BOT_INSTANCE_ID = oldBotInstanceId;
    }
    if (oldHostInstanceId === undefined) {
      delete process.env.HOST_INSTANCE_ID;
    } else {
      process.env.HOST_INSTANCE_ID = oldHostInstanceId;
    }
    await db.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  }
}

async function main() {
  const workerIndex = process.argv.indexOf("--worker");
  if (workerIndex !== -1) {
    await runWorkerMode(process.argv[workerIndex + 1]);
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-manager-phase13-"));
  const workspaceDir = args.workspace || path.join(tempRoot, "workspace");
  const symlinkWorkspace = path.join(tempRoot, "workspace-link");

  fs.mkdirSync(workspaceDir, { recursive: true });
  let symlinkCreated = false;
  try {
    fs.symlinkSync(workspaceDir, symlinkWorkspace, "dir");
    symlinkCreated = true;
  } catch (err) {
    console.warn(`[phase13] symlink variant skipped: ${err.message}`);
  }

  const workspaceVariants = buildWorkspaceVariants(workspaceDir, symlinkCreated ? symlinkWorkspace : null);

  try {
    await assertDatabaseReady();
    console.log(`[phase13] database ready: ${redactDatabaseUrl(process.env.DATABASE_URL)}`);

    const contention = await runContentionStress({
      workerCount: args.workers,
      workspaceVariants,
      tempRoot,
      holdMs: args.holdMs,
      ttlMs: args.ttlMs,
    });
    console.log(`[phase13] contention PASS: winner=${contention.acquired}, busy=${contention.busy}, key=${contention.workspaceKey}`);

    const ownerKey = await runOwnerSafetySmoke(workspaceDir);
    console.log(`[phase13] owner safety PASS: key=${ownerKey}`);

    const ttlKey = await runTtlTakeoverSmoke(workspaceDir);
    console.log(`[phase13] ttl takeover PASS: key=${ttlKey}`);

    if (!args.skipProcessSmoke) {
      const taskId = await runTaskProcessOwnershipSmoke();
      console.log(`[phase13] task process ownership PASS: task=${taskId}`);
    }

    await deleteLocksFor(workspaceVariants);
    console.log("[phase13] PASS");
  } finally {
    await deleteLocksFor(workspaceVariants).catch(() => {});
    await db.pool.end().catch(() => {});
    if (!args.workspace) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch(async (err) => {
  console.error(`[phase13] FAIL: ${err.stack || err.message || err}`);
  process.exitCode = 1;
  await db.pool.end().catch(() => {});
});
