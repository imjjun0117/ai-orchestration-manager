#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");
const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(repoRoot, ".env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const { migrateUp } = require("../src/db/migrationRunner");
const { storeToken, pool } = require("../src/channels/channelCredentialService");

async function main() {
  const [command, channelType = "discord", botInstanceId = process.env.BOT_INSTANCE_ID || "default"] = process.argv.slice(2);
  if (command !== "migrate" && command !== "store-env") {
    throw new Error("Usage: node scripts/channel-credentials.js migrate|store-env [channelType] [botInstanceId]");
  }
  if (command === "migrate") {
    console.log(JSON.stringify(await migrateUp("016_channel_credentials"), null, 2));
    return;
  }
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN must be supplied through the environment; never pass tokens on argv");
  const result = await storeToken({ channelType, botInstanceId, token, metadata: { source: "environment-import" } });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`[channel-credentials] ${error.message}`);
  process.exitCode = 1;
}).finally(() => pool.end().catch(() => {}));
