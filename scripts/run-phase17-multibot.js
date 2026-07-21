#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const { loadRoleConfig, validateSixRoleSet } = require("../src/controlPlane/roleConfig");

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

async function preflight(configs, controlDatabaseUrl) {
  if (!controlDatabaseUrl) throw new Error("MULTIBOT_CONTROL_DATABASE_URL is required for six-role credential preflight");
  const control = new Pool({ connectionString: controlDatabaseUrl });
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
      const rolePool = new Pool({ connectionString: config.databaseUrl });
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

module.exports = { loadConfig, main, preflight, resolveControlDatabaseUrl };
