#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const { loadRoleConfig, validateSixRoleSet } = require("../src/controlPlane/roleConfig");
const { validateContainerImage } = require("../src/workspace/sandboxService");

const repoRoot = path.resolve(__dirname, "..");

function resolveControlDatabaseUrl(env = process.env, { fileSystem = fs, root = repoRoot } = {}) {
  if (String(env.MULTIBOT_CONTROL_DATABASE_URL || "").trim()) return String(env.MULTIBOT_CONTROL_DATABASE_URL).trim();
  const controlEnvFile = path.resolve(root, env.PHASE17_CONTROL_ENV_FILE || ".env");
  if (!fileSystem.existsSync(controlEnvFile)) throw new Error("MULTIBOT_CONTROL_DATABASE_URL is required for six-role credential preflight");
  const parsed = dotenv.parse(fileSystem.readFileSync(controlEnvFile));
  const databaseUrl = String(parsed.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("control env file does not contain DATABASE_URL");
  return databaseUrl;
}

function loadConfig(file) {
  const envPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(envPath)) throw new Error(`env file not found: ${file}`);
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  if (parsed.DISCORD_TOKEN || parsed.CHANNEL_TOKEN) {
    throw new Error(`${file} contains a plaintext Discord token; import it into channel_credentials instead`);
  }
  const env = { ...process.env, ...parsed };
  const config = loadRoleConfig(env);
  return { ...config, envPath, parsed, env };
}

function requiredProfileValue(config, name) {
  const value = String(config.parsed?.[name] || "").trim();
  if (!value) throw new Error(`${config.role} profile requires ${name}`);
  return value;
}

function profileEnabled(config, name) {
  return requiredProfileValue(config, name).toLowerCase() === "true";
}

