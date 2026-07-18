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

function requestedRole(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--role");
  return index >= 0 ? argv[index + 1] : null;
}

async function selectRole(ask) {
  const lines = ROLES.map((role, index) => `${index + 1}) ${role}`).join("\n");
  const answer = String(await ask(`Select bot role:\n${lines}\nChoice`, "1")).trim().toLowerCase();
  const numeric = Number.parseInt(answer, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= ROLES.length) return ROLES[numeric - 1];
  if (ROLES.includes(answer)) return answer;
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
      process.stdout.write(`\n[bot-setup] Configuring ${role} (${index + 1}/${rolesToConfigure.length})\n`);
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
    const startAnswer = String(await promptText("All roles are configured. Start one bot now?", "no"))
      .trim()
      .toLowerCase();
    if (!["y", "yes"].includes(startAnswer)) {
      process.stdout.write("[bot-setup] Configuration complete. No bot was started.\n");
      return 0;
    }
    return launchRole(await selectRole(promptText));
  }
  return launchRole(rolesToConfigure[0]);
}

async function main() {
  const role = requestedRole();
  if (role) {
    process.env.BOT_INSTANCE_ID = role;
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

module.exports = { ROLES, ensureMasterKey, interactiveStart, launchRole, main, requestedRole, selectRole };
