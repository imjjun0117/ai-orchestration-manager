#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(__dirname, ".env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const db = require("./src/db");
const { loadRoleConfig } = require("./src/controlPlane/roleConfig");
const { bootRuntime } = require("./src/controlPlane/runtime");
const watchdog = require("./src/controlPlane/watchdogService");
const { createManagerIngress } = require("./src/discord/managerCommandIngress");

async function main() {
  const config = loadRoleConfig();
  if (config.role !== "manager") throw new Error("managerBot.js requires BOT_ROLE=manager");
  const runtime = await bootRuntime(config, { database: db });
  const { rows } = await db.query("SELECT discord_user_id FROM bot_instances WHERE discord_user_id IS NOT NULL");
  const ingress = createManagerIngress({
    config, db, registeredBotUserIds: new Set(rows.map((row) => String(row.discord_user_id))),
  });
  runtime.client.on("messageCreate", (message) => ingress(message).catch((error) => {
    console.error(`[${config.instanceId}] ingress: ${error.message}`);
  }));
  const watchdogTimer = setInterval(() => watchdog.recover({ managerInstanceId: config.instanceId }, { db })
    .catch((error) => console.error(`[${config.instanceId}] watchdog: ${error.message}`)), config.heartbeatMs);
  watchdogTimer.unref?.();
  const shutdown = async () => {
    clearInterval(watchdogTimer);
    await runtime.stop();
  };
  process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  console.error(`[${config.instanceId}] manager role ONLINE mode=${config.mode}`);
}

if (require.main === module) main().catch(async (error) => {
  console.error(`[manager-role] ${error.message}`);
  await db.pool.end().catch(() => {});
  process.exitCode = 1;
});

module.exports = { main };
