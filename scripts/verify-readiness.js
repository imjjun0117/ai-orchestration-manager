#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");
const schemaPath = path.join(repoRoot, "src/db/schema.sql");
const phase15MigrationPath = path.join(repoRoot, "src/db/migrations/015_delivery_governance.up.sql");
const phase15SecurityMigrationPath = path.join(repoRoot, "src/db/migrations/015_delivery_governance_security.up.sql");
const phase15ReworkMigrationPath = path.join(repoRoot, "src/db/migrations/015_delivery_governance_rework.up.sql");
const phase15OperationsMigrationPath = path.join(repoRoot, "src/db/migrations/015_delivery_governance_operations.up.sql");
const packagePath = path.join(repoRoot, "package.json");

const REQUIRED_ENV_KEYS = [
  "CHANNEL_TOKEN_MASTER_KEY",
  "BOT_INSTANCE_ID",
  "HOST_INSTANCE_ID",
  "COMMAND_PREFIX",
  "DATABASE_URL",
  "WORKSPACE_DIR",
  "AI_WAR_ROOM_CHANNEL_ID",
];

const REQUIRED_SCHEMA_SNIPPETS = [
  "CREATE TABLE IF NOT EXISTS tasks",
  "pause_requested BOOLEAN DEFAULT FALSE",
  "current_pid INTEGER",
  "current_pgid INTEGER",
  "current_host_id TEXT",
  "current_owner_instance_id TEXT",
  "CREATE TABLE IF NOT EXISTS workspace_locks",
  "owner_host_id TEXT NOT NULL DEFAULT 'unknown'",
  "CREATE TABLE IF NOT EXISTS role_bindings",
  "idx_approvals_unique_pending",
  "('pm', 'claude')",
  "('coder', 'codex')",
  "('reviewer', 'gemini')",
  "('qa', 'codex')",
  "('summarizer', 'gemma')",
];

const REQUIRED_PHASE15_MIGRATION_SNIPPETS = [
  "CREATE TABLE IF NOT EXISTS delivery_actors",
  "CREATE TABLE IF NOT EXISTS phase_assignments",
  "CREATE TABLE IF NOT EXISTS delivery_phases",
  "CREATE TABLE IF NOT EXISTS phase_submissions",
  "CREATE TABLE IF NOT EXISTS phase_validations",
  "CREATE TABLE IF NOT EXISTS phase_validation_findings",
  "CREATE TABLE IF NOT EXISTS phase_gate_events",
  "CREATE OR REPLACE FUNCTION seal_phase_submission",
  "CREATE OR REPLACE FUNCTION complete_phase_validation",
  "CREATE OR REPLACE FUNCTION gate_delivery_phase",
  "trg_phase_submission_immutable",
  "trg_phase_validation_immutable",
  "trg_phase_gate_events_append_only",
];

const REQUIRED_DB_COLUMNS = {
  tasks: [
    "id",
    "status",
    "pause_requested",
    "discord_thread_id",
    "current_pid",
    "current_pgid",
    "current_host_id",
    "current_owner_instance_id",
  ],
  command_logs: ["timed_out", "killed"],
  workspace_locks: [
    "workspace_key",
    "owner_host_id",
    "owner_instance_id",
    "owner_pid",
    "task_id",
    "command_label",
    "expires_at",
  ],
  role_bindings: ["role", "agent_name"],
  delivery_actors: ["id", "actor_type", "credential_binding", "status"],
  delivery_phases: ["id", "status", "latest_submission_id", "row_version"],
  phase_assignments: ["phase_id", "actor_id", "assignment_role", "revoked_at"],
  phase_submissions: ["id", "phase_id", "submission_round", "artifact_bundle_hash", "manifest_json", "status"],
  phase_validations: ["id", "phase_submission_id", "validator_type", "validation_attempt", "attempt_status", "verdict"],
  phase_validation_findings: ["id", "phase_validation_id", "severity", "category", "status"],
  phase_gate_events: ["id", "phase_id", "phase_submission_id", "event_type", "event_payload"],
  phase_dependency_activations: ["phase_id", "depends_on_phase_id", "activated_by_submission_id", "activated_by_actor_id"],
  phase_debts: ["id", "finding_id", "risk_owner_actor_id", "risk_accepted_by_actor_id", "risk_accepted_at"],
  phase_debt_approvals: ["debt_id", "validator_type", "successor_safe", "safety_rationale"],
};

