#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");
const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(repoRoot, ".env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const db = require("../src/db");
const { migrateDown, migrateUp } = require("../src/db/migrationRunner");
const { memoryMode } = require("../src/memory/memoryPolicy");
const {
  deleteMemorySource,
  ingestMemorySource,
  memoryInventory,
  purgeExpiredMemory,
  rebuildMemoryIndex,
} = require("../src/memory/sourceService");
const { replayContextManifest, shadowQuality } = require("../src/memory/contextPackageService");

const MIGRATION_ID = "023_phase18_tiered_memory";

function usage() {
  console.log([
    "Usage:",
    "  npm run phase18 -- migrate",
    "  npm run phase18 -- status",
    "  npm run phase18 -- readiness",
    "  npm run phase18 -- ingest <request.json>",
    "  npm run phase18 -- delete-source <request.json>",
    "  npm run phase18 -- delete-index <request.json>",
    "  npm run phase18 -- rebuild-index <request.json>",
    "  npm run phase18 -- purge-retention <request.json>",
    "  npm run phase18 -- replay <manifest-id>",
    "  npm run phase18 -- shadow-quality",
    "  npm run phase18 -- rollback --allow-destructive --confirm-phase18",
    "",
    "원문 메모리는 argv가 아닌 request JSON의 content 필드로만 전달합니다.",
  ].join("\n"));
}

function readRequest(argument, command) {
  if (!argument) throw new Error(`${command} requires a request JSON path`);
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argument), "utf8"));
}

async function status() {
  const { rows: migrationRows } = await db.query("SELECT id, checksum, applied_at FROM schema_migrations WHERE id = $1", [MIGRATION_ID]);
  const { rows: phaseRows } = await db.query(
    "SELECT id, status, accepted_at, row_version FROM delivery_phases WHERE id IN ('phase-17','phase-18') ORDER BY id"
  );
  const migration = migrationRows[0] || null;
  return {
    mode: memoryMode(),
    migration: migration ? { id: migration.id, appliedAt: migration.applied_at } : null,
    phases: phaseRows,
    inventory: migration ? await memoryInventory({ db }) : null,
    shadowQuality: migration ? await shadowQuality({ db }) : null,
  };
}

async function readiness() {
  const current = await status();
  const blockers = [];
  const phase17 = current.phases.find((phase) => phase.id === "phase-17");
  const phase18 = current.phases.find((phase) => phase.id === "phase-18");
  if (!phase17 || !["ACCEPTED", "ACCEPTED_WITH_DEBT"].includes(phase17.status)) blockers.push("Phase 17 Gate is not accepted");
  if (!phase18) blockers.push("Phase 18 delivery phase does not exist");
  if (!current.migration) blockers.push("Phase 18 migration is not applied");
  if (current.inventory && Number(current.inventory.expired_sources) > 0) blockers.push("expired memory sources require retention purge");
  if (current.mode === "enforced" && (!phase18 || !["ACCEPTED", "ACCEPTED_WITH_DEBT"].includes(phase18.status))) {
    blockers.push("enforced memory mode requires an accepted Phase 18 Gate");
  }
  return {
    readyForShadow: blockers.length === 0,
    readyForEnforced: blockers.length === 0
      && Boolean(phase18 && ["ACCEPTED", "ACCEPTED_WITH_DEBT"].includes(phase18.status))
      && Boolean(current.shadowQuality && current.shadowQuality.ready),
    blockers,
    ...current,
  };
}

async function main() {
  const [command, argument, ...rest] = process.argv.slice(2);
  const flags = new Set([argument, ...rest].filter(Boolean));
  if (!command || command === "--help" || command === "-h") return usage();
  let result;
  if (command === "migrate") result = await migrateUp(MIGRATION_ID);
  else if (command === "status") result = await status();
  else if (command === "readiness") result = await readiness();
  else if (command === "ingest") result = await ingestMemorySource(readRequest(argument, command), { db });
  else if (command === "delete-source") result = await deleteMemorySource({ ...readRequest(argument, command), indexOnly: false }, { db });
  else if (command === "delete-index") result = await deleteMemorySource({ ...readRequest(argument, command), indexOnly: true }, { db });
  else if (command === "rebuild-index") result = await rebuildMemoryIndex(readRequest(argument, command), { db });
  else if (command === "purge-retention") result = await purgeExpiredMemory(readRequest(argument, command), { db });
  else if (command === "replay") {
    if (!argument || argument.startsWith("--")) throw new Error("replay requires a manifest ID");
    result = await replayContextManifest(argument, { db });
  } else if (command === "shadow-quality") result = await shadowQuality({ db });
  else if (command === "rollback") {
    if (!flags.has("--allow-destructive") || !flags.has("--confirm-phase18")) {
      throw new Error("rollback requires --allow-destructive and --confirm-phase18");
    }
    if (memoryMode() !== "off") throw new Error("TIERED_MEMORY_MODE must be off before rollback");
    result = await migrateDown(MIGRATION_ID, { allowDestructive: true });
  } else {
    throw new Error(`unknown Phase 18 command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(`[phase18] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
