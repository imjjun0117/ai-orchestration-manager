#!/usr/bin/env node

const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  Client,
  Events,
  GatewayIntentBits,
  RESTEvents,
  Routes,
} = require("discord.js");
const { WebSocketShardDestroyRecovery } = require("@discordjs/ws");
const { Pool } = require("pg");
const { getInstanceBoundToken } = require("../src/channels/channelCredentialService");
const { ROLES } = require("../src/controlPlane/roleConfig");
const {
  DEFAULT_PROFILES,
  loadInputs,
  withCredentialEnvironment,
} = require("./phase17-discord-author-smoke");

const repoRoot = path.resolve(__dirname, "..");
const ONLINE_STATUSES = new Set(["ONLINE", "BUSY", "DEGRADED"]);

function parseArgs(argv) {
  let confirmed = false;
  let controlEnvFile = ".env";
  let useLatestTaskChannel = false;
  let maxRateLimitRequests = 12;
  const profiles = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-live-discord") confirmed = true;
    else if (argument === "--use-latest-task-channel") useLatestTaskChannel = true;
    else if (argument === "--control-env") controlEnvFile = argv[++index];
    else if (argument === "--max-rate-limit-requests") maxRateLimitRequests = Number.parseInt(argv[++index], 10);
    else profiles.push(argument);
  }
  if (!confirmed) throw new Error("live Discord resilience smoke requires --confirm-live-discord");
  if (!Number.isInteger(maxRateLimitRequests) || maxRateLimitRequests < 12 || maxRateLimitRequests > 40) {
    throw new Error("--max-rate-limit-requests must be an integer from 12 to 40");
  }
  const selectedProfiles = profiles.length ? profiles : DEFAULT_PROFILES;
  if (selectedProfiles.length !== ROLES.length) throw new Error("exactly six role profile files are required");
  return { controlEnvFile, maxRateLimitRequests, profiles: selectedProfiles, useLatestTaskChannel };
}

function childEnvironment(profile, baseEnv = process.env) {
  const env = { ...baseEnv, ENV_FILE: path.resolve(repoRoot, profile.file) };
  for (const key of Object.keys(profile.env)) delete env[key];
  delete env.DISCORD_TOKEN;
  delete env.CHANNEL_TOKEN;
  return env;
}

function entrypointFor(profile) {
  return profile.config.role === "manager" ? "managerBot.js" : "roleBot.js";
}

