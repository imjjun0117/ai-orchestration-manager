#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(__dirname, "../.env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const db = require("../src/db");
const { migrateDown, migrateUp } = require("../src/db/migrationRunner");
const {
  backfillTokenFingerprints,
  encryptToken,
  tokenFingerprint,
} = require("../src/channels/channelCredentialService");
const { loadRoleConfig, ROLES, validateSixRoleSet } = require("../src/controlPlane/roleConfig");
const watchdog = require("../src/controlPlane/watchdogService");
const reconciliation = require("../src/controlPlane/reconciliationService");

const PHASE17_MIGRATIONS = Object.freeze([
  "018_durable_control_plane",
  "019_phase17_credential_enrollment",
  "020_phase17_operator_reconciliation",
]);

const ROLE_PROFILES = Object.freeze(ROLES.map((role) => Object.freeze({
  role,
  principal: `${role}_db`,
  instanceId: `${role}-01`,
})));
const LEGACY_CREDENTIAL_MAPPINGS = Object.freeze([
  Object.freeze({ source: "gate-admin", target: "manager-01", role: "manager" }),
  Object.freeze({ source: "planning-validator", target: "planner-01", role: "planner" }),
  Object.freeze({ source: "worker", target: "coder-01", role: "coder" }),
  Object.freeze({ source: "development-validator", target: "reviewer-01", role: "reviewer" }),
]);
const CANDIDATE_CREDENTIAL_MAPPINGS = Object.freeze([
  Object.freeze({ file: ".env.bot-a", target: "qa-01", role: "qa" }),
  Object.freeze({ file: ".env.bot-b", target: "summarizer-01", role: "summarizer" }),
]);

function identifier(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(String(value || ""))) throw new Error("DB principal must be a simple PostgreSQL identifier");
  return `"${value}"`;
}

function commonFunctions() {
  return [
    "register_bot_instance(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,JSONB,JSONB)",
    "heartbeat_bot_instance(TEXT,TEXT,JSONB,JSONB)", "mark_bot_instance_offline(TEXT)",
    "get_phase17_channel_credential(TEXT,TEXT)", "claim_outbox_event(TEXT,INTEGER)",
    "store_phase17_channel_credential(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,JSONB)",
    "revoke_phase17_channel_credential(TEXT,TEXT,TEXT)",
    "complete_outbox_event(TEXT,TEXT,TEXT)", "suppress_outbox_event(TEXT,TEXT,TEXT)",
    "fail_outbox_event(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER)",
  ];
}

function roleFunctions(role) {
  if (role === "manager") return [
    "receive_discord_command(TEXT,TEXT,TEXT,TEXT,TEXT,VARCHAR,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)",
    "advance_workflow_node(TEXT,TEXT,TEXT)", "resolve_workflow_approval(TEXT,TEXT,TEXT,BOOLEAN,TEXT)",
    "enqueue_manager_notice(TEXT,TEXT,TEXT,TEXT,TEXT)", "recover_phase17_control_plane(TEXT)",
    "claim_candidate_finalization(TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)",
    "complete_candidate_finalization(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)",
  ];
  const functions = [
    "claim_role_job(TEXT,INTEGER)", "heartbeat_role_job(TEXT,TEXT,TEXT,INTEGER)",
    "complete_role_job(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB)",
    "fail_role_job(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER)",
  ];
  if (role === "coder" || role === "qa") {
    functions.push(
      "acquire_workspace_lease(TEXT,TEXT,TEXT,VARCHAR,TEXT,TEXT,TEXT,INTEGER,JSONB)",
      "heartbeat_workspace_lease(TEXT,TEXT,TEXT,BIGINT,INTEGER)",
      "release_workspace_lease(TEXT,TEXT,TEXT,BIGINT)"
    );
  }
  return functions;
}

