#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const repoRoot = __dirname;
const envFilePath = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(repoRoot, ".env");
if (fs.existsSync(envFilePath)) dotenv.config({ path: envFilePath, override: false, quiet: true });

const ROLES = ["worker", "planning-validator", "development-validator", "gate-admin"];
const ROLE_LABELS = {
  worker: "Developer",
  "planning-validator": "PM",
  "development-validator": "Code Reviewer",
  "gate-admin": "Release Manager",
};
const ROLE_PREFIXES = {
  worker: "!dev",
  "planning-validator": "!pm",
  "development-validator": "!review",
  "gate-admin": "!release",
};

function requestedRole(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--role");
  if (index < 0) return null;
  const role = argv[index + 1];
  if (!ROLES.includes(role)) throw new Error(`Unsupported role: ${role || "missing"}`);
  return role;
}

async function selectRole(ask) {
  const lines = ROLES.map((role, index) => `${index + 1}) ${ROLE_LABELS[role]}`).join("\n");
  const answer = String(await ask(`Select bot role:\n${lines}\nChoice`, "1")).trim().toLowerCase();
  const numeric = Number.parseInt(answer, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= ROLES.length) return ROLES[numeric - 1];
  if (ROLES.includes(answer)) return answer;
  const labelMatch = ROLES.find((role) => ROLE_LABELS[role].toLowerCase() === answer);
  if (labelMatch) return labelMatch;
  throw new Error(`Unsupported role: ${answer}`);
}

async function ensureMasterKey(ask, { targetEnvFile = envFilePath } = {}) {
  if (String(process.env.CHANNEL_TOKEN_MASTER_KEY || "").trim()) return false;
  const answer = String(await ask("No channel master key exists. Generate and save one in the local .env?", "yes"))
    .trim()
    .toLowerCase();
  if (!["y", "yes"].includes(answer)) {
    throw new Error("CHANNEL_TOKEN_MASTER_KEY is required to store role credentials");
  }
  if (fs.existsSync(targetEnvFile) && fs.lstatSync(targetEnvFile).isSymbolicLink()) {
    throw new Error("Refusing to write CHANNEL_TOKEN_MASTER_KEY through a symbolic-link .env file");
  }
  const key = crypto.randomBytes(32).toString("base64");
  const needsLeadingNewline = fs.existsSync(targetEnvFile) && fs.statSync(targetEnvFile).size > 0;
  fs.appendFileSync(targetEnvFile, `${needsLeadingNewline ? "\n" : ""}CHANNEL_TOKEN_MASTER_KEY=${key}\n`, { mode: 0o600 });
  fs.chmodSync(targetEnvFile, 0o600);
  process.env.CHANNEL_TOKEN_MASTER_KEY = key;
  return true;
}

function launchRole(role) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bot-runtime.js"), "--role", role], {
      cwd: repoRoot,
      env: { ...process.env, BOT_INSTANCE_ID: role },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else resolve(code ?? 1);
    });
  });
}

