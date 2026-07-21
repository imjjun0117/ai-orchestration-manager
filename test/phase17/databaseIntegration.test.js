const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const enabled = process.env.PHASE17_DB_TEST === "1";

if (!enabled) {
  test("Phase 17 PostgreSQL integration suite", { skip: "set PHASE17_DB_TEST=1 to run disposable DB tests" }, () => {});
} else {
  dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: false, quiet: true });
  const { migrateDown, migrateUp } = require("../../src/db/migrationRunner");
  const publicationService = require("../../src/controlPlane/publicationService");

  const baseUrl = process.env.PHASE17_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("PHASE17_TEST_DATABASE_URL or DATABASE_URL is required");
  const name = `ai_manager_phase17_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g, "_");
  const targetUrl = new URL(baseUrl);
  targetUrl.pathname = `/${name}`;
  let admin;
  let pool;
  let principal;
  let phase17Applied = false;

  async function bind(role) {
    await pool.query(
      `INSERT INTO bot_role_principals(db_principal, bot_role, provisioned_by)
       VALUES ($1,$2,$1)
       ON CONFLICT (db_principal) DO UPDATE SET bot_role = EXCLUDED.bot_role, enabled = TRUE, updated_at = CURRENT_TIMESTAMP`,
      [principal, role]
    );
  }

  async function register(role, instanceId) {
    await bind(role);
    const { rows } = await pool.query(
      "SELECT * FROM register_bot_instance($1,$2,$3,NULL,NULL,'test-host',$4,'test', '{}'::jsonb, '{}'::jsonb)",
      [instanceId, role, role === "manager" ? "orchestrator" : role, process.pid]
    );
    return rows[0];
  }

  async function receive(messageId, suffix = messageId, definition = "phase17-default-v1") {
    await bind("manager");
    const { rows } = await pool.query(
      `SELECT * FROM receive_discord_command($1,'guild','channel','manager-01',$2,$3,$4,$4,'user',$5,$6,$7,$8)`,
      [messageId, `corr-${suffix}`, `task-${suffix}`, `request-${suffix}`, `run-${suffix}`, `node-${suffix}`, `job-${suffix}`, definition]
    );
    return rows[0];
  }

  async function claim(role, instanceId, leaseMs = 30_000) {
    await bind(role);
    const { rows } = await pool.query("SELECT * FROM claim_role_job($1,$2)", [instanceId, leaseMs]);
    return rows[0] || null;
  }

  async function complete(role, instanceId, job) {
    await bind(role);
    const { rows } = await pool.query(
      "SELECT * FROM complete_role_job($1,$2,$3,$4,NULL,$5::jsonb)",
      [job.id, instanceId, job.claim_token, job.input_artifact_hash, JSON.stringify({ ok: true, role })]
    );
    return rows[0];
  }

  async function advance(runId, nodeId) {
    await bind("manager");
    const { rows } = await pool.query("SELECT * FROM advance_workflow_node($1,$2,'manager-01')", [runId, nodeId]);
    return rows[0];
  }

  before(async () => {
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE "${name}"`);
    pool = new Pool({ connectionString: targetUrl.toString(), max: 50 });
    pool.on("error", () => {});
    principal = (await pool.query("SELECT SESSION_USER AS principal")).rows[0].principal;
    await pool.query(fs.readFileSync(path.resolve(__dirname, "../../src/db/schema.sql"), "utf8"));
    await migrateUp("016_channel_credentials", { pool });
    await migrateUp("017_workspace_safety", { pool });
    await migrateUp("017_workspace_safety_rework", { pool });
    await migrateUp("018_durable_control_plane", { pool });
    await migrateUp("019_phase17_credential_enrollment", { pool });
    phase17Applied = true;
    for (const role of ["manager", "planner", "coder", "reviewer", "qa", "summarizer"]) {
      await register(role, `${role === "manager" ? "manager" : role}-01`);
    }
  });

  after(async () => {
    if (pool) {
      if (phase17Applied) {
        await migrateDown("019_phase17_credential_enrollment", { pool, allowDestructive: true }).catch(() => {});
        await migrateDown("018_durable_control_plane", { pool, allowDestructive: true }).catch(() => {});
      }
      await migrateDown("017_workspace_safety_rework", { pool, allowDestructive: true }).catch(() => {});
      await migrateDown("017_workspace_safety", { pool, allowDestructive: true }).catch(() => {});
      await migrateDown("016_channel_credentials", { pool, allowDestructive: true }).catch(() => {});
      await pool.end();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  test("Phase 17 tables, sequences, and transaction functions are not exposed to PUBLIC", async () => {
    const routines = await pool.query(
      `SELECT routine_name FROM information_schema.routine_privileges
       WHERE routine_schema='public' AND grantee='PUBLIC' AND routine_name LIKE '%role_job%'`
    );
    assert.deepEqual(routines.rows, []);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.table_privileges
       WHERE table_schema='public' AND grantee='PUBLIC' AND table_name IN ('role_jobs','workflow_runs','outbox_events')`
    );
    assert.deepEqual(tables.rows, []);
    const enrollmentRoutines = await pool.query(
      `SELECT routine_name FROM information_schema.routine_privileges
       WHERE routine_schema='public' AND grantee='PUBLIC'
         AND routine_name IN ('store_phase17_channel_credential','revoke_phase17_channel_credential')`
    );
    assert.deepEqual(enrollmentRoutines.rows, []);
  });

  test("runtime credential enrollment is instance-bound and can reactivate then revoke its own row", async () => {
    await bind("qa");
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const stored = (await pool.query(
      `SELECT * FROM store_phase17_channel_credential(
         'qa-01','discord','ciphertext','nonce','auth-tag',1,$1,'{"role":"qa"}'::jsonb
       )`,
      [fingerprint]
    )).rows[0];
    assert.deepEqual(
      { instance: stored.bot_instance_id, channel: stored.channel_type, status: stored.status, keyVersion: stored.key_version },
      { instance: "qa-01", channel: "discord", status: "ACTIVE", keyVersion: 1 }
    );
    const row = (await pool.query(
      "SELECT status, metadata_json FROM channel_credentials WHERE channel_type='discord' AND bot_instance_id='qa-01'"
    )).rows[0];
    assert.equal(row.status, "ACTIVE");
    assert.equal(row.metadata_json.tokenFingerprint, fingerprint);
    assert.equal(row.metadata_json.source, "phase17-runtime-enrollment");
    assert.equal((await pool.query("SELECT encrypted_token FROM get_phase17_channel_credential('qa-01','discord')")).rows[0].encrypted_token, "ciphertext");

    await bind("reviewer");
    await assert.rejects(
      pool.query(
        `SELECT * FROM store_phase17_channel_credential(
           'qa-01','discord','other','nonce','auth-tag',1,$1,'{}'::jsonb
         )`,
        [fingerprint]
      ),
      /principal-bound instance/
    );

    await bind("qa");
    const revoked = (await pool.query(
      "SELECT * FROM revoke_phase17_channel_credential('qa-01','discord','invalid token')"
    )).rows[0];
    assert.equal(revoked.status, "REVOKED");
  });

  test("principal-role binding rejects Manager and credential APIs after an env-style role switch", async () => {
    await bind("planner");
    await assert.rejects(
      pool.query(
        `SELECT * FROM receive_discord_command(
           'principal-negative','guild','channel','manager-01','corr-negative','task-negative',
           'negative','negative','user','run-negative','node-negative','job-negative','phase17-default-v1'
         )`
      ),
      /Manager-only ingress rejected/
    );
    await assert.rejects(
      pool.query("SELECT * FROM advance_workflow_node('missing','missing','manager-01')"),
      /active Manager/
    );
    await assert.rejects(
      pool.query("SELECT * FROM get_phase17_channel_credential('manager-01','discord')"),
      /principal-bound instance/
    );
  });

  test("twenty-way duplicate Manager ingress creates one task, workflow, and first job", async () => {
    await bind("manager");
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => pool.query(
      `SELECT * FROM receive_discord_command('discord-duplicate','guild','channel','manager-01',$1,$2,$3,$3,'user',$4,$5,$6,'phase17-default-v1')`,
      [`corr-dup-${index}`, `task-dup-${index}`, `duplicate-${index}`, `run-dup-${index}`, `node-dup-${index}`, `job-dup-${index}`]
    )));
    assert.equal(results.flatMap((result) => result.rows).filter((row) => !row.was_duplicate).length, 1);
    const receipt = await pool.query("SELECT * FROM discord_event_receipts WHERE source_message_id='discord-duplicate'");
    assert.equal(receipt.rowCount, 1);
    const counts = await pool.query(
      `SELECT (SELECT COUNT(*) FROM tasks WHERE id LIKE 'task-dup-%')::int AS tasks,
              (SELECT COUNT(*) FROM workflow_runs WHERE id LIKE 'run-dup-%')::int AS runs,
              (SELECT COUNT(*) FROM role_jobs WHERE id LIKE 'job-dup-%')::int AS jobs`
    );
    assert.deepEqual(counts.rows[0], { tasks: 1, runs: 1, jobs: 1 });
    const queued = await claim("planner", "planner-01");
    await complete("planner", "planner-01", queued);
  });

  test("wrong role cannot claim and twenty planner claimers have exactly one winner", async () => {
    const accepted = await receive("claim-race", "claim-race");
    assert.equal(await claim("coder", "coder-01"), null);
    await bind("planner");
    const claims = await Promise.all(Array.from({ length: 20 }, () => pool.query("SELECT * FROM claim_role_job('planner-01',30000)")));
    const winners = claims.flatMap((result) => result.rows);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].id, accepted.accepted_role_job_id);
    await complete("planner", "planner-01", winners[0]);
  });

  test("worker completion only records a result; Manager separately advances and resolves approval", async () => {
    const accepted = await receive("workflow-e2e", "workflow-e2e");
    const planner = await claim("planner", "planner-01");
    await complete("planner", "planner-01", planner);
    let run = (await pool.query("SELECT * FROM workflow_runs WHERE id=$1", [accepted.accepted_workflow_run_id])).rows[0];
    assert.equal(run.status, "RUNNING");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM role_jobs WHERE workflow_run_id=$1", [run.id])).rows[0].count, 1);
    run = await advance(run.id, planner.workflow_node_id);
    assert.equal(run.status, "WAITING_APPROVAL");
    const redelivered = await advance(run.id, planner.workflow_node_id);
    assert.equal(redelivered.status, "WAITING_APPROVAL");
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM approvals WHERE workflow_run_id=$1 AND workflow_node_id=$2",
      [run.id, planner.workflow_node_id]
    )).rows[0].count, 1);
    await bind("manager");
    run = (await pool.query("SELECT * FROM resolve_workflow_approval($1,$2,'manager-01',TRUE,'approved')", [run.id, planner.workflow_node_id])).rows[0];
    assert.equal(run.status, "RUNNING");
    const coder = await claim("coder", "coder-01");
    assert.equal(coder.target_role, "coder");
    await complete("coder", "coder-01", coder);
    await advance(run.id, coder.workflow_node_id);
    for (const role of ["reviewer", "qa", "summarizer"]) {
      const job = await claim(role, `${role}-01`);
      assert.equal(job.target_role, role);
      await complete(role, `${role}-01`, job);
      run = await advance(run.id, job.workflow_node_id);
      if (role === "summarizer") {
        assert.equal(run.status, "WAITING_APPROVAL");
        await bind("manager");
        run = (await pool.query("SELECT * FROM resolve_workflow_approval($1,$2,'manager-01',TRUE,'done')", [run.id, job.workflow_node_id])).rows[0];
      }
    }
    assert.equal(run.status, "SUCCEEDED");
  });

  test("expired safe lease retries, stale completion is rejected, and unsafe coder lease reconciles", async () => {
    await receive("expired-planner", "expired-planner", "phase17-planner-v1");
    const planner = await claim("planner", "planner-01", 1);
    await pool.query("SELECT pg_sleep(0.01)");
    await bind("planner");
    await assert.rejects(
      pool.query("SELECT * FROM complete_role_job($1,'planner-01',$2,NULL,NULL,'{}'::jsonb)", [planner.id, planner.claim_token]),
      /job completion rejected/
    );
    await bind("manager");
    const safeRecovery = (await pool.query("SELECT * FROM recover_phase17_control_plane('manager-01')")).rows[0];
    assert.ok(safeRecovery.retried_jobs >= 1);
    assert.equal((await pool.query("SELECT status FROM role_jobs WHERE id=$1", [planner.id])).rows[0].status, "RETRY_WAIT");
    const reclaimed = await claim("planner", "planner-01", 30_000);
    assert.equal(reclaimed.id, planner.id);
    assert.equal(reclaimed.last_error_code, null);
    await bind("manager");
    const noRaceRecovery = (await pool.query("SELECT * FROM recover_phase17_control_plane('manager-01')")).rows[0];
    assert.equal(noRaceRecovery.retried_jobs, 0);
    const liveState = await pool.query(
      `SELECT j.status AS job_status, n.status AS node_status, i.status AS instance_status, i.current_job_id
       FROM role_jobs j JOIN workflow_nodes n ON n.id=j.workflow_node_id
       JOIN bot_instances i ON i.instance_id='planner-01' WHERE j.id=$1`,
      [planner.id]
    );
    assert.deepEqual(liveState.rows[0], {
      job_status: "RUNNING", node_status: "RUNNING", instance_status: "BUSY", current_job_id: planner.id,
    });
    await complete("planner", "planner-01", reclaimed);

    await receive("expired-coder", "expired-coder", "phase17-coder-v1");
    const coder = await claim("coder", "coder-01", 1);
    await pool.query("SELECT pg_sleep(0.01)");
    await bind("manager");
    const unsafeRecovery = (await pool.query("SELECT * FROM recover_phase17_control_plane('manager-01')")).rows[0];
    assert.ok(unsafeRecovery.reconciled_jobs >= 1);
    assert.equal((await pool.query("SELECT status FROM role_jobs WHERE id=$1", [coder.id])).rows[0].status, "NEEDS_RECONCILIATION");
  });

  test("outbox atomic claim has one winner and uncertain delivery requires reconciliation", async () => {
    await receive("outbox-race", "outbox-race", "phase17-planner-v1");
    await bind("manager");
    const notice = await pool.query(
      "SELECT * FROM enqueue_manager_notice('manager-01','ops-sql','channel','OPERATIONAL_RESPONSE','hello')"
    );
    assert.equal(notice.rows[0].event_type, "OPERATIONAL_RESPONSE");
    await pool.query("UPDATE outbox_events SET available_at = CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE target_role='manager'");
    await pool.query(
      `INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload_json,target_role,idempotency_key,correlation_id)
       VALUES ('outbox-race-one','test','test','OPERATIONAL_RESPONSE','{"channelId":"channel","result":{"text":"ok"}}','manager','outbox-race-one','corr-outbox')`
    );
    const attempts = await Promise.all(Array.from({ length: 20 }, () => pool.query("SELECT * FROM claim_outbox_event('manager-01',30000)")));
    const winners = attempts.flatMap((result) => result.rows);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].id, "outbox-race-one");
    const failed = await pool.query(
      "SELECT * FROM fail_outbox_event($1,'manager-01',$2,'ACK_LOST','delivery unknown',TRUE,1000)",
      [winners[0].id, winners[0].claim_token]
    );
    assert.equal(failed.rows[0].status, "NEEDS_RECONCILIATION");
  });

  test("shadow publication writes a SHADOWED projection and never calls Discord", async () => {
    const accepted = await receive("publication-shadow", "publication-shadow", "phase17-planner-v1");
    await pool.query("UPDATE outbox_events SET available_at = CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE target_role='manager'");
    await pool.query("UPDATE outbox_events SET available_at = CURRENT_TIMESTAMP WHERE aggregate_id=$1 AND event_type='COMMAND_ACCEPTED'", [accepted.accepted_workflow_run_id]);
    await bind("manager");
    const claimed = (await pool.query("SELECT * FROM claim_outbox_event('manager-01',30000)")).rows[0];
    assert.equal(claimed.event_type, "COMMAND_ACCEPTED");
    const publication = await publicationService.publish(claimed, {
      config: { mode: "shadow", instanceId: "manager-01" },
      db: { query: pool.query.bind(pool), pool },
    });
    assert.equal(publication.status, "SHADOWED");
    assert.equal((await pool.query("SELECT status FROM outbox_events WHERE id=$1", [claimed.id])).rows[0].status, "SHADOWED");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM discord_publications WHERE outbox_event_id=$1", [claimed.id])).rows[0].count, 1);
    assert.ok(accepted.accepted_task_id);
  });

  test("down/up rollback preserves legacy tasks and reapplies cleanly", async () => {
    await pool.query("INSERT INTO tasks(id,title,original_request,status) VALUES ('legacy-phase17','legacy','legacy','DONE')");
    await migrateDown("019_phase17_credential_enrollment", { pool, allowDestructive: true });
    await migrateDown("018_durable_control_plane", { pool, allowDestructive: true });
    phase17Applied = false;
    assert.equal((await pool.query("SELECT status FROM tasks WHERE id='legacy-phase17'")).rows[0].status, "DONE");
    assert.equal((await pool.query("SELECT to_regclass('public.role_jobs') AS relation")).rows[0].relation, null);
    await migrateUp("018_durable_control_plane", { pool });
    await migrateUp("019_phase17_credential_enrollment", { pool });
    phase17Applied = true;
    assert.equal((await pool.query("SELECT status FROM tasks WHERE id='legacy-phase17'")).rows[0].status, "DONE");
  });
}