async function provisionOnClient(client, principal, role, { verifyExists = true } = {}) {
  if (!ROLES.includes(role)) throw new Error(`role must be one of: ${ROLES.join(", ")}`);
  const quoted = identifier(principal);
  if (verifyExists) {
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [principal]);
    if (!exists.rows[0]) throw new Error(`PostgreSQL role does not exist: ${principal}`);
  }
  await client.query(
    `INSERT INTO bot_role_principals(db_principal, bot_role, provisioned_by)
     VALUES ($1,$2,SESSION_USER)
     ON CONFLICT (db_principal) DO UPDATE SET bot_role = EXCLUDED.bot_role, enabled = TRUE, updated_at = CURRENT_TIMESTAMP`,
    [principal, role]
  );
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
  for (const signature of [...commonFunctions(), ...roleFunctions(role)]) {
    await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${quoted}`);
  }
  await client.query(`GRANT SELECT (id, channel_id, status, row_version, original_request) ON tasks TO ${quoted}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE ON discord_publications TO ${quoted}`);
  if (role === "manager") {
    await client.query(`GRANT SELECT ON bot_instances, role_jobs, workflow_runs, workflow_nodes, tasks TO ${quoted}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON approvals, artifacts, isolated_workspaces, workspace_safety_events TO ${quoted}`);
    await client.query(`GRANT SELECT ON workspace_leases, workspace_lock_heads, delivery_phases TO ${quoted}`);
  } else {
    await client.query(`GRANT INSERT ON artifacts TO ${quoted}`);
    await client.query(`GRANT SELECT ON artifacts TO ${quoted}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON isolated_workspaces, workspace_safety_events TO ${quoted}`);
    await client.query(`GRANT SELECT ON workspace_leases, workspace_lock_heads, delivery_phases TO ${quoted}`);
    if (role === "coder") await client.query(`GRANT SELECT, INSERT ON approvals TO ${quoted}`);
    else await client.query(`GRANT SELECT ON approvals TO ${quoted}`);
  }
  return { principal, role, provisioned: true };
}

async function provision(principal, role) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await provisionOnClient(client, principal, role);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function envLine(name, value) {
  return `${name}=${JSON.stringify(String(value))}`;
}

function roleProfile({ role, instanceId, databaseUrl, masterKey, masterKeyVersion }) {
  return [
    envLine("BOT_ROLE", role),
    envLine("BOT_INSTANCE_ID", instanceId),
    envLine("DATABASE_URL", databaseUrl),
    envLine("MULTIBOT_ROLE_MODE", "shadow"),
    envLine("ROLE_WORKER_EXECUTION", "dry-run"),
    envLine("CHANNEL_TOKEN_MASTER_KEY", masterKey),
    envLine("CHANNEL_TOKEN_MASTER_KEY_VERSION", masterKeyVersion),
    "",
  ].join("\n");
}

async function bootstrapRoles(args, {
  database = db,
  env = process.env,
  fileSystem = fs,
  randomBytes = crypto.randomBytes,
  workingDirectory = process.cwd(),
} = {}) {
  if (!args.includes("--create-postgres-roles") || !args.includes("--write-env-profiles")) {
    throw new Error("bootstrap-roles requires --create-postgres-roles --write-env-profiles");
  }
  const controlDatabaseUrl = String(env.DATABASE_URL || "").trim();
  const masterKey = String(env.CHANNEL_TOKEN_MASTER_KEY || "").trim();
  const masterKeyVersion = String(env.CHANNEL_TOKEN_MASTER_KEY_VERSION || "1").trim();
  if (!controlDatabaseUrl) throw new Error("DATABASE_URL is required");
  if (!masterKey) throw new Error("CHANNEL_TOKEN_MASTER_KEY is required");
  const outputDirectory = path.resolve(workingDirectory, env.PHASE17_ENV_DIRECTORY || ".env.phase17");
  if (fileSystem.existsSync(outputDirectory)) {
    throw new Error(`refusing to overwrite existing Phase 17 env directory: ${path.basename(outputDirectory)}`);
  }

  const stagingDirectory = `${outputDirectory}.staging-${process.pid}-${Date.now()}`;
  const generated = ROLE_PROFILES.map((profile) => {
    const password = randomBytes(32).toString("base64url");
    const roleUrl = new URL(controlDatabaseUrl);
    roleUrl.username = profile.principal;
    roleUrl.password = password;
    return { ...profile, password, databaseUrl: roleUrl.toString() };
  });

  fileSystem.mkdirSync(stagingDirectory, { mode: 0o700 });
  let committed = false;
  try {
    for (const profile of generated) {
      const contents = roleProfile({ ...profile, masterKey, masterKeyVersion });
      fileSystem.writeFileSync(path.join(stagingDirectory, `.env.${profile.role}`), contents, { mode: 0o600, flag: "wx" });
    }

    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      for (const profile of generated) {
        const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [profile.principal]);
        if (exists.rows[0]) throw new Error(`refusing to rotate existing PostgreSQL role: ${profile.principal}`);
        const escaped = await client.query("SELECT quote_literal($1) AS password", [profile.password]);
        await client.query(`CREATE ROLE ${identifier(profile.principal)} LOGIN PASSWORD ${escaped.rows[0].password}`);
        await provisionOnClient(client, profile.principal, profile.role, { verifyExists: false });
      }
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    fileSystem.renameSync(stagingDirectory, outputDirectory);
  } catch (error) {
    if (!committed) fileSystem.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    created: generated.map(({ role, principal, instanceId }) => ({ role, principal, instanceId })),
    envDirectory: path.relative(workingDirectory, outputDirectory),
    mode: "shadow",
    execution: "dry-run",
  };
}

async function status() {
  const { rows } = await db.query(
    `SELECT bot_role, instance_id, agent_engine, status, current_job_id, last_heartbeat_at
     FROM bot_instances ORDER BY bot_role, instance_id`
  );
  return rows;
}

async function credentialInventory({ database = db } = {}) {
  const { rows } = await database.query(
    `SELECT bot_instance_id, status, (metadata_json ? 'tokenFingerprint') AS fingerprinted, key_version
     FROM channel_credentials WHERE channel_type = 'discord' ORDER BY bot_instance_id`
  );
  return rows;
}

async function verifyRoleProfiles(args, {
  database = db,
  fileSystem = fs,
  poolFactory = (databaseUrl) => new Pool({ connectionString: databaseUrl }),
  workingDirectory = process.cwd(),
} = {}) {
  const files = args.length
    ? args.map((file) => path.resolve(workingDirectory, file))
    : ROLE_PROFILES.map(({ role }) => path.resolve(workingDirectory, ".env.phase17", `.env.${role}`));
  if (files.length !== ROLE_PROFILES.length) throw new Error("verify-role-profiles requires exactly six env profiles");
  const configs = files.map((file) => {
    if (!fileSystem.existsSync(file)) throw new Error(`role env profile is missing: ${path.basename(file)}`);
    if ((fileSystem.statSync(file).mode & 0o077) !== 0) throw new Error(`role env profile permissions are too broad: ${path.basename(file)}`);
    const parsed = dotenv.parse(fileSystem.readFileSync(file));
    if (parsed.DISCORD_TOKEN || parsed.CHANNEL_TOKEN) throw new Error(`plaintext Discord token found: ${path.basename(file)}`);
    if (!String(parsed.CHANNEL_TOKEN_MASTER_KEY || "").trim()) throw new Error(`master key is missing: ${path.basename(file)}`);
    return { ...loadRoleConfig(parsed), file };
  });
  validateSixRoleSet(configs);

  const verified = [];
  for (const config of configs) {
    const expected = ROLE_PROFILES.find(({ role }) => role === config.role);
    if (!expected || config.instanceId !== expected.instanceId) {
      throw new Error(`unexpected instance identity for ${config.role}: ${config.instanceId}`);
    }
    const rolePool = poolFactory(config.databaseUrl);
    try {
      const identity = await rolePool.query("SELECT SESSION_USER AS principal");
      const principal = identity.rows[0] && identity.rows[0].principal;
      if (principal !== expected.principal) throw new Error(`unexpected DB principal for ${config.instanceId}`);
      const privileges = await rolePool.query(
        `SELECT
           has_function_privilege(SESSION_USER,
             'public.store_phase17_channel_credential(text,text,text,text,text,integer,text,jsonb)', 'EXECUTE') AS can_store,
           has_function_privilege(SESSION_USER,
             'public.revoke_phase17_channel_credential(text,text,text)', 'EXECUTE') AS can_revoke`
      );
      if (!privileges.rows[0] || !privileges.rows[0].can_store || !privileges.rows[0].can_revoke) {
        throw new Error(`credential enrollment privilege is missing for ${config.instanceId}`);
      }
      const binding = await database.query(
        "SELECT bot_role, enabled FROM bot_role_principals WHERE db_principal = $1",
        [principal]
      );
      if (!binding.rows[0] || !binding.rows[0].enabled || binding.rows[0].bot_role !== config.role) {
        throw new Error(`DB principal for ${config.instanceId} is not bound to ${config.role}`);
      }
      verified.push({ role: config.role, instanceId: config.instanceId, principal });
    } finally {
      await rolePool.end();
    }
  }
  return { verified };
}

async function fingerprintCredentials(args) {
  if (!args.includes("--confirm-fingerprint-backfill")) {
    throw new Error("fingerprint-credentials requires --confirm-fingerprint-backfill");
  }
  return backfillTokenFingerprints({ channelType: "discord" });
}

async function adoptLegacyCredentials(args, { database = db } = {}) {
  if (!args.includes("--confirm-legacy-role-mapping")) {
    throw new Error("adopt-legacy-credentials requires --confirm-legacy-role-mapping");
  }
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const sources = await client.query(
      `SELECT bot_instance_id, metadata_json->>'tokenFingerprint' AS token_fingerprint
       FROM channel_credentials
       WHERE channel_type = 'discord' AND status = 'ACTIVE' AND bot_instance_id = ANY($1)
       ORDER BY bot_instance_id`,
      [LEGACY_CREDENTIAL_MAPPINGS.map(({ source }) => source)]
    );
    const bySource = new Map(sources.rows.map((row) => [row.bot_instance_id, row.token_fingerprint]));
    for (const { source } of LEGACY_CREDENTIAL_MAPPINGS) {
      if (!bySource.get(source)) throw new Error(`ACTIVE fingerprinted legacy credential is missing: ${source}`);
    }
    if (new Set(bySource.values()).size !== LEGACY_CREDENTIAL_MAPPINGS.length) {
      throw new Error("legacy Discord credentials are not distinct");
    }
    const targets = await client.query(
      `SELECT bot_instance_id FROM channel_credentials
       WHERE channel_type = 'discord' AND bot_instance_id = ANY($1)`,
      [LEGACY_CREDENTIAL_MAPPINGS.map(({ target }) => target)]
    );
    if (targets.rows[0]) throw new Error(`refusing to overwrite Phase 17 credential: ${targets.rows[0].bot_instance_id}`);
    for (const mapping of LEGACY_CREDENTIAL_MAPPINGS) {
      await client.query(
        `INSERT INTO channel_credentials(
           channel_type, bot_instance_id, encrypted_token, nonce, auth_tag, key_version, status, metadata_json
         )
         SELECT channel_type, $2, encrypted_token, nonce, auth_tag, key_version, status,
                metadata_json || jsonb_build_object('sourceCredentialAlias', $1::text, 'role', $3::text)
         FROM channel_credentials
         WHERE channel_type = 'discord' AND bot_instance_id = $1 AND status = 'ACTIVE'`,
        [mapping.source, mapping.target, mapping.role]
      );
    }
    await client.query("COMMIT");
    return { adopted: LEGACY_CREDENTIAL_MAPPINGS.map(({ source, target, role }) => ({ source, target, role })) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function importCandidateCredentials(args, {
  database = db,
  encrypt = encryptToken,
  fileSystem = fs,
  fingerprint = tokenFingerprint,
  workingDirectory = process.cwd(),
} = {}) {
  if (!args.includes("--confirm-candidate-import")) {
    throw new Error("import-candidate-credentials requires --confirm-candidate-import");
  }
  const candidates = CANDIDATE_CREDENTIAL_MAPPINGS.map((mapping) => {
    const candidatePath = path.resolve(workingDirectory, mapping.file);
    if (!fileSystem.existsSync(candidatePath)) throw new Error(`candidate credential file is missing: ${mapping.file}`);
    const parsed = dotenv.parse(fileSystem.readFileSync(candidatePath));
    const token = String(parsed.DISCORD_TOKEN || parsed.CHANNEL_TOKEN || "").trim();
    if (!token) throw new Error(`candidate Discord token is missing: ${mapping.file}`);
    return { ...mapping, token, fingerprint: fingerprint(token) };
  });
  if (new Set(candidates.map(({ fingerprint: value }) => value)).size !== candidates.length) {
    throw new Error("candidate Discord credentials are not distinct");
  }
  const encryptedCandidates = candidates.map((candidate) => ({ ...candidate, encrypted: encrypt(candidate.token) }));
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(
      `SELECT bot_instance_id FROM channel_credentials
       WHERE channel_type = 'discord' AND status = 'ACTIVE'
         AND metadata_json->>'tokenFingerprint' = ANY($1)
       ORDER BY bot_instance_id`,
      [candidates.map(({ fingerprint: value }) => value)]
    );
    if (duplicate.rows[0]) throw new Error(`candidate credential duplicates an ACTIVE account: ${duplicate.rows[0].bot_instance_id}`);
    const existingTarget = await client.query(
      `SELECT bot_instance_id FROM channel_credentials
       WHERE channel_type = 'discord' AND bot_instance_id = ANY($1)
       ORDER BY bot_instance_id`,
      [candidates.map(({ target }) => target)]
    );
    if (existingTarget.rows[0]) throw new Error(`refusing to overwrite Phase 17 credential: ${existingTarget.rows[0].bot_instance_id}`);
    for (const candidate of encryptedCandidates) {
      await client.query(
        `INSERT INTO channel_credentials(
           channel_type, bot_instance_id, encrypted_token, nonce, auth_tag, key_version, metadata_json
         ) VALUES ('discord',$1,$2,$3,$4,$5,$6::jsonb)`,
        [
          candidate.target,
          candidate.encrypted.ciphertext.toString("base64"),
          candidate.encrypted.iv.toString("base64"),
          candidate.encrypted.authTag.toString("base64"),
          candidate.encrypted.keyVersion,
          JSON.stringify({
            source: "legacy-env-import",
            sourceFile: candidate.file,
            role: candidate.role,
            tokenFingerprint: candidate.fingerprint,
          }),
        ]
      );
    }
    await client.query("COMMIT");
    return { imported: candidates.map(({ file, target, role }) => ({ file, target, role })) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function revokeCandidateCredentials(args, { database = db } = {}) {
  if (!args.includes("--confirm-invalid-candidate-revocation")) {
    throw new Error("revoke-candidate-credentials requires --confirm-invalid-candidate-revocation");
  }
  const result = await database.query(
    `UPDATE channel_credentials
     SET status = 'REVOKED',
         metadata_json = metadata_json || jsonb_build_object('revocationReason', 'Discord rejected token during Phase 17 shadow smoke'),
         updated_at = CURRENT_TIMESTAMP
     WHERE channel_type = 'discord' AND status = 'ACTIVE'
       AND bot_instance_id = ANY($1)
       AND metadata_json->>'source' = 'legacy-env-import'
     RETURNING bot_instance_id`,
    [CANDIDATE_CREDENTIAL_MAPPINGS.map(({ target }) => target)]
  );
  return { revoked: result.rows.map(({ bot_instance_id: instanceId }) => instanceId).sort() };
}

async function readiness({ database = db } = {}) {
  const [phases, migrations, bindings, credentials, definitions, instances, queues] = await Promise.all([
    database.query("SELECT id, status FROM delivery_phases WHERE id IN ('phase-16','phase-17') ORDER BY id"),
    database.query("SELECT id FROM schema_migrations WHERE id = ANY($1) ORDER BY id", [PHASE17_MIGRATIONS]),
    database.query(
      `SELECT bot_role, COUNT(*) FILTER (WHERE enabled)::int AS enabled_principals
       FROM bot_role_principals GROUP BY bot_role ORDER BY bot_role`
    ),
    database.query(
      `SELECT COUNT(*) FILTER (WHERE status='ACTIVE')::int AS active_credentials,
              COUNT(DISTINCT metadata_json->>'tokenFingerprint')
                FILTER (WHERE status='ACTIVE' AND metadata_json ? 'tokenFingerprint')::int AS distinct_fingerprints,
              COUNT(*) FILTER (WHERE status='ACTIVE' AND NOT (metadata_json ? 'tokenFingerprint'))::int AS missing_fingerprints
       FROM channel_credentials WHERE channel_type='discord'`
    ),
    database.query("SELECT COUNT(*)::int AS count FROM workflow_definitions WHERE status IN ('SHADOW','ACTIVE')"),
    database.query(
      `SELECT bot_role, COUNT(*) FILTER (WHERE status IN ('ONLINE','BUSY','DEGRADED'))::int AS live_instances
       FROM bot_instances GROUP BY bot_role ORDER BY bot_role`
    ),
    database.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('QUEUED','RETRY_WAIT','RUNNING'))::int AS active_jobs,
         (SELECT COUNT(*)::int FROM role_jobs job
          WHERE job.status IN ('NEEDS_RECONCILIATION','DEAD_LETTER')
            AND NOT EXISTS (
              SELECT 1 FROM phase17_reconciliation_actions action
              WHERE action.item_type='ROLE_JOB' AND action.item_id=job.id
                AND action.after_status=job.status
                AND action.after_revision=job.reconciliation_revision
            )) AS unhealthy_jobs,
         (SELECT COUNT(*)::int FROM outbox_events WHERE status IN ('PENDING','DISPATCHING','RETRY_WAIT')) AS pending_outbox,
         (SELECT COUNT(*)::int FROM outbox_events event
          WHERE event.status IN ('NEEDS_RECONCILIATION','DEAD_LETTER')
            AND NOT EXISTS (
              SELECT 1 FROM phase17_reconciliation_actions action
              WHERE action.item_type='OUTBOX_EVENT' AND action.item_id=event.id
                AND action.after_status=event.status
                AND action.after_revision=event.reconciliation_revision
            )) AS unhealthy_outbox
       FROM role_jobs`
    ),
  ]);
  const phaseMap = new Map(phases.rows.map((row) => [row.id, row.status]));
  const bindingMap = new Map(bindings.rows.map((row) => [row.bot_role, row.enabled_principals]));
  const instanceMap = new Map(instances.rows.map((row) => [row.bot_role, row.live_instances]));
  const credential = credentials.rows[0];
  const queue = queues.rows[0];
  const blockers = [];
  if (!["ACCEPTED", "ACCEPTED_WITH_DEBT"].includes(phaseMap.get("phase-16"))) blockers.push("Phase 16 Gate is not accepted");
  if (migrations.rows.length !== PHASE17_MIGRATIONS.length) blockers.push("Phase 17 migrations are incomplete");
  for (const role of ROLES) {
    if (!bindingMap.get(role)) blockers.push(`no enabled DB principal for ${role}`);
    if (!instanceMap.get(role)) blockers.push(`no live bot instance for ${role}`);
  }
  if (credential.active_credentials < 6) blockers.push("fewer than six ACTIVE Discord credentials");
  if (credential.distinct_fingerprints < 6) blockers.push("fewer than six distinct Discord credential fingerprints");
  if (credential.missing_fingerprints > 0) blockers.push("ACTIVE Discord credentials require fingerprint backfill/rekey");
  if (definitions.rows[0].count < 6) blockers.push("Phase 17 workflow definitions are incomplete");
  if (queue.unhealthy_jobs > 0 || queue.unhealthy_outbox > 0) blockers.push("job/outbox reconciliation is required");
  return {
    readyForShadowSixBotSmoke: blockers.length === 0,
    blockers,
    phases: phases.rows,
    migrations: migrations.rows.map(({ id }) => id),
    rolePrincipals: bindings.rows,
    credentials: credential,
    workflowDefinitions: definitions.rows[0].count,
    liveInstances: instances.rows,
    queues: queue,
  };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1 || String(args[index + 1]).startsWith("--")) {
    throw new Error(`reconcile requires ${flag} <value>`);
  }
  return args[index + 1];
}