function parseArgs(argv) {
  const args = {
    withDb: false,
    withStress: false,
    stressWorkers: 6,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--with-db") {
      args.withDb = true;
    } else if (value === "--with-stress") {
      args.withStress = true;
      args.withDb = true;
    } else if (value === "--stress-workers") {
      args.stressWorkers = Number.parseInt(argv[++i], 10);
    } else if (value === "--help" || value === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!Number.isInteger(args.stressWorkers) || args.stressWorkers < 2) {
    throw new Error("--stress-workers must be an integer >= 2");
  }

  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: npm run verify -- [--with-db] [--with-stress] [--stress-workers 6]",
      "",
      "Default mode runs syntax, package, env example, and schema static checks.",
      "--with-db also checks the live Postgres schema and role seed rows.",
      "--with-stress also runs scripts/stress-workspace-locks.js.",
    ].join("\n")
  );
}

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function skip(message) {
  console.log(`[SKIP] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function walkJsFiles(rootDir) {
  const result = [];
  if (!fs.existsSync(rootDir)) return result;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkJsFiles(absPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(absPath);
    }
  }
  return result;
}

function appJsFiles() {
  const files = [
    path.join(repoRoot, "bot.js"),
    path.join(repoRoot, "bot-runtime.js"),
    ...walkJsFiles(path.join(repoRoot, "agents")),
    ...walkJsFiles(path.join(repoRoot, "services")),
    ...walkJsFiles(path.join(repoRoot, "src")),
    ...walkJsFiles(path.join(repoRoot, "scripts")),
  ];
  return [...new Set(files)].sort();
}

function runSyntaxChecks() {
  const files = appJsFiles();
  assert(files.length > 0, "No JS files found for syntax checks");

  for (const file of files) {
    const result = spawnSync(process.execPath, ["-c", file], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const relative = path.relative(repoRoot, file);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      fail(`Syntax check failed for ${relative}\n${output}`);
    }
  }

  pass(`syntax checks (${files.length} files)`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function checkPackageScripts() {
  const pkg = readJson(packagePath);
  const scripts = pkg.scripts || {};
  const requiredScripts = [
    "start",
    "multibot",
    "stress:locks",
    "verify",
    "verify:db",
    "verify:stress",
    "phase15",
    "migrate:phase15",
    "test:phase15",
    "test:phase15:db",
  ];
  for (const script of requiredScripts) {
    assert(scripts[script], `package.json is missing script: ${script}`);
  }
  pass("package scripts");
}

function looksLikePlaceholder(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized.includes("replace-with") || normalized.includes("placeholder") || normalized.includes("example");
}

function checkEnvExample(fileName) {
  const filePath = path.join(repoRoot, fileName);
  assert(fs.existsSync(filePath), `${fileName} is missing`);
  const parsed = dotenv.parse(fs.readFileSync(filePath));

  for (const key of REQUIRED_ENV_KEYS) {
    assert(parsed[key], `${fileName} is missing ${key}`);
  }
  assert(looksLikePlaceholder(parsed.CHANNEL_TOKEN_MASTER_KEY), `${fileName} CHANNEL_TOKEN_MASTER_KEY must be a placeholder`);
  assert(parsed.BOT_INSTANCE_ID !== "default", `${fileName} BOT_INSTANCE_ID should be instance-specific`);
  assert(parsed.HOST_INSTANCE_ID, `${fileName} HOST_INSTANCE_ID is required`);
  assert(parsed.COMMAND_PREFIX && parsed.COMMAND_PREFIX !== "!", `${fileName} COMMAND_PREFIX should be distinct for multi-bot tests`);
}

function checkEnvExamples() {
  checkEnvExample(".env.bot-a.example");
  checkEnvExample(".env.bot-b.example");
  pass("multi-bot env examples");
}

function checkSchemaStatic() {
  assert(fs.existsSync(schemaPath), "src/db/schema.sql is missing");
  const schema = fs.readFileSync(schemaPath, "utf8");
  for (const snippet of REQUIRED_SCHEMA_SNIPPETS) {
    assert(schema.includes(snippet), `schema.sql is missing required snippet: ${snippet}`);
  }
  assert(fs.existsSync(phase15MigrationPath), "Phase 15 delivery governance migration is missing");
  const phase15Migration = fs.readFileSync(phase15MigrationPath, "utf8");
  for (const snippet of REQUIRED_PHASE15_MIGRATION_SNIPPETS) {
    assert(phase15Migration.includes(snippet), `Phase 15 migration is missing required snippet: ${snippet}`);
  }
  assert(fs.existsSync(phase15SecurityMigrationPath), "Phase 15 security hardening migration is missing");
  const phase15SecurityMigration = fs.readFileSync(phase15SecurityMigrationPath, "utf8");
  assert(phase15SecurityMigration.includes("REVOKE ALL ON FUNCTION"), "Phase 15 security migration must revoke PUBLIC function execution");
  assert(phase15SecurityMigration.includes("REVOKE ALL ON TABLE"), "Phase 15 security migration must revoke PUBLIC table access");
  assert(fs.existsSync(phase15ReworkMigrationPath), "Phase 15 validation rework migration is missing");
  const phase15ReworkMigration = fs.readFileSync(phase15ReworkMigrationPath, "utf8");
  for (const snippet of [
    "uq_phase_assignment_active_actor",
    "phase15_assert_not_submission_worker",
    "phase15_refresh_validation_projection",
    "phase_dependency_activations",
    "cancel_delivery_phase",
    "accept_phase_debt_risk",
  ]) {
    assert(phase15ReworkMigration.includes(snippet), `Phase 15 rework migration is missing required snippet: ${snippet}`);
  }
  assert(fs.existsSync(phase15OperationsMigrationPath), "Phase 15 operator migration is missing");
  const phase15OperationsMigration = fs.readFileSync(phase15OperationsMigrationPath, "utf8");
  assert(phase15OperationsMigration.includes("replace_phase_assignment"), "Phase 15 operator migration must provide atomic assignment replacement");
  pass("schema and Phase 15 migration static checks");
}

function checkDocs() {
  const requiredDocs = [
    "docs/phase10-multibot.md",
    "docs/phase13-stress.md",
    "docs/phase14-readiness.md",
    "docs/phase15/delivery-governance.md",
  ];
  for (const doc of requiredDocs) {
    assert(fs.existsSync(path.join(repoRoot, doc)), `${doc} is missing`);
  }
  pass("operator docs");
}

function loadDefaultEnv() {
  const envFile = process.env.ENV_FILE
    ? path.resolve(process.env.ENV_FILE)
    : path.join(repoRoot, ".env");
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: false, quiet: true });
  }
}

async function checkLiveDatabase() {
  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is required for --with-db");
  }

  const db = require("../src/db");
  try {
    await db.query("SELECT 1");

    for (const [table, columns] of Object.entries(REQUIRED_DB_COLUMNS)) {
      const { rows } = await db.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const actual = new Set(rows.map((row) => row.column_name));
      for (const column of columns) {
        assert(actual.has(column), `live DB table ${table} is missing column ${column}`);
      }
    }

    const requiredPhase15Functions = [
      "start_delivery_phase",
      "seal_phase_submission",
      "start_phase_validation",
      "complete_phase_validation",
      "fail_phase_validation_attempt",
      "start_phase_rework",
      "resolve_phase_finding",
      "register_phase_debt",
      "approve_phase_debt",
      "accept_phase_debt_risk",
      "cancel_delivery_phase",
      "replace_phase_assignment",
      "gate_delivery_phase",
    ];
    const { rows: functionRows } = await db.query(
      `SELECT DISTINCT proname
       FROM pg_proc
       JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
       WHERE pg_namespace.nspname = 'public'
         AND proname = ANY($1)`,
      [requiredPhase15Functions]
    );
    const actualFunctions = new Set(functionRows.map((row) => row.proname));
    for (const functionName of requiredPhase15Functions) {
      assert(actualFunctions.has(functionName), `live DB is missing Phase 15 function ${functionName}`);
    }
    const { rows: publicRoutineGrants } = await db.query(
      `SELECT routine_name
       FROM information_schema.routine_privileges
       WHERE routine_schema = 'public'
         AND grantee = 'PUBLIC'
         AND privilege_type = 'EXECUTE'
         AND routine_name = ANY($1)`,
      [requiredPhase15Functions]
    );
    assert(publicRoutineGrants.length === 0, `Phase 15 functions still executable by PUBLIC: ${publicRoutineGrants.map((row) => row.routine_name).join(", ")}`);

    const { rows: roleRows } = await db.query(
      `SELECT role, agent_name FROM role_bindings WHERE role = ANY($1)`,
      [["pm", "coder", "reviewer", "qa", "summarizer"]]
    );
    const roles = new Map(roleRows.map((row) => [row.role, row.agent_name]));
    for (const [role, expected] of Object.entries({
      pm: "claude",
      coder: "codex",
      reviewer: "gemini",
      qa: "codex",
      summarizer: "gemma",
    })) {
      assert(roles.get(role) === expected, `live DB role binding mismatch for ${role}: expected ${expected}, got ${roles.get(role) || "missing"}`);
    }

    pass("live database schema");
  } finally {
    await db.pool.end().catch(() => {});
  }
}

function runStress(workers) {
  const scriptPath = path.join(repoRoot, "scripts/stress-workspace-locks.js");
  const result = spawnSync(process.execPath, [scriptPath, "--workers", String(workers)], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DOTENV_CONFIG_QUIET: "true",
    },
  });
  assert(result.status === 0, `stress-workspace-locks failed with exit code ${result.status}`);
  pass(`workspace lock stress (${workers} workers)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDefaultEnv();

  runSyntaxChecks();
  checkPackageScripts();
  checkEnvExamples();
  checkSchemaStatic();
  checkDocs();

  if (args.withDb) {
    await checkLiveDatabase();
  } else {
    skip("live database checks (--with-db not set)");
  }

  if (args.withStress) {
    runStress(args.stressWorkers);
  } else {
    skip("workspace stress checks (--with-stress not set)");
  }

  console.log("[PASS] readiness verification complete");
}

main().catch((err) => {
  console.error(`[FAIL] ${err.stack || err.message || err}`);
  process.exitCode = 1;
});
