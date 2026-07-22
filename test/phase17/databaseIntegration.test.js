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
  const reconciliationService = require("../../src/controlPlane/reconciliationService");

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
    await migrateUp("020_phase17_operator_reconciliation", { pool });
    await migrateUp("021_phase17_workflow_approvals", { pool });
    phase17Applied = true;
    for (const role of ["manager", "planner", "coder", "reviewer", "qa", "summarizer"]) {
      await register(role, `${role === "manager" ? "manager" : role}-01`);
    }
  });

  after(async () => {
    if (pool) {
      if (phase17Applied) {
        await migrateDown("021_phase17_workflow_approvals", { pool, allowDestructive: true }).catch(() => {});
        await migrateDown("020_phase17_operator_reconciliation", { pool, allowDestructive: true }).catch(() => {});
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
       WHERE table_schema='public' AND grantee='PUBLIC'
         AND table_name IN ('role_jobs','workflow_runs','outbox_events','phase17_reconciliation_actions')`
    );
    assert.deepEqual(tables.rows, []);
    const enrollmentRoutines = await pool.query(
      `SELECT routine_name FROM information_schema.routine_privileges
       WHERE routine_schema='public' AND grantee='PUBLIC'
         AND routine_name IN ('store_phase17_channel_credential','revoke_phase17_channel_credential')`
    );
    assert.deepEqual(enrollmentRoutines.rows, []);
    const reconciliationRoutines = await pool.query(
      `SELECT routine_name FROM information_schema.routine_privileges
       WHERE routine_schema='public' AND grantee='PUBLIC'
         AND routine_name IN ('reconcile_phase17_item','phase17_bump_reconciliation_revision')`
    );
    assert.deepEqual(reconciliationRoutines.rows, []);
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
    await assert.rejects(
      pool.query(
        "SELECT * FROM resolve_discord_workflow_approval($1,$2,'manager-01','intruder','channel',TRUE,'approved')",
        [run.id, planner.workflow_node_id]
      ),
      /requester or channel binding changed/
    );
    run = (await pool.query(
      "SELECT * FROM resolve_discord_workflow_approval($1,$2,'manager-01','user','channel',TRUE,'approved')",
      [run.id, planner.workflow_node_id]
    )).rows[0];
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
        run = (await pool.query(
          "SELECT * FROM resolve_discord_workflow_approval($1,$2,'manager-01','user','channel',TRUE,'done')",
          [run.id, job.workflow_node_id]
        )).rows[0];
      }
    }
    assert.equal(run.status, "SUCCEEDED");
    assert.equal((await pool.query(
      "SELECT approved_by FROM approvals WHERE workflow_run_id=$1 AND workflow_node_id=$2",
      [run.id, planner.workflow_node_id]
    )).rows[0].approved_by, "user");
  });

  test("coder-only workflow requires approval after candidate creation", async () => {
    const graph = (await pool.query(
      "SELECT graph_json FROM workflow_definitions WHERE id='phase17-coder-v1'"
    )).rows[0].graph_json;
    assert.equal(graph.nodes[0].requiresApprovalAfter, true);
  });

  test("terminal Discord approval accepts only a fully finalized bound candidate version", async () => {
    const accepted = await receive("candidate-handoff", "candidate-handoff", "phase17-summarizer-v1");
    const summarizer = await claim("summarizer", "summarizer-01");
    await complete("summarizer", "summarizer-01", summarizer);
    let run = await advance(accepted.accepted_workflow_run_id, summarizer.workflow_node_id);
    assert.equal(run.status, "WAITING_APPROVAL");

    const baseSha = "1".repeat(40);
    const candidateSha = "2".repeat(40);
    const artifactHash = `sha256:${"3".repeat(64)}`;
    const contextHash = `sha256:${"4".repeat(64)}`;
    await pool.query("INSERT INTO workspace_lock_heads(workspace_id,current_fencing_token) VALUES ('canonical:candidate-handoff',1)");
    await pool.query(
      `INSERT INTO workspace_leases(
         lease_id,workspace_id,lease_owner_instance_id,lease_owner_task_id,
         lease_owner_operation_id,fencing_token,mode,expires_at,released_at
       ) VALUES (
         'lease-candidate-handoff','canonical:candidate-handoff','manager-01',$1,
         'finalize-candidate-handoff',1,'FINALIZE_EXCLUSIVE',CURRENT_TIMESTAMP + INTERVAL '1 hour',CURRENT_TIMESTAMP
       )`,
      [accepted.accepted_task_id]
    );
    await pool.query(
      `INSERT INTO isolated_workspaces(
         id,task_id,workspace_id,lease_id,lease_owner_operation_id,
         canonical_repository_path,workspace_path,base_commit_sha,candidate_commit_sha,status
       ) VALUES (
         'workspace-candidate-handoff',$1,'isolated:candidate-handoff','lease-candidate-handoff',
         'finalize-candidate-handoff','/tmp/canonical.git','/tmp/candidate',$2,$3,'CANDIDATE_READY'
       )`,
      [accepted.accepted_task_id, baseSha, candidateSha]
    );
    await pool.query(
      `INSERT INTO artifacts(
         id,task_id,workspace_id,isolated_workspace_id,artifact_type,artifact_hash,
         context_manifest_hash,base_commit_sha,candidate_commit_sha,manifest_json,file_manifest_json,created_by
       ) VALUES (
         'artifact-candidate-handoff',$1,'isolated:candidate-handoff','workspace-candidate-handoff',
         'CANDIDATE_COMMIT',$2,$3,$4,$5,'{}'::jsonb,'[]'::jsonb,'coder-01'
       )`,
      [accepted.accepted_task_id, artifactHash, contextHash, baseSha, candidateSha]
    );
    const candidateApproval = (await pool.query(
      `INSERT INTO approvals(
         task_id,action,status,requested_by,approved_by,artifact_id,artifact_hash,
         context_manifest_hash,base_commit_sha,candidate_commit_sha,workspace_id,
         lease_owner_operation_id,fencing_token,delegation_scope,
         expected_task_state,expected_task_version,expires_at
       ) VALUES (
         $1,'commit_approval_phase16','APPROVED','coder-01','user','artifact-candidate-handoff',$2,
         $3,$4,$5,'canonical:candidate-handoff','finalize-candidate-handoff',1,
         '{"allowedActorIds":["manager-01"],"allowedTargetRefs":["refs/heads/main"]}'::jsonb,
         'CREATED',0,CURRENT_TIMESTAMP + INTERVAL '1 hour'
       ) RETURNING id`,
      [accepted.accepted_task_id, artifactHash, contextHash, baseSha, candidateSha]
    )).rows[0];
    await pool.query(
      `INSERT INTO workspace_finalizations(
         id,approval_id,task_id,artifact_id,workspace_id,lease_id,lease_owner_operation_id,
         fencing_token,base_commit_sha,candidate_commit_sha,artifact_hash,context_manifest_hash,
         target_ref,claim_token,status,claimed_by,integrated_commit_sha,completed_at
       ) VALUES (
         'finalization-candidate-handoff',$1,$2,'artifact-candidate-handoff','canonical:candidate-handoff',
         'lease-candidate-handoff','finalize-candidate-handoff',1,$3,$4,$5,$6,
         'refs/heads/main','claim-candidate-handoff','SUCCEEDED','manager-01',$4,CURRENT_TIMESTAMP
       )`,
      [candidateApproval.id, accepted.accepted_task_id, baseSha, candidateSha, artifactHash, contextHash]
    );
    await pool.query("UPDATE isolated_workspaces SET status='CLEANED', cleaned_at=CURRENT_TIMESTAMP WHERE id='workspace-candidate-handoff'");
    await pool.query("UPDATE tasks SET status='DONE', row_version=row_version+1 WHERE id=$1", [accepted.accepted_task_id]);

    await bind("manager");
    run = (await pool.query(
      "SELECT * FROM resolve_discord_workflow_approval($1,$2,'manager-01','user','channel',TRUE,'done')",
      [run.id, summarizer.workflow_node_id]
    )).rows[0];
    assert.equal(run.status, "SUCCEEDED");
    const task = (await pool.query("SELECT status,lifecycle_status FROM tasks WHERE id=$1", [accepted.accepted_task_id])).rows[0];
    assert.deepEqual(task, { status: "DONE", lifecycle_status: "SUCCEEDED" });
  });

  test("terminal Discord rejection accepts only a cleaned rejected bound candidate version", async () => {
    const accepted = await receive("candidate-rejection", "candidate-rejection", "phase17-summarizer-v1");
    const summarizer = await claim("summarizer", "summarizer-01");
    await complete("summarizer", "summarizer-01", summarizer);
    let run = await advance(accepted.accepted_workflow_run_id, summarizer.workflow_node_id);
    assert.equal(run.status, "WAITING_APPROVAL");

    const baseSha = "5".repeat(40);
    const candidateSha = "6".repeat(40);
    const artifactHash = `sha256:${"7".repeat(64)}`;
    const contextHash = `sha256:${"8".repeat(64)}`;
    await pool.query("INSERT INTO workspace_lock_heads(workspace_id,current_fencing_token) VALUES ('canonical:candidate-rejection',1)");
    await pool.query(
      `INSERT INTO workspace_leases(
         lease_id,workspace_id,lease_owner_instance_id,lease_owner_task_id,
         lease_owner_operation_id,fencing_token,mode,expires_at,released_at
       ) VALUES (
         'lease-candidate-rejection','canonical:candidate-rejection','manager-01',$1,
         'finalize-candidate-rejection',1,'FINALIZE_EXCLUSIVE',CURRENT_TIMESTAMP + INTERVAL '1 hour',CURRENT_TIMESTAMP
       )`,
      [accepted.accepted_task_id]
    );
    await pool.query(
      `INSERT INTO isolated_workspaces(
         id,task_id,workspace_id,lease_id,lease_owner_operation_id,
         canonical_repository_path,workspace_path,base_commit_sha,candidate_commit_sha,status,cleaned_at
       ) VALUES (
         'workspace-candidate-rejection',$1,'isolated:candidate-rejection','lease-candidate-rejection',
         'finalize-candidate-rejection','/tmp/canonical.git','/tmp/candidate',$2,$3,'CLEANED',CURRENT_TIMESTAMP
       )`,
      [accepted.accepted_task_id, baseSha, candidateSha]
    );
    await pool.query(
      `INSERT INTO artifacts(
         id,task_id,workspace_id,isolated_workspace_id,artifact_type,artifact_hash,
         context_manifest_hash,base_commit_sha,candidate_commit_sha,manifest_json,file_manifest_json,created_by
       ) VALUES (
         'artifact-candidate-rejection',$1,'isolated:candidate-rejection','workspace-candidate-rejection',
         'CANDIDATE_COMMIT',$2,$3,$4,$5,'{}'::jsonb,'[]'::jsonb,'coder-01'
       )`,
      [accepted.accepted_task_id, artifactHash, contextHash, baseSha, candidateSha]
    );
    await pool.query(
      `INSERT INTO approvals(
         task_id,action,status,requested_by,approved_by,reason,artifact_id,artifact_hash,
         context_manifest_hash,base_commit_sha,candidate_commit_sha,workspace_id,
         lease_owner_operation_id,fencing_token,delegation_scope,
         expected_task_state,expected_task_version,expires_at
       ) VALUES (
         $1,'commit_approval_phase16','REJECTED','coder-01','user','QA 실패','artifact-candidate-rejection',$2,
         $3,$4,$5,'canonical:candidate-rejection','finalize-candidate-rejection',1,
         '{"allowedActorIds":["manager-01"],"allowedTargetRefs":["refs/heads/main"]}'::jsonb,
         'CREATED',0,CURRENT_TIMESTAMP + INTERVAL '1 hour'
       )`,
      [accepted.accepted_task_id, artifactHash, contextHash, baseSha, candidateSha]
    );
    await pool.query("UPDATE tasks SET status='REJECTED', row_version=row_version+1 WHERE id=$1", [accepted.accepted_task_id]);

    await bind("manager");
    run = (await pool.query(
      "SELECT * FROM resolve_discord_workflow_approval($1,$2,'manager-01','user','channel',FALSE,'QA 실패')",
      [run.id, summarizer.workflow_node_id]
    )).rows[0];
    assert.equal(run.status, "REJECTED");
    const task = (await pool.query("SELECT status,lifecycle_status FROM tasks WHERE id=$1", [accepted.accepted_task_id])).rows[0];
    assert.deepEqual(task, { status: "REJECTED", lifecycle_status: "REJECTED" });
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

  test("operator role-job reconciliation is idempotent, revision-fenced, audited, and workflow-consistent", async () => {
    await receive("operator-role-job", "operator-role-job", "phase17-coder-v1");
    const coder = await claim("coder", "coder-01");
    await bind("coder");
    const uncertain = (await pool.query(
      "SELECT * FROM fail_role_job($1,'coder-01',$2,'SIDE_EFFECT_UNKNOWN','operator test','fingerprint',TRUE,1000)",
      [coder.id, coder.claim_token]
    )).rows[0];
    assert.equal(uncertain.status, "NEEDS_RECONCILIATION");
    assert.equal(String(uncertain.reconciliation_revision), "1");

    const params = [
      "operator-role-job-retry-001", "ROLE_JOB", coder.id, "RETRY", "1",
      "외부 부작용이 없음을 작업 로그로 확인했습니다.", "incident:phase17-role-job-001",
    ];
    const repeated = await Promise.all(Array.from({ length: 12 }, () => pool.query(
      "SELECT * FROM reconcile_phase17_item($1,$2,$3,$4,$5::bigint,$6,$7)", params
    )));
    assert.equal(repeated.length, 12);
    assert.equal(new Set(repeated.map(({ rows }) => String(rows[0].id))).size, 1);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM phase17_reconciliation_actions WHERE request_id=$1", [params[0]]
    )).rows[0].count, 1);
    await assert.rejects(
      pool.query(
        "SELECT * FROM reconcile_phase17_item('operator-role-job-stale-002','ROLE_JOB',$1,'DEAD_LETTER',1,$2,$3)",
        [coder.id, "동일 revision의 중복 결정을 거부해야 합니다.", "incident:phase17-role-job-stale"]
      ),
      /compare-and-set failed/
    );

    const retryState = (await pool.query(
      `SELECT job.status AS job_status, job.max_attempts, job.attempt_count,
              node.status AS node_status, run.status AS run_status, task.lifecycle_status
       FROM role_jobs job
       JOIN workflow_nodes node ON node.id=job.workflow_node_id
       JOIN workflow_runs run ON run.id=job.workflow_run_id
       JOIN tasks task ON task.id=job.task_id
       WHERE job.id=$1`,
      [coder.id]
    )).rows[0];
    assert.equal(retryState.job_status, "RETRY_WAIT");
    assert.equal(retryState.node_status, "READY");
    assert.equal(retryState.run_status, "RUNNING");
    assert.equal(retryState.lifecycle_status, "RUNNING");
    assert.ok(retryState.max_attempts > retryState.attempt_count);

    const reclaimed = await claim("coder", "coder-01");
    assert.equal(reclaimed.id, coder.id);
    await bind("coder");
    const uncertainAgain = (await pool.query(
      "SELECT * FROM fail_role_job($1,'coder-01',$2,'SIDE_EFFECT_STILL_UNKNOWN','operator test','fingerprint-2',TRUE,1000)",
      [reclaimed.id, reclaimed.claim_token]
    )).rows[0];
    assert.equal(String(uncertainAgain.reconciliation_revision), "2");
    const dead = (await pool.query(
      `SELECT * FROM reconcile_phase17_item(
         'operator-role-job-dead-003','ROLE_JOB',$1,'DEAD_LETTER',2,$2,$3
       )`,
      [coder.id, "재실행 대신 명시적 실패 종결을 승인했습니다.", "incident:phase17-role-job-dead"]
    )).rows[0];
    assert.equal(dead.after_status, "DEAD_LETTER");
    assert.equal(String(dead.after_revision), "3");
    const terminal = (await pool.query(
      `SELECT job.status AS job_status, node.status AS node_status,
              run.status AS run_status, task.lifecycle_status
       FROM role_jobs job
       JOIN workflow_nodes node ON node.id=job.workflow_node_id
       JOIN workflow_runs run ON run.id=job.workflow_run_id
       JOIN tasks task ON task.id=job.task_id
       WHERE job.id=$1`,
      [coder.id]
    )).rows[0];
    assert.deepEqual(terminal, {
      job_status: "DEAD_LETTER", node_status: "FAILED", run_status: "FAILED", lifecycle_status: "FAILED",
    });
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM job_events WHERE role_job_id=$1 AND event_type LIKE 'OPERATOR_%'", [coder.id]
    )).rows[0].count, 2);
    await assert.rejects(
      pool.query("UPDATE phase17_reconciliation_actions SET reason='변조된 운영자 사유입니다.' WHERE request_id=$1", [params[0]]),
      /append-only/
    );
  });

  test("operator role-job retry guards fail closed and sibling dead-lettering preserves workflow consistency", async () => {
    await receive("operator-guard-artifact", "operator-guard-artifact", "phase17-coder-v1");
    const artifactJob = await claim("coder", "coder-01");
    await bind("coder");
    const artifactUncertain = (await pool.query(
      "SELECT * FROM fail_role_job($1,'coder-01',$2,'ARTIFACT_UNKNOWN','guard test','guard-artifact',TRUE,1000)",
      [artifactJob.id, artifactJob.claim_token]
    )).rows[0];
    await pool.query(
      `INSERT INTO artifacts(id,task_id,artifact_type,artifact_hash,manifest_json,created_by)
       VALUES ('artifact-operator-guard',$1,'TEST',$2,'{}'::jsonb,'phase17-test')`,
      [artifactUncertain.task_id, `sha256:${"a".repeat(64)}`]
    );
    await pool.query(
      "UPDATE role_jobs SET output_artifact_id='artifact-operator-guard' WHERE id=$1",
      [artifactJob.id]
    );
    await assert.rejects(
      pool.query(
        `SELECT * FROM reconcile_phase17_item(
           'operator-guard-artifact-retry','ROLE_JOB',$1,'RETRY',1,$2,$3
         )`,
        [artifactJob.id, "출력 산출물이 있는 작업은 재시도를 거부합니다.", "incident:phase17-guard-artifact"]
      ),
      /output artifact cannot be retried/
    );
    await pool.query(
      `SELECT * FROM reconcile_phase17_item(
         'operator-guard-artifact-dead','ROLE_JOB',$1,'DEAD_LETTER',1,$2,$3
       )`,
      [artifactJob.id, "출력 산출물 존재로 재실행 대신 실패 종결합니다.", "incident:phase17-guard-artifact-dead"]
    );

    await receive("operator-guard-control", "operator-guard-control", "phase17-coder-v1");
    const controlJob = await claim("coder", "coder-01");
    await bind("coder");
    const controlUncertain = (await pool.query(
      "SELECT * FROM fail_role_job($1,'coder-01',$2,'CONTROL_UNKNOWN','guard test','guard-control',TRUE,1000)",
      [controlJob.id, controlJob.claim_token]
    )).rows[0];
    await pool.query("UPDATE tasks SET control_state='PAUSED' WHERE id=$1", [controlUncertain.task_id]);
    await assert.rejects(
      pool.query(
        `SELECT * FROM reconcile_phase17_item(
           'operator-guard-control-retry','ROLE_JOB',$1,'RETRY',1,$2,$3
         )`,
        [controlJob.id, "중지된 task control 상태에서는 재시도를 거부합니다.", "incident:phase17-guard-control"]
      ),
      /control state must be RUNNING/
    );
    await pool.query("UPDATE tasks SET control_state='RUNNING' WHERE id=$1", [controlUncertain.task_id]);
    await pool.query(
      `SELECT * FROM reconcile_phase17_item(
         'operator-guard-control-dead','ROLE_JOB',$1,'DEAD_LETTER',1,$2,$3
       )`,
      [controlJob.id, "control guard 확인 후 작업을 실패로 종결합니다.", "incident:phase17-guard-control-dead"]
    );

    await receive("operator-guard-sibling", "operator-guard-sibling", "phase17-coder-v1");
    const primaryJob = await claim("coder", "coder-01");
    await bind("coder");
    const primaryUncertain = (await pool.query(
      "SELECT * FROM fail_role_job($1,'coder-01',$2,'SIBLING_UNKNOWN','guard test','guard-sibling',TRUE,1000)",
      [primaryJob.id, primaryJob.claim_token]
    )).rows[0];
    await pool.query(
      `INSERT INTO workflow_nodes(
         id,workflow_run_id,task_id,node_key,target_role,job_type,status
       ) VALUES (
         'node-operator-guard-sibling-secondary',$1,$2,'operator-guard-sibling-secondary','coder','TASK_CODE','NEEDS_RECONCILIATION'
       )`,
      [primaryUncertain.workflow_run_id, primaryUncertain.task_id]
    );
    await pool.query(
      `INSERT INTO role_jobs(
         id,workflow_run_id,workflow_node_id,task_id,target_role,job_type,status,
         idempotency_key,correlation_id,safe_to_retry
       ) VALUES (
         'job-operator-guard-sibling-secondary',$1,'node-operator-guard-sibling-secondary',$2,'coder','TASK_CODE',
         'NEEDS_RECONCILIATION','job-operator-guard-sibling-secondary','corr-operator-guard-sibling',FALSE
       )`,
      [primaryUncertain.workflow_run_id, primaryUncertain.task_id]
    );
    await assert.rejects(
      pool.query(
        `SELECT * FROM reconcile_phase17_item(
           'operator-guard-sibling-retry','ROLE_JOB',$1,'RETRY',1,$2,$3
         )`,
        [primaryJob.id, "미해결 sibling 작업이 있으면 재시도를 거부합니다.", "incident:phase17-guard-sibling"]
      ),
      /another unresolved workflow job/
    );
    await pool.query(
      `SELECT * FROM reconcile_phase17_item(
         'operator-guard-primary-dead','ROLE_JOB',$1,'DEAD_LETTER',1,$2,$3
       )`,
      [primaryJob.id, "primary 작업을 먼저 실패로 종결하고 sibling을 보존합니다.", "incident:phase17-guard-primary-dead"]
    );
    const waiting = (await pool.query(
      `SELECT run.status AS run_status, task.lifecycle_status
       FROM workflow_runs run JOIN tasks task ON task.id=run.task_id
       WHERE run.id=$1`,
      [primaryUncertain.workflow_run_id]
    )).rows[0];
    assert.equal(waiting.run_status, "NEEDS_RECONCILIATION");
    assert.notEqual(waiting.lifecycle_status, "FAILED");
    await pool.query(
      `SELECT * FROM reconcile_phase17_item(
         'operator-guard-sibling-dead','ROLE_JOB','job-operator-guard-sibling-secondary','DEAD_LETTER',0,$1,$2
       )`,
      ["마지막 sibling 작업도 명시적으로 실패 종결합니다.", "incident:phase17-guard-sibling-dead"]
    );
    const terminal = (await pool.query(
      `SELECT run.status AS run_status, task.lifecycle_status
       FROM workflow_runs run JOIN tasks task ON task.id=run.task_id
       WHERE run.id=$1`,
      [primaryUncertain.workflow_run_id]
    )).rows[0];
    assert.deepEqual(terminal, { run_status: "FAILED", lifecycle_status: "FAILED" });
  });

  test("operator outbox reconciliation resets publication safely and acknowledges a dead letter", async () => {
    await pool.query(
      `INSERT INTO outbox_events(
         id,aggregate_type,aggregate_id,event_type,payload_json,target_role,idempotency_key,correlation_id
       ) VALUES (
         'outbox-operator-recovery','test','operator-recovery','OPERATIONAL_RESPONSE',
         '{"channelId":"channel","result":{"text":"operator"}}','manager',
         'outbox-operator-recovery','corr-operator-recovery'
       )`
    );
    await pool.query(
      "UPDATE outbox_events SET status='NEEDS_RECONCILIATION', last_error_code='ACK_UNKNOWN' WHERE id='outbox-operator-recovery'"
    );
    await pool.query(
      `INSERT INTO discord_publications(
         id,outbox_event_id,publication_key,target_role,channel_id,correlation_marker,status
       ) VALUES (
         'publication-operator-recovery','outbox-operator-recovery','publication-operator-recovery',
         'manager','channel','marker-operator-recovery','NEEDS_RECONCILIATION'
       )`
    );
    const retried = (await pool.query(
      `SELECT * FROM reconcile_phase17_item(
         'operator-outbox-retry-001','OUTBOX_EVENT','outbox-operator-recovery','RETRY',1,$1,$2
       )`,
      ["Discord marker 재조회 후 안전하게 재처리합니다.", "incident:phase17-outbox-retry"]
    )).rows[0];
    assert.equal(retried.after_status, "RETRY_WAIT");
    const retryState = (await pool.query(
      `SELECT event.status, event.claim_token, event.claimed_by_instance_id,
              event.max_attempts, event.attempt_count, publication.status AS publication_status
       FROM outbox_events event
       JOIN discord_publications publication ON publication.outbox_event_id=event.id
       WHERE event.id='outbox-operator-recovery'`
    )).rows[0];
    assert.equal(retryState.status, "RETRY_WAIT");
    assert.equal(retryState.publication_status, "PENDING");
    assert.equal(retryState.claim_token, null);
    assert.equal(retryState.claimed_by_instance_id, null);
    assert.ok(retryState.max_attempts > retryState.attempt_count);

    await pool.query(
      "UPDATE outbox_events SET status='NEEDS_RECONCILIATION' WHERE id='outbox-operator-recovery'"
    );
    await pool.query(
      "UPDATE discord_publications SET status='NEEDS_RECONCILIATION' WHERE outbox_event_id='outbox-operator-recovery'"
    );
    const dead = (await pool.query(
      `SELECT * FROM reconcile_phase17_item(
         'operator-outbox-dead-002','OUTBOX_EVENT','outbox-operator-recovery','DEAD_LETTER',2,$1,$2
       )`,
      ["운영자가 재발신하지 않고 폐기하기로 승인했습니다.", "incident:phase17-outbox-dead"]
    )).rows[0];
    assert.equal(dead.after_status, "DEAD_LETTER");
    assert.equal(String(dead.after_revision), "3");
    assert.deepEqual((await pool.query(
      `SELECT event.status, publication.status AS publication_status
       FROM outbox_events event JOIN discord_publications publication ON publication.outbox_event_id=event.id
       WHERE event.id='outbox-operator-recovery'`
    )).rows[0], { status: "DEAD_LETTER", publication_status: "DEAD_LETTER" });
    const unresolved = await pool.query(
      `SELECT 1 FROM outbox_events event
       WHERE event.id='outbox-operator-recovery'
         AND NOT EXISTS (
           SELECT 1 FROM phase17_reconciliation_actions action
           WHERE action.item_type='OUTBOX_EVENT' AND action.item_id=event.id
             AND action.after_status=event.status
             AND action.after_revision=event.reconciliation_revision
         )`
    );
    assert.deepEqual(unresolved.rows, []);
  });

  test("concurrent operator requests have one revision-fenced winner", async () => {
    await pool.query(
      `INSERT INTO outbox_events(
         id,aggregate_type,aggregate_id,event_type,payload_json,target_role,idempotency_key,correlation_id,status
       ) VALUES (
         'outbox-operator-race','test','operator-race','ROLE_JOB_AVAILABLE','{}','planner',
         'outbox-operator-race','corr-operator-race','NEEDS_RECONCILIATION'
       )`
    );
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => pool.query(
      `SELECT * FROM reconcile_phase17_item(
         $1,'OUTBOX_EVENT','outbox-operator-race','RETRY',0,$2,$3
       )`,
      [`operator-outbox-race-${String(index).padStart(3, "0")}`, "동시 운영자 결정에서 단 하나만 반영합니다.", `incident:phase17-outbox-race-${index}`]
    )));
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(attempts.filter(({ status }) => status === "rejected").length, 19);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM phase17_reconciliation_actions WHERE item_id='outbox-operator-race'"
    )).rows[0].count, 1);
  });

  test("operator reconciliation inventory query returns only unresolved secret-safe projections", async () => {
    const rows = await reconciliationService.list({ db: pool });
    assert.ok(rows.some(({ item_id: itemId }) => itemId === "outbox-race-one"));
    assert.equal(rows.some(({ item_id: itemId }) => itemId === "outbox-operator-recovery"), false);
    for (const row of rows) {
      for (const forbidden of ["payload_json", "last_error_detail_redacted", "correlation_id", "channel_id", "discord_message_id"]) {
        assert.equal(Object.hasOwn(row, forbidden), false);
      }
    }
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
    await migrateDown("021_phase17_workflow_approvals", { pool, allowDestructive: true });
    await migrateDown("020_phase17_operator_reconciliation", { pool, allowDestructive: true });
    await migrateDown("019_phase17_credential_enrollment", { pool, allowDestructive: true });
    await migrateDown("018_durable_control_plane", { pool, allowDestructive: true });
    phase17Applied = false;
    assert.equal((await pool.query("SELECT status FROM tasks WHERE id='legacy-phase17'")).rows[0].status, "DONE");
    assert.equal((await pool.query("SELECT to_regclass('public.role_jobs') AS relation")).rows[0].relation, null);
    await migrateUp("018_durable_control_plane", { pool });
    await migrateUp("019_phase17_credential_enrollment", { pool });
    await migrateUp("020_phase17_operator_reconciliation", { pool });
    await migrateUp("021_phase17_workflow_approvals", { pool });
    phase17Applied = true;
    assert.equal((await pool.query("SELECT status FROM tasks WHERE id='legacy-phase17'")).rows[0].status, "DONE");
  });
}