function prefixStream(stream, output, prefix) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.length > 0) output.write(`${prefix} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) output.write(`${prefix} ${buffer}\n`);
  });
}

function launchRoles(
  roles = ROLES,
  { spawnProcess = spawn, stdout = process.stdout, stderr = process.stderr } = {}
) {
  return new Promise((resolve, reject) => {
    const children = [];
    let remaining = roles.length;
    let finalCode = 0;
    let shuttingDown = false;
    let settled = false;
    const cleanup = () => {
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
    };
    const finish = () => {
      if (settled || remaining !== 0) return;
      settled = true;
      cleanup();
      resolve(finalCode);
    };
    const stopAll = (exitCode = 0) => {
      if (!shuttingDown) shuttingDown = true;
      if (exitCode !== 0 && finalCode === 0) finalCode = exitCode;
      for (const child of children) {
        if (!child.killed) child.kill("SIGTERM");
      }
    };
    const handleSignal = () => stopAll(0);
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);

    if (roles.length === 0) {
      cleanup();
      resolve(0);
      return;
    }

    for (const role of roles) {
      const envName = `${role.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_COMMAND_PREFIX`;
      const commandPrefix = process.env[envName] || ROLE_PREFIXES[role] || "!";
      const child = spawnProcess(process.execPath, [path.join(repoRoot, "bot-runtime.js"), "--role", role], {
        cwd: repoRoot,
        env: { ...process.env, BOT_INSTANCE_ID: role, COMMAND_PREFIX: commandPrefix },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.supervisorRole = role;
      child.supervisorExited = false;
      children.push(child);
      const label = `[${ROLE_LABELS[role]}]`;
      stdout.write(`[bot-supervisor] Started ${ROLE_LABELS[role]} prefix=${commandPrefix} pid=${child.pid}\n`);
      if (child.stdout) prefixStream(child.stdout, stdout, label);
      if (child.stderr) prefixStream(child.stderr, stderr, label);
      child.once("error", (error) => {
        if (child.supervisorExited) return;
        child.supervisorExited = true;
        remaining -= 1;
        stderr.write(`[bot-supervisor] ${ROLE_LABELS[role]} failed to start: ${error.message}\n`);
        stopAll(1);
        if (remaining === 0 && !settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      });
      child.once("exit", (code, signal) => {
        if (child.supervisorExited) return;
        child.supervisorExited = true;
        remaining -= 1;
        const exitLabel = signal ? `signal=${signal}` : `code=${code}`;
        stderr.write(`[bot-supervisor] ${ROLE_LABELS[role]} exited ${exitLabel}\n`);
        if (!shuttingDown && (signal || code !== 0)) {
          const exitCode = Number.isInteger(code) && code !== 0 ? code : 1;
          stderr.write(
            `[bot-supervisor] DEGRADED: ${ROLE_LABELS[role]} stopped; terminating the remaining roles\n`
          );
          stopAll(exitCode);
        }
        finish();
      });
    }
  });
}

async function interactiveStart() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive bot startup requires a TTY; use --role or BOT_INSTANCE_ID for unattended startup");
  }
  const { interactiveSetup, promptText } = require("./scripts/channel-credentials");
  const { pool } = require("./src/channels/channelCredentialService");
  await ensureMasterKey(promptText);
  const configureAllAnswer = String(await promptText("Configure all four roles in this session?", "yes"))
    .trim()
    .toLowerCase();
  const configureAll = ["y", "yes"].includes(configureAllAnswer);
  const rolesToConfigure = configureAll ? ROLES : [await selectRole(promptText)];
  try {
    for (const [index, role] of rolesToConfigure.entries()) {
      process.stdout.write(`\n[bot-setup] Configuring ${ROLE_LABELS[role]} (${index + 1}/${rolesToConfigure.length})\n`);
      await interactiveSetup({
        ask: async (label, defaultValue) => {
          if (label === "Channel") return "discord";
          if (label === "Role / bot instance") return role;
          return promptText(label, defaultValue);
        },
      });
    }
  } finally {
    await pool.end();
  }
  if (configureAll) {
    const startChoice = String(await promptText(
      "All roles are configured. Start: 1) all four bots, 2) one bot, 3) none",
      "1"
    )).trim().toLowerCase();
    if (["1", "all", "a"].includes(startChoice)) return launchRoles();
    if (["2", "one", "o"].includes(startChoice)) return launchRole(await selectRole(promptText));
    if (["3", "none", "n", "no"].includes(startChoice)) {
      process.stdout.write("[bot-setup] Configuration complete. No bot was started.\n");
      return 0;
    }
    throw new Error(`Unsupported start choice: ${startChoice}`);
  }
  return launchRole(rolesToConfigure[0]);
}

async function main() {
  const role = requestedRole();
  if (role) {
    process.env.BOT_INSTANCE_ID = role;
    process.env.BOT_ROLE_LABEL = ROLE_LABELS[role];
    require("./bot-runtime");
    return 0;
  }
  if (process.env.BOT_INSTANCE_ID) {
    require("./bot-runtime");
    return 0;
  }
  return interactiveStart();
}

if (require.main === module) {
  main().then((code) => {
    if (Number.isInteger(code)) process.exitCode = code;
  }).catch((error) => {
    console.error(`[bot-setup] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  ROLE_PREFIXES,
  ensureMasterKey,
  interactiveStart,
  launchRole,
  launchRoles,
  main,
  prefixStream,
  requestedRole,
  selectRole,
};