function captureOutput(child, limit = 8_192) {
  let output = "";
  const append = (chunk) => { output = `${output}${chunk.toString()}`.slice(-limit); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

function spawnRoleProcess(profile, { spawnProcess = spawn } = {}) {
  const child = spawnProcess(process.execPath, [path.join(repoRoot, entrypointFor(profile))], {
    cwd: repoRoot,
    env: childEnvironment(profile),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.phase17Output = captureOutput(child);
  return child;
}

async function poll(check, label, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

async function instanceRow(db, instanceId) {
  const { rows } = await db.query(
    "SELECT instance_id, bot_role, discord_user_id, pid, status FROM bot_instances WHERE instance_id = $1",
    [instanceId]
  );
  return rows[0] || null;
}

async function waitForOnline(child, profile, expectedDiscordUserId, db) {
  return poll(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = String(child.phase17Output?.() || "").trim().split(/\r?\n/).slice(-1)[0] || "no process output";
      throw new Error(`${profile.config.instanceId} exited before ONLINE: ${detail}`);
    }
    const row = await instanceRow(db, profile.config.instanceId);
    return row
      && Number(row.pid) === Number(child.pid)
      && ONLINE_STATUSES.has(row.status)
      && String(row.discord_user_id) === String(expectedDiscordUserId)
      ? row : null;
  }, `${profile.config.instanceId} ONLINE registration`);
}

async function stopExactChild(child, signal, { requireCleanExit = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { code: child?.exitCode, signal: child?.signalCode };
  if (!child.kill(signal)) throw new Error(`failed to signal process ${child.pid}`);
  const exit = await waitForExit(child);
  if (requireCleanExit && exit.code !== 0) throw new Error(`process ${child.pid} did not stop cleanly`);
  return exit;
}

async function restoreOffline(profile, expectedDiscordUserId, db) {
  const current = await instanceRow(db, profile.config.instanceId);
  if (!current || current.status === "OFFLINE") return;
  const repair = spawnRoleProcess(profile);
  try {
    await waitForOnline(repair, profile, expectedDiscordUserId, db);
    await stopExactChild(repair, "SIGTERM", { requireCleanExit: true });
    await poll(async () => (await instanceRow(db, profile.config.instanceId))?.status === "OFFLINE", `${profile.config.instanceId} cleanup OFFLINE`);
  } finally {
    await stopExactChild(repair, "SIGKILL").catch(() => {});
  }
}

async function exerciseProcessRecovery(profile, expectedDiscordUserId, db) {
  let initial = null;
  let replacement = null;
  let failure = null;
  try {
    initial = spawnRoleProcess(profile);
    const first = await waitForOnline(initial, profile, expectedDiscordUserId, db);
    const forcedExit = await stopExactChild(initial, "SIGKILL");
    if (forcedExit.signal !== "SIGKILL") throw new Error(`${profile.config.instanceId} was not terminated by SIGKILL`);
    const stale = await instanceRow(db, profile.config.instanceId);
    if (!stale || Number(stale.pid) !== Number(first.pid) || !ONLINE_STATUSES.has(stale.status)) {
      throw new Error(`${profile.config.instanceId} did not retain detectable stale state after SIGKILL`);
    }
    replacement = spawnRoleProcess(profile);
    const restarted = await waitForOnline(replacement, profile, expectedDiscordUserId, db);
    if (Number(restarted.pid) === Number(first.pid)) throw new Error(`${profile.config.instanceId} restart did not receive a new pid`);
    const cleanExit = await stopExactChild(replacement, "SIGTERM", { requireCleanExit: true });
    if (cleanExit.code !== 0) throw new Error(`${profile.config.instanceId} replacement did not exit cleanly`);
    const offline = await poll(async () => {
      const row = await instanceRow(db, profile.config.instanceId);
      return row?.status === "OFFLINE" ? row : null;
    }, `${profile.config.instanceId} OFFLINE registration`);
    return {
      role: profile.config.role,
      instanceId: profile.config.instanceId,
      expectedDiscordUserId,
      initialPid: Number(first.pid),
      restartPid: Number(restarted.pid),
      staleStatus: stale.status,
      finalStatus: offline.status,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await stopExactChild(initial, "SIGKILL").catch(() => {});
    await stopExactChild(replacement, "SIGKILL").catch(() => {});
    if (failure) {
      await restoreOffline(profile, expectedDiscordUserId, db).catch((cleanupError) => {
        failure.message = `${failure.message}; cleanup failed: ${cleanupError.message}`;
      });
    }
  }
}

function validateProcessRecoveryEvidence(profiles, records) {
  if (records.length !== profiles.length) throw new Error("process recovery evidence is incomplete");
  const byRole = new Map(records.map((record) => [record.role, record]));
  for (const { config } of profiles) {
    const record = byRole.get(config.role);
    if (!record || record.instanceId !== config.instanceId || record.initialPid === record.restartPid) {
      throw new Error(`process recovery evidence is invalid for ${config.instanceId}`);
    }
    if (!ONLINE_STATUSES.has(record.staleStatus) || record.finalStatus !== "OFFLINE") {
      throw new Error(`process lifecycle evidence is invalid for ${config.instanceId}`);
    }
  }
  return true;
}

function eventWithin(emitter, event, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`${event} was not observed within ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (...args) => {
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(args);
    };
    emitter.once(event, handler);
  });
}

async function forceGatewayResume(client) {
  const shard = client.ws?._ws?.strategy?.shards?.first?.();
  if (!shard || typeof shard.destroy !== "function") throw new Error("discord.js gateway shard is unavailable for controlled resume");
  const reconnecting = eventWithin(client, Events.ShardReconnecting);
  const resumed = eventWithin(client, Events.ShardResume);
  await shard.destroy({
    code: 4_000,
    reason: "Phase 17 controlled reconnect smoke",
    recover: WebSocketShardDestroyRecovery.Resume,
  });
  await Promise.all([reconnecting, resumed]);
  await poll(() => client.isReady(), "Discord client Ready after shard resume", { timeoutMs: 10_000, intervalMs: 50 });
  return true;
}

async function probeRateLimit(client, channelId, maxRequests) {
  const events = [];
  const listener = (data) => events.push({
    global: Boolean(data.global),
    retryAfter: Number(data.retryAfter),
    scope: data.scope,
  });
  client.rest.on(RESTEvents.RateLimited, listener);
  let completed = 0;
  try {
    while (events.length === 0 && completed < maxRequests) {
      const count = Math.min(4, maxRequests - completed);
      await Promise.all(Array.from({ length: count }, () => client.rest.get(
        Routes.channelMessages(channelId),
        { query: new URLSearchParams({ limit: "1" }) }
      )));
      completed += count;
    }
    if (events.length === 0) throw new Error(`Discord rate-limit event was not observed within ${maxRequests} requests`);
    if (!events.some((event) => event.retryAfter > 0)) throw new Error("Discord rate-limit event did not require a positive wait");
    await client.rest.get(Routes.channelMessages(channelId), {
      query: new URLSearchParams({ limit: "1" }),
    });
    if (!client.isReady()) throw new Error("Discord gateway was not Ready after REST rate-limit recovery");
    return {
      requestsBeforeRecoveryProbe: completed,
      rateLimitEvents: events.length,
      maxRetryAfterMs: Math.max(...events.map(({ retryAfter }) => retryAfter)),
      recoveredRequest: true,
    };
  } finally {
    client.rest.off(RESTEvents.RateLimited, listener);
  }
}

function validateRateLimitEvidence(profiles, records) {
  if (records.length !== profiles.length) throw new Error("rate-limit evidence is incomplete");
  const byRole = new Map(records.map((record) => [record.role, record]));
  for (const { config } of profiles) {
    const record = byRole.get(config.role);
    if (!record || record.rateLimitEvents < 1 || record.maxRetryAfterMs <= 0 || !record.recoveredRequest) {
      throw new Error(`rate-limit recovery evidence is invalid for ${config.instanceId}`);
    }
  }
  return true;
}

async function resolveChannelId(inputs, options, db) {
  if (inputs.channelId) return inputs.channelId;
  if (!options.useLatestTaskChannel) throw new Error("Discord channel selection was not authorized");
  const { rows } = await db.query(
    `SELECT channel_id, MAX(created_at) AS latest
     FROM tasks WHERE channel_id ~ $1
     GROUP BY channel_id ORDER BY latest DESC LIMIT 2`,
    ["^[0-9]{17,20}$"]
  );
  if (rows.length !== 1) throw new Error("latest task channel fallback requires exactly one numeric Discord channel candidate");
  return String(rows[0].channel_id);
}

async function assertIdleControlPlane(db) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM role_jobs WHERE status IN ('QUEUED','RETRY_WAIT','RUNNING')) AS active_jobs,
       (SELECT COUNT(*)::int FROM outbox_events WHERE status IN ('PENDING','DISPATCHING','RETRY_WAIT')) AS pending_outbox,
       (SELECT COUNT(*)::int FROM role_jobs job
        WHERE job.status IN ('NEEDS_RECONCILIATION','DEAD_LETTER')
          AND NOT EXISTS (
            SELECT 1 FROM phase17_reconciliation_actions action
            WHERE action.item_type='ROLE_JOB' AND action.item_id=job.id
              AND action.after_status=job.status
              AND action.after_revision=job.reconciliation_revision
          )) AS unhealthy_jobs,
       (SELECT COUNT(*)::int FROM outbox_events event
        WHERE event.status IN ('NEEDS_RECONCILIATION','DEAD_LETTER')
          AND NOT EXISTS (
            SELECT 1 FROM phase17_reconciliation_actions action
            WHERE action.item_type='OUTBOX_EVENT' AND action.item_id=event.id
              AND action.after_status=event.status
              AND action.after_revision=event.reconciliation_revision
          )) AS unhealthy_outbox`
  );
  const state = rows[0];
  if (Object.values(state).some((value) => Number(value) !== 0)) throw new Error("control plane must be idle and healthy before resilience smoke");
  return state;
}

async function loadExpectedIdentities(inputs, db) {
  const instanceIds = inputs.profiles.map(({ config }) => config.instanceId);
  const { rows } = await db.query(
    "SELECT instance_id, bot_role, discord_user_id, status FROM bot_instances WHERE instance_id = ANY($1) ORDER BY instance_id",
    [instanceIds]
  );
  if (rows.length !== inputs.profiles.length) throw new Error("DB identity bindings are incomplete");
  const identities = new Map();
  const distinct = new Set();
  for (const profile of inputs.profiles) {
    const row = rows.find((candidate) => candidate.instance_id === profile.config.instanceId);
    if (!row || row.bot_role !== profile.config.role || !row.discord_user_id) throw new Error(`DB identity binding is incomplete for ${profile.config.instanceId}`);
    if (row.status !== "OFFLINE") throw new Error(`${profile.config.instanceId} must be OFFLINE before resilience smoke`);
    const identity = String(row.discord_user_id);
    if (distinct.has(identity)) throw new Error("Discord identities must be distinct for all six roles");
    distinct.add(identity);
    identities.set(profile.config.instanceId, identity);
  }
  return identities;
}

async function runLiveSmoke(options) {
  const inputs = loadInputs(options);
  const controlPool = new Pool({ connectionString: inputs.controlDatabaseUrl });
  const clients = new Map();
  const credentials = new Map();
  try {
    await assertIdleControlPlane(controlPool);
    const channelId = await resolveChannelId(inputs, options, controlPool);
    const expectedIdentities = await loadExpectedIdentities(inputs, controlPool);
    const processRecords = [];
    for (const profile of inputs.profiles) {
      processRecords.push(await exerciseProcessRecovery(
        profile,
        expectedIdentities.get(profile.config.instanceId),
        controlPool
      ));
      console.error(`[phase17-resilience] ${profile.config.role} forced restart PASS`);
    }
    validateProcessRecoveryEvidence(inputs.profiles, processRecords);

    for (const profile of inputs.profiles) {
      const pool = new Pool({ connectionString: profile.config.databaseUrl });
      try {
        const token = await withCredentialEnvironment(profile.env, () => getInstanceBoundToken(
          { botInstanceId: profile.config.instanceId }, { db: pool }
        ));
        if (!token) throw new Error(`ACTIVE Discord credential is missing for ${profile.config.instanceId}`);
        credentials.set(profile.config.instanceId, token);
      } finally {
        await pool.end().catch(() => {});
      }
    }
    for (const profile of inputs.profiles) {
      const client = new Client({ intents: [GatewayIntentBits.Guilds] });
      clients.set(profile.config.instanceId, client);
      await client.login(credentials.get(profile.config.instanceId));
      credentials.delete(profile.config.instanceId);
      if (String(client.user?.id) !== expectedIdentities.get(profile.config.instanceId)) {
        throw new Error(`Discord identity changed for ${profile.config.instanceId}`);
      }
      await poll(
        () => client.isReady(),
        `${profile.config.instanceId} initial Discord Ready`,
        { timeoutMs: 30_000, intervalMs: 100 }
      );
      console.error(`[phase17-resilience] ${profile.config.role} initial Ready PASS`);
    }
    const resumeResults = await Promise.all(inputs.profiles.map(async ({ config }) => {
      await forceGatewayResume(clients.get(config.instanceId));
      console.error(`[phase17-resilience] ${config.role} gateway resume PASS`);
      return { role: config.role, resumed: true };
    }));
    const rateLimitRecords = await Promise.all(inputs.profiles.map(async ({ config }) => {
      const record = {
        role: config.role,
        ...await probeRateLimit(clients.get(config.instanceId), channelId, options.maxRateLimitRequests),
      };
      console.error(`[phase17-resilience] ${config.role} REST rate-limit recovery PASS`);
      return record;
    }));
    validateRateLimitEvidence(inputs.profiles, rateLimitRecords);
    await assertIdleControlPlane(controlPool);
    return {
      mode: "shadow",
      forcedProcessRestarts: processRecords.length,
      gatewayResumes: resumeResults.filter(({ resumed }) => resumed).length,
      rateLimitedRoles: rateLimitRecords.length,
      recoveredRateLimitRequests: rateLimitRecords.filter(({ recoveredRequest }) => recoveredRequest).length,
      discordMessagesCreated: 0,
      finalOfflineInstances: processRecords.filter(({ finalStatus }) => finalStatus === "OFFLINE").length,
    };
  } finally {
    credentials.clear();
    await Promise.all([...clients.values()].map((client) => client.destroy().catch(() => {})));
    await controlPool.end().catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const result = await runLiveSmoke(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(`[phase17-resilience-smoke] ${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  assertIdleControlPlane,
  childEnvironment,
  entrypointFor,
  eventWithin,
  forceGatewayResume,
  parseArgs,
  poll,
  probeRateLimit,
  runLiveSmoke,
  validateProcessRecoveryEvidence,
  validateRateLimitEvidence,
  waitForExit,
};