function defaultGitIsBare(repository) {
  return execFileSync("git", ["-C", repository, "rev-parse", "--is-bare-repository"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim() === "true";
}

function defaultInspectImage(image) {
  return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertDirectory(directory, label, { fileSystem = fs, requiredMode = null } = {}) {
  if (!path.isAbsolute(directory)) throw new Error(`${label} must be an absolute path`);
  const stat = fileSystem.statSync(directory);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (requiredMode !== null && (stat.mode & 0o777) !== requiredMode) {
    throw new Error(`${label} permissions must be ${requiredMode.toString(8).padStart(4, "0")}`);
  }
}

function realpath(fileSystem, value) {
  const native = fileSystem.realpathSync?.native;
  return native ? native(value) : fileSystem.realpathSync(value);
}

function validateExecutionTopology(
  configs,
  {
    fileSystem = fs,
    gitIsBare = defaultGitIsBare,
    inspectImage = defaultInspectImage,
  } = {}
) {
  const modes = new Set(configs.map((config) => config.mode));
  const executionModes = new Set(configs.map((config) => config.executionMode));
  if (modes.size !== 1) throw new Error("all six role profiles must use the same MULTIBOT_ROLE_MODE");
  if (executionModes.size !== 1) throw new Error("all six role profiles must use the same ROLE_WORKER_EXECUTION");
  const [mode] = modes;
  const [executionMode] = executionModes;
  if (mode !== "enforced") {
    if (executionMode === "active") throw new Error("ROLE_WORKER_EXECUTION=active requires MULTIBOT_ROLE_MODE=enforced");
    return { mode, executionMode };
  }
  if (executionMode !== "active") {
    throw new Error("MULTIBOT_ROLE_MODE=enforced requires ROLE_WORKER_EXECUTION=active for all six profiles");
  }

  const coder = configs.find((config) => config.role === "coder");
  const qa = configs.find((config) => config.role === "qa");
  const manager = configs.find((config) => config.role === "manager");
  for (const config of [manager, coder, qa]) {
    if (!profileEnabled(config, "ISOLATED_WORKSPACE_MODE")) {
      throw new Error(`${config.role} profile requires ISOLATED_WORKSPACE_MODE=true`);
    }
    if (!profileEnabled(config, "CODER_WRITE_ENABLED")) {
      throw new Error(`${config.role} profile requires CODER_WRITE_ENABLED=true`);
    }
  }
  const finalizerActorId = requiredProfileValue(coder, "FINALIZER_ACTOR_ID");
  if (finalizerActorId !== manager.instanceId) {
    throw new Error("coder FINALIZER_ACTOR_ID must equal the active Manager BOT_INSTANCE_ID");
  }
  const approvalTtlMs = Number.parseInt(requiredProfileValue(coder, "CANDIDATE_APPROVAL_TTL_MS"), 10);
  const finalizerLeaseTtlMs = Number.parseInt(requiredProfileValue(coder, "FINALIZER_LEASE_TTL_MS"), 10);
  if (!Number.isInteger(approvalTtlMs) || approvalTtlMs < 60_000
      || !Number.isInteger(finalizerLeaseTtlMs) || finalizerLeaseTtlMs < approvalTtlMs) {
    throw new Error("coder approval TTL must be at least 60000ms and no longer than its finalizer lease TTL");
  }
  const coderRoot = requiredProfileValue(coder, "ISOLATED_WORKSPACE_ROOT");
  const qaRoot = requiredProfileValue(qa, "ISOLATED_WORKSPACE_ROOT");
  if (coderRoot !== qaRoot) throw new Error("coder and qa profiles must use the same ISOLATED_WORKSPACE_ROOT");
  assertDirectory(coderRoot, "ISOLATED_WORKSPACE_ROOT", { fileSystem, requiredMode: 0o700 });

  const canonical = requiredProfileValue(coder, "WORKSPACE_DIR");
  assertDirectory(canonical, "coder WORKSPACE_DIR", { fileSystem });
  if (!gitIsBare(canonical)) throw new Error("coder WORKSPACE_DIR must be a bare canonical repository");
  const realCanonical = realpath(fileSystem, canonical);
  const realIsolationRoot = realpath(fileSystem, coderRoot);
  if (realCanonical === realIsolationRoot
      || realCanonical.startsWith(`${realIsolationRoot}${path.sep}`)
      || realIsolationRoot.startsWith(`${realCanonical}${path.sep}`)) {
    throw new Error("canonical repository and isolation root must not contain each other");
  }

  if (requiredProfileValue(qa, "ISOLATED_SANDBOX_BACKEND").toLowerCase() !== "container") {
    throw new Error("qa profile requires ISOLATED_SANDBOX_BACKEND=container");
  }
  const image = validateContainerImage(requiredProfileValue(qa, "SANDBOX_CONTAINER_IMAGE"));
  if (!inspectImage(image)) throw new Error("qa container image could not be verified locally");
  const qaScript = String(qa.parsed?.QA_NPM_SCRIPT || "test").trim();
  if (!/^[a-zA-Z0-9:_-]+$/.test(qaScript)) throw new Error("QA_NPM_SCRIPT contains unsupported characters");
  return {
    mode,
    executionMode,
    canonical: realCanonical,
    isolationRoot: realIsolationRoot,
    qaImage: image,
    finalizerActorId,
  };
}

async function preflight(configs, controlDatabaseUrl, { PoolClass = Pool } = {}) {
  if (!controlDatabaseUrl) throw new Error("MULTIBOT_CONTROL_DATABASE_URL is required for six-role credential preflight");
  validateSixRoleSet(configs);
  validateExecutionTopology(configs);
  const control = new PoolClass({ connectionString: controlDatabaseUrl });
  try {
    const { rows } = await control.query(
      `SELECT bot_instance_id, status, metadata_json->>'tokenFingerprint' AS token_fingerprint
       FROM channel_credentials WHERE channel_type = 'discord' AND bot_instance_id = ANY($1)`,
      [configs.map((config) => config.instanceId)]
    );
    const credentials = new Map(rows.map((row) => [row.bot_instance_id, row]));
    for (const config of configs) {
      const credential = credentials.get(config.instanceId);
      if (!credential || credential.status !== "ACTIVE" || !credential.token_fingerprint) {
        throw new Error(`ACTIVE fingerprinted Discord credential is missing for ${config.instanceId}`);
      }
      config.tokenFingerprint = credential.token_fingerprint;
      const rolePool = new PoolClass({ connectionString: config.databaseUrl });
      try {
        const principal = await rolePool.query("SELECT SESSION_USER AS principal");
        const binding = await control.query(
          "SELECT bot_role, enabled FROM bot_role_principals WHERE db_principal = $1",
          [principal.rows[0].principal]
        );
        if (!binding.rows[0] || !binding.rows[0].enabled || binding.rows[0].bot_role !== config.role) {
          throw new Error(`DB principal for ${config.instanceId} is not bound to role ${config.role}`);
        }
      } finally {
        await rolePool.end();
      }
    }
    validateSixRoleSet(configs);
  } finally {
    await control.end();
  }
}

function prefixStream(stream, output, prefix) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) if (line) output.write(`${prefix} ${line}\n`);
  });
  stream.on("end", () => { if (buffer) output.write(`${prefix} ${buffer}\n`); });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 6) throw new Error("Usage: npm run multibot:phase17 -- <six role env files>");
  const configs = argv.map(loadConfig);
  await preflight(configs, resolveControlDatabaseUrl());
  const children = [];
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = code;
    for (const child of children) if (!child.killed) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of children) if (!child.killed) child.kill("SIGKILL");
      process.exit(code);
    }, 10_000).unref();
  };
  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));
  for (const config of configs) {
    const childEnv = { ...config.env, ENV_FILE: config.envPath };
    delete childEnv.MULTIBOT_CONTROL_DATABASE_URL;
    delete childEnv.DISCORD_TOKEN;
    delete childEnv.CHANNEL_TOKEN;
    const entrypoint = config.role === "manager" ? "managerBot.js" : "roleBot.js";
    const child = spawn(process.execPath, [path.join(repoRoot, entrypoint)], {
      cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const label = `[${config.role}/${config.instanceId}]`;
    console.error(`${label} starting mode=${config.mode} pid=${child.pid}`);
    prefixStream(child.stdout, process.stdout, label);
    prefixStream(child.stderr, process.stderr, label);
    child.on("exit", (code, signal) => {
      console.error(`${label} exited ${signal ? `signal=${signal}` : `code=${code}`}`);
      if (!shuttingDown && code !== 0) shutdown(code || 1);
    });
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`[phase17-multibot] ${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  loadConfig,
  main,
  preflight,
  resolveControlDatabaseUrl,
  validateExecutionTopology,
};