async function reconciliationInventory({ database = db } = {}) {
  return reconciliation.list({ db: database });
}

async function reconcile(args, { database = db } = {}) {
  if (!args.includes("--confirm-reconciliation")) {
    throw new Error("reconcile requires --confirm-reconciliation");
  }
  return reconciliation.resolve({
    requestId: flagValue(args, "--request-id"),
    itemType: flagValue(args, "--item-type"),
    itemId: flagValue(args, "--item-id"),
    decision: flagValue(args, "--decision"),
    expectedRevision: flagValue(args, "--expected-revision"),
    reason: flagValue(args, "--reason"),
    evidenceRef: flagValue(args, "--evidence-ref"),
  }, { db: database });
}

async function rollback(args, { database = db, migrate = migrateDown, env = process.env } = {}) {
  if (!args.includes("--allow-destructive") || !args.includes("--confirm-phase17")) {
    throw new Error("rollback requires --allow-destructive --confirm-phase17");
  }
  if (String(env.MULTIBOT_ROLE_MODE || "off").toLowerCase() !== "off") {
    throw new Error("set MULTIBOT_ROLE_MODE=off before rollback");
  }
  const active = await database.query("SELECT COUNT(*)::int AS count FROM workflow_runs WHERE status IN ('RUNNING','WAITING_APPROVAL','NEEDS_RECONCILIATION')");
  if (active.rows[0].count > 0) throw new Error("rollback blocked while Phase 17 workflows are non-terminal");
  const undelivered = await database.query(
    "SELECT COUNT(*)::int AS count FROM outbox_events WHERE status IN ('PENDING','DISPATCHING','RETRY_WAIT','NEEDS_RECONCILIATION')"
  );
  if (undelivered.rows[0].count > 0) throw new Error("rollback blocked while Phase 17 outbox events are undelivered");
  const results = [];
  for (const migrationId of [...PHASE17_MIGRATIONS].reverse()) {
    results.push(await migrate(migrationId, { allowDestructive: true }));
  }
  return results;
}

