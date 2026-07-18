#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");
const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(repoRoot, ".env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const { migrateUp } = require("../src/db/migrationRunner");
const { rekeyTokens, revokeToken, storeToken, pool } = require("../src/channels/channelCredentialService");

async function main() {
  const [command, requestedChannelType, requestedBotInstanceId] = process.argv.slice(2);
  const channelType = requestedChannelType && !requestedChannelType.startsWith("--") ? requestedChannelType : "discord";
  const botInstanceId = requestedBotInstanceId || process.env.BOT_INSTANCE_ID || "default";
  if (!["migrate", "store-env", "revoke", "rekey"].includes(command)) {
    throw new Error("Usage: node scripts/channel-credentials.js migrate|store-env|revoke|rekey [channelType] [botInstanceId]");
  }
  if (command === "migrate") {
    console.log(JSON.stringify(await migrateUp("016_channel_credentials"), null, 2));
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

main().catch((error) => {
  console.error(`[channel-credentials] ${error.message}`);
  process.exitCode = 1;
}).finally(() => pool.end().catch(() => {}));
