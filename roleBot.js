#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(__dirname, ".env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const db = require("./src/db");
const { loadRoleConfig } = require("./src/controlPlane/roleConfig");
const { executeRoleJob } = require("./src/controlPlane/roleExecutor");
const { RoleWorker } = require("./src/controlPlane/roleWorker");
const { bootRuntime } = require("./src/controlPlane/runtime");

async function main() {
  const config = loadRoleConfig();
  if (config.role === "manager") throw new Error("roleBot.js cannot run BOT_ROLE=manager");
  const runtime = await bootRuntime(config, { database: db });
  const worker = new RoleWorker({ config, db, executeJob: executeRoleJob });
  worker.start();
  const shutdown = async () => {
    worker.stop();
    await runtime.stop();
  };
  process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  console.error(`[${config.instanceId}] ${config.role} role ONLINE mode=${config.mode} execution=${config.executionMode}`);
}

if (require.main === module) main().catch(async (error) => {
  console.error(`[role-bot] ${error.message}`);
  await db.pool.end().catch(() => {});
  process.exitCode = 1;
});

module.exports = { main };