async function migratePhase17({ migrate = migrateUp } = {}) {
  const results = [];
  for (const migrationId of PHASE17_MIGRATIONS) results.push(await migrate(migrationId));
  return results;
}

async function main(args = process.argv.slice(2)) {
  const command = args[0] || "status";
  let result;
  if (command === "migrate") result = await migratePhase17();
  else if (command === "status") result = await status();
  else if (command === "readiness") result = await readiness();
  else if (command === "reconcile-list") result = await reconciliationInventory();
  else if (command === "reconcile") result = await reconcile(args.slice(1));
  else if (command === "credential-inventory") result = await credentialInventory();
  else if (command === "verify-role-profiles") result = await verifyRoleProfiles(args.slice(1));
  else if (command === "fingerprint-credentials") result = await fingerprintCredentials(args.slice(1));
  else if (command === "adopt-legacy-credentials") result = await adoptLegacyCredentials(args.slice(1));
  else if (command === "import-candidate-credentials") result = await importCandidateCredentials(args.slice(1));
  else if (command === "revoke-candidate-credentials") result = await revokeCandidateCredentials(args.slice(1));
  else if (command === "recover") result = await watchdog.recover({ managerInstanceId: process.env.BOT_INSTANCE_ID });
  else if (command === "bootstrap-roles") result = await bootstrapRoles(args.slice(1));
  else if (command === "provision-role") result = await provision(args[1], args[2]);
  else if (command === "rollback") result = await rollback(args.slice(1));
  else throw new Error("Usage: phase17 migrate|status|readiness|reconcile-list|reconcile --request-id <id> --item-type <ROLE_JOB|OUTBOX_EVENT> --item-id <id> --decision <RETRY|DEAD_LETTER> --expected-revision <n> --reason <text> --evidence-ref <ref> --confirm-reconciliation|credential-inventory|verify-role-profiles [six env files]|fingerprint-credentials --confirm-fingerprint-backfill|adopt-legacy-credentials --confirm-legacy-role-mapping|import-candidate-credentials --confirm-candidate-import|revoke-candidate-credentials --confirm-invalid-candidate-revocation|recover|bootstrap-roles --create-postgres-roles --write-env-profiles|provision-role <principal> <role>|rollback --allow-destructive --confirm-phase17");
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(`[phase17] ${error.message}`);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  ROLE_PROFILES,
  PHASE17_MIGRATIONS,
  CANDIDATE_CREDENTIAL_MAPPINGS,
  LEGACY_CREDENTIAL_MAPPINGS,
  adoptLegacyCredentials,
  bootstrapRoles,
  commonFunctions,
  credentialInventory,
  fingerprintCredentials,
  importCandidateCredentials,
  main,
  migratePhase17,
  provision,
  provisionOnClient,
  readiness,
  reconcile,
  reconciliationInventory,
  revokeCandidateCredentials,
  roleFunctions,
  roleProfile,
  rollback,
  status,
  verifyRoleProfiles,
};
