#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const dotenv = require("dotenv");
const { promptSecret } = require("../src/channels/hiddenSecretPrompt");

const repoRoot = path.resolve(__dirname, "..");
const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(repoRoot, ".env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const { migrateUp } = require("../src/db/migrationRunner");
const {
  encryptToken,
  getCredentialStatus,
  rekeyTokens,
  revokeToken,
  storeToken,
  pool,
} = require("../src/channels/channelCredentialService");

function normalizeIdentifier(value, fallback) {
  return String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function promptText(label, defaultValue) {
  const prompt = `${label} [${defaultValue}]: `;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let settled = false;
    rl.question(prompt, (answer) => {
      settled = true;
      rl.close();
      resolve(String(answer || "").trim() || defaultValue);
    });
    rl.on("SIGINT", () => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(new Error("Interactive setup cancelled"));
    });
    rl.on("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Interactive setup input ended unexpectedly"));
    });
  });
}

async function interactiveSetup({
  ask = promptText,
  askSecret = promptSecret,
  migrate = migrateUp,
  statusLookup = getCredentialStatus,
  save = storeToken,
  isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
} = {}) {
  if (!String(process.env.CHANNEL_TOKEN_MASTER_KEY || "").trim()) {
    throw new Error("CHANNEL_TOKEN_MASTER_KEY must be configured before interactive setup");
  }
  encryptToken("master-key-preflight");
  if (!isInteractive()) {
    throw new Error("Interactive setup requires a TTY so the token can be entered without echo");
  }
  await migrate("016_channel_credentials");
  const channelType = normalizeIdentifier(await ask("Channel", "discord"), "discord");
  const botInstanceId = normalizeIdentifier(
    await ask("Role / bot instance", process.env.BOT_INSTANCE_ID || "default"),
    "default"
  );
  const existing = await statusLookup({ channelType, botInstanceId });
  if (existing?.status === "ACTIVE") {
    const replace = String(await ask("An ACTIVE token already exists. Replace it?", "no")).trim().toLowerCase();
    if (!["y", "yes"].includes(replace)) {
      return { configured: false, reason: "existing-active", channelType, botInstanceId };
    }
  }
  const token = await askSecret("Bot token (hidden): ");
  if (!token) throw new Error("Bot token cannot be empty");
  const stored = await save({
    channelType,
    botInstanceId,
    token,
    metadata: { source: "interactive-setup", role: botInstanceId },
  });
  return {
    configured: true,
    channelType,
    botInstanceId,
    status: "ACTIVE",
    keyVersion: stored.key_version,
  };
}

async function main() {
  const [command, requestedChannelType, requestedBotInstanceId] = process.argv.slice(2);
  const channelType = requestedChannelType && !requestedChannelType.startsWith("--") ? requestedChannelType : "discord";
  const botInstanceId = requestedBotInstanceId || process.env.BOT_INSTANCE_ID || "default";
  if (!["migrate", "setup", "store-env", "revoke", "rekey"].includes(command)) {
    throw new Error("Usage: node scripts/channel-credentials.js migrate|setup|store-env|revoke|rekey [channelType] [botInstanceId]");
  }
  if (command === "migrate") {
    console.log(JSON.stringify(await migrateUp("016_channel_credentials"), null, 2));
    return;
  }
  if (command === "setup") {
    console.log(JSON.stringify(await interactiveSetup(), null, 2));
    return;
  }
  if (command === "revoke") {
    console.log(JSON.stringify(await revokeToken({ channelType, botInstanceId }), null, 2));
    return;
  }
  if (command === "rekey") {
    const all = requestedChannelType === "--all" || !requestedChannelType;
    console.log(JSON.stringify(await rekeyTokens(all ? {} : { channelType, botInstanceId }), null, 2));
    return;
  }
  const normalizedChannel = String(channelType).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const tokenEnvName = `${normalizedChannel}_TOKEN`;
  const token = process.env.CHANNEL_TOKEN || process.env[tokenEnvName];
  if (!token) throw new Error(`CHANNEL_TOKEN or ${tokenEnvName} must be supplied through the environment; never pass tokens on argv`);
  const result = await storeToken({ channelType, botInstanceId, token, metadata: { source: "environment-import" } });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[channel-credentials] ${error.message}`);
    process.exitCode = 1;
  }).finally(() => pool.end().catch(() => {}));
}

module.exports = { interactiveSetup, main, normalizeIdentifier, promptSecret, promptText };
