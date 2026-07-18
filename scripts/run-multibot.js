#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");
const botPath = path.join(repoRoot, "bot.js");

function usage() {
  console.error(
    [
      "Usage: npm run multibot -- .env.bot-a .env.bot-b [...more env files]",
      "",
      "Each env file should define at least:",
      "  DISCORD_TOKEN=...",
      "  BOT_INSTANCE_ID=bot-a",
      "  COMMAND_PREFIX=!a",
      "",
      "Use the same DATABASE_URL and WORKSPACE_DIR when you intentionally want to reproduce multi-bot races.",
    ].join("\n")
  );
}

function sanitizeInstanceId(value, fallback) {
  return String(value || fallback || "bot")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 64) || "bot";
}

function loadEnvFile(filePath) {
  const absPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`env file not found: ${filePath}`);
  }
  const parsed = dotenv.parse(fs.readFileSync(absPath));
  const fallbackId = path.basename(filePath).replace(/^\.env\.?/, "").replace(/\.local$/, "") || "bot";
  const instanceId = sanitizeInstanceId(parsed.BOT_INSTANCE_ID, fallbackId);
  const commandPrefix = String(parsed.COMMAND_PREFIX || "!").trim() || "!";
  return { absPath, parsed, instanceId, commandPrefix };
}

function tokenFingerprint(token) {
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 10);
}

function prefixStream(stream, output, prefix) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.length > 0) {
        output.write(`${prefix} ${line}\n`);
      }
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      output.write(`${prefix} ${buffer}\n`);
    }
  });
}

const envFiles = process.argv.slice(2);
if (envFiles.length < 2) {
  usage();
  process.exit(1);
}

let configs;
try {
  configs = envFiles.map(loadEnvFile);
} catch (err) {
  console.error(`[multibot] ${err.message}`);
  process.exit(1);
}

const missingToken = configs.filter((config) => !config.parsed.DISCORD_TOKEN);
if (missingToken.length > 0) {
  for (const config of missingToken) {
    console.error(`[multibot] ${config.absPath} is missing DISCORD_TOKEN`);
  }
  process.exit(1);
}

const seenInstances = new Set();
for (const config of configs) {
  if (seenInstances.has(config.instanceId)) {
    console.error(`[multibot] duplicate BOT_INSTANCE_ID: ${config.instanceId}`);
    process.exit(1);
  }
  seenInstances.add(config.instanceId);
}

const prefixCounts = new Map();
const tokenCounts = new Map();
for (const config of configs) {
  prefixCounts.set(config.commandPrefix, (prefixCounts.get(config.commandPrefix) || 0) + 1);
  const fingerprint = tokenFingerprint(config.parsed.DISCORD_TOKEN);
  tokenCounts.set(fingerprint, (tokenCounts.get(fingerprint) || 0) + 1);
}

for (const [prefix, count] of prefixCounts.entries()) {
  if (count > 1) {
    console.error(`[multibot] warning: ${count} instances share COMMAND_PREFIX=${prefix}; they will all handle the same commands.`);
  }
}

for (const [fingerprint, count] of tokenCounts.entries()) {
  if (fingerprint && count > 1) {
    console.error(`[multibot] warning: ${count} env files appear to use the same DISCORD_TOKEN fingerprint=${fingerprint}.`);
  }
}

const children = [];
let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
    process.exit(exitCode);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const config of configs) {
  const childEnv = {
    ...process.env,
    ...config.parsed,
    ENV_FILE: config.absPath,
    BOT_INSTANCE_ID: config.instanceId,
    COMMAND_PREFIX: config.commandPrefix,
  };
  const child = spawn(process.execPath, [botPath], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const label = `[${config.instanceId}]`;
  console.error(`${label} starting env=${config.absPath} prefix=${config.commandPrefix} pid=${child.pid}`);
  prefixStream(child.stdout, process.stdout, label);
  prefixStream(child.stderr, process.stderr, label);

  child.on("exit", (code, signal) => {
    const exitLabel = signal ? `signal=${signal}` : `code=${code}`;
    console.error(`${label} exited ${exitLabel}`);
    if (!shuttingDown && code !== 0) {
      shutdown(code || 1);
    }
  });
}
