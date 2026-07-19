const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { after, before, test } = require("node:test");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const enabled = process.env.PHASE16_DB_TEST === "1";

if (!enabled) {
  test("Phase 16 PostgreSQL integration suite", { skip: "set PHASE16_DB_TEST=1 to run disposable DB tests" }, () => {});
} else {
  dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: false, quiet: true });

  const approvalService = require("../../src/core/approvalService");
  const hostIdentity = require("../../src/core/hostIdentity");
  const { migrateDown, migrateUp } = require("../../src/db/migrationRunner");
  const artifactService = require("../../src/workspace/artifactService");
  const finalizerService = require("../../src/workspace/finalizerService");
  const isolatedWorkspaceService = require("../../src/workspace/isolatedWorkspaceService");
  const leaseService = require("../../src/workspace/workspaceLeaseService");
  const taskControlService = require("../../src/workspace/taskControlService");

  const baseConnectionString = process.env.PHASE16_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!baseConnectionString) throw new Error("PHASE16_TEST_DATABASE_URL or DATABASE_URL is required");
  const databaseName = `ai_manager_phase16_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g, "_");
  const databaseUrl = new URL(baseConnectionString);
  databaseUrl.pathname = `/${databaseName}`;

  let adminPool;
  let pool;
  let migrationApplied = false;
  const temporaryPaths = [];
  const HASH_A = `sha256:${"a".repeat(64)}`;
  const HASH_B = `sha256:${"b".repeat(64)}`;

  function git(repository, ...args) {
    return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  }

  async function createTask(id, status = "READY_FOR_COMMIT") {
    await pool.query(
      `INSERT INTO tasks(id, title, original_request, status, created_by)
       VALUES ($1, $2, 'phase16 integration', $3, 'phase16-test')`,
      [id, id, status]
    );
  }

  before(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 40 });
    await pool.query(fs.readFileSync(path.resolve(__dirname, "../../src/db/schema.sql"), "utf8"));
    await migrateUp("017_workspace_safety", { pool });
    migrationApplied = true;
  });

  after(async () => {
    if (pool) {
      if (migrationApplied) await migrateDown("017_workspace_safety", { pool, allowDestructive: true });
      await pool.end();
    }
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
    for (const temporaryPath of temporaryPaths) fs.rmSync(temporaryPath, { recursive: true, force: true });
  });

  test("twenty readers coexist while an exclusive lease is rejected", async () => {
    const workspaceId = "canonical:phase16-readers";
    const leases = await Promise.all(
      Array.from({ length: 20 }, (_, index) => leaseService.acquireLease(
        {
          workspaceId,
          ownerInstanceId: `reader-${index}`,
          ownerOperationId: `read-op-${index}`,
          mode: "READ_SHARED",
          ttlMs: 30_000,
        },
        { db: pool }
      ))
    );
    assert.equal(leases.length, 20);
    assert.equal(new Set(leases.map((lease) => String(lease.fencing_token))).size, 1);
    await assert.rejects(
      leaseService.acquireLease(
        {
          workspaceId,
          ownerInstanceId: "writer",
          ownerOperationId: "write-op",
          mode: "WRITE_EXCLUSIVE",
          ttlMs: 30_000,
        },
        { db: pool }
      ),
      /active lease holders/
    );
    await Promise.all(leases.map((lease) => leaseService.releaseLease(
      {
        leaseId: lease.lease_id,
        ownerInstanceId: lease.lease_owner_instance_id,
        ownerOperationId: lease.lease_owner_operation_id,
        fencingToken: lease.fencing_token,
      },
      { db: pool }
    )));
  });

  test("exclusive acquisition has one winner and stale fencing cannot heartbeat", async () => {
    const workspaceId = "canonical:phase16-fencing";
    const attempts = await Promise.allSettled([
      leaseService.acquireLease({
        workspaceId,
        ownerInstanceId: "finalizer-a",
        ownerOperationId: "finalize-a",
        mode: "FINALIZE_EXCLUSIVE",
        ttlMs: 30_000,
      }, { db: pool }),
      leaseService.acquireLease({
        workspaceId,
        ownerInstanceId: "finalizer-b",
        ownerOperationId: "finalize-b",
        mode: "FINALIZE_EXCLUSIVE",
        ttlMs: 30_000,
      }, { db: pool }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const first = attempts.find((attempt) => attempt.status === "fulfilled").value;
    await leaseService.releaseLease({
      leaseId: first.lease_id,
      ownerInstanceId: first.lease_owner_instance_id,
      ownerOperationId: first.lease_owner_operation_id,
      fencingToken: first.fencing_token,
    }, { db: pool });
    const second = await leaseService.acquireLease({
      workspaceId,
      ownerInstanceId: "finalizer-next",
      ownerOperationId: "finalize-next",
      mode: "FINALIZE_EXCLUSIVE",
      ttlMs: 30_000,
    }, { db: pool });
    assert.ok(Number(second.fencing_token) > Number(first.fencing_token));
    await assert.rejects(
      leaseService.heartbeatLease({
        leaseId: first.lease_id,
        ownerInstanceId: first.lease_owner_instance_id,
        ownerOperationId: first.lease_owner_operation_id,
        fencingToken: first.fencing_token,
        ttlMs: 30_000,
      }, { db: pool }),
      /heartbeat rejected/
    );
    await leaseService.releaseLease({
      leaseId: second.lease_id,
      ownerInstanceId: second.lease_owner_instance_id,
      ownerOperationId: second.lease_owner_operation_id,
      fencingToken: second.fencing_token,
    }, { db: pool });
  });

  test("approval resolution and finalization require the exact immutable artifact binding", async () => {
    const taskId = "TASK-PHASE16-BINDING";
    const workspaceId = "canonical:phase16-binding";
    await createTask(taskId);
    const artifactId = "artifact-phase16-binding";
    const base = "1".repeat(40);
    const candidate = "2".repeat(40);
    await pool.query(
      `INSERT INTO artifacts(
         id, task_id, workspace_id, artifact_type, artifact_hash, diff_hash,
         context_manifest_hash, base_commit_sha, candidate_commit_sha,
         manifest_json, file_manifest_json, created_by
       ) VALUES ($1, $2, $3, 'CANDIDATE_COMMIT', $4, $5, $6, $7, $8, '{}'::jsonb, '[]'::jsonb, 'builder')`,
      [artifactId, taskId, workspaceId, HASH_A, HASH_B, HASH_B, base, candidate]
    );
    const lease = await leaseService.acquireLease({
      workspaceId,
      ownerInstanceId: "release-manager",
      ownerTaskId: taskId,
      ownerOperationId: "finalize-binding",
      mode: "FINALIZE_EXCLUSIVE",
      ttlMs: 30_000,
    }, { db: pool });
    await assert.rejects(
      approvalService.openBoundApproval({
        taskId,
        requestedBy: "builder",
        artifactId,
        artifactHash: HASH_B,
        contextManifestHash: HASH_B,
        baseCommitSha: base,
        candidateCommitSha: candidate,
        workspaceId,
        leaseOwnerOperationId: lease.lease_owner_operation_id,
        fencingToken: lease.fencing_token,
        delegationScope: {
          allowedActorIds: ["release-manager"],
          allowedTargetRefs: ["refs/heads/main"],
        },
        expectedTaskState: "READY_FOR_COMMIT",
        expectedTaskVersion: 0,
        expiresAt: new Date(Date.now() + 60_000),
      }, { db: pool }),
      /was not created/
    );
    const approval = await approvalService.openBoundApproval({
      taskId,
      requestedBy: "builder",
      artifactId,
      artifactHash: HASH_A,
      contextManifestHash: HASH_B,
      baseCommitSha: base,
      candidateCommitSha: candidate,
      workspaceId,
      leaseOwnerOperationId: lease.lease_owner_operation_id,
      fencingToken: lease.fencing_token,
      delegationScope: {
        allowedActorIds: ["release-manager"],
        allowedTargetRefs: ["refs/heads/main"],
      },
      expectedTaskState: "READY_FOR_COMMIT",
      expectedTaskVersion: 0,
      expiresAt: new Date(Date.now() + 60_000),
    }, { db: pool });
    await assert.rejects(
      approvalService.resolveBoundApproval({
        approvalId: approval.id,
        artifactId,
        artifactHash: HASH_B,
        contextManifestHash: HASH_B,
        baseCommitSha: base,
        candidateCommitSha: candidate,
        approved: true,
        resolvedBy: "reviewer",
      }, { db: pool }),
      /binding changed/
    );
    await assert.rejects(
      approvalService.resolveBoundApproval({
        approvalId: approval.id,
        artifactId,
        artifactHash: HASH_A,
        contextManifestHash: HASH_B,
        baseCommitSha: base,
        candidateCommitSha: candidate,
        approved: true,
        resolvedBy: "builder",
      }, { db: pool }),
      /binding changed/
    );
    const approved = await approvalService.resolveBoundApproval({
      approvalId: approval.id,
      artifactId,
      artifactHash: HASH_A,
      contextManifestHash: HASH_B,
      baseCommitSha: base,
      candidateCommitSha: candidate,
      approved: true,
      resolvedBy: "reviewer",
    }, { db: pool });
    assert.equal(approved.status, "APPROVED");
    await pool.query(`UPDATE tasks SET row_version = row_version + 1 WHERE id = $1`, [taskId]);
    await assert.rejects(
      finalizerService.claimFinalization({
        finalizationId: "finalization-wrong-task-version",
        approvalId: approval.id,
        artifactId,
        workspaceId,
        leaseId: lease.lease_id,
        ownerOperationId: lease.lease_owner_operation_id,
        fencingToken: lease.fencing_token,
        baseCommitSha: base,
        candidateCommitSha: candidate,
        artifactHash: HASH_A,
        contextManifestHash: HASH_B,
        targetRef: "refs/heads/main",
        actorId: "release-manager",
      }, { db: pool }),
      /task state or version does not match/
    );
    await pool.query(`UPDATE tasks SET row_version = 0 WHERE id = $1`, [taskId]);
    await assert.rejects(
      finalizerService.claimFinalization({
        finalizationId: "finalization-unauthorized-actor",
        approvalId: approval.id,
        artifactId,
        workspaceId,
        leaseId: lease.lease_id,
        ownerOperationId: lease.lease_owner_operation_id,
        fencingToken: lease.fencing_token,
        baseCommitSha: base,
        candidateCommitSha: candidate,
        artifactHash: HASH_A,
        contextManifestHash: HASH_B,
        targetRef: "refs/heads/main",
        actorId: "not-delegated",
      }, { db: pool }),
      /outside the approval delegation scope/
    );
    await assert.rejects(
      finalizerService.claimFinalization({
        finalizationId: "finalization-wrong-context",
        approvalId: approval.id,
        artifactId,
        workspaceId,
        leaseId: lease.lease_id,
        ownerOperationId: lease.lease_owner_operation_id,
        fencingToken: lease.fencing_token,
        baseCommitSha: base,
        candidateCommitSha: candidate,
        artifactHash: HASH_A,
        contextManifestHash: `sha256:${"c".repeat(64)}`,
        targetRef: "refs/heads/main",
        actorId: "release-manager",
      }, { db: pool }),
      /binding does not match/
    );
    const claims = await Promise.allSettled([
      finalizerService.claimFinalization({
        finalizationId: "finalization-binding-a",
        approvalId: approval.id,
        artifactId,
        workspaceId,
        leaseId: lease.lease_id,
        ownerOperationId: lease.lease_owner_operation_id,
        fencingToken: lease.fencing_token,
        baseCommitSha: base,
        candidateCommitSha: candidate,
        artifactHash: HASH_A,
        contextManifestHash: HASH_B,
        targetRef: "refs/heads/main",
        actorId: "release-manager",
      }, { db: pool }),
      finalizerService.claimFinalization({
        finalizationId: "finalization-binding-b",
        approvalId: approval.id,
        artifactId,
        workspaceId,
        leaseId: lease.lease_id,
        ownerOperationId: lease.lease_owner_operation_id,
        fencingToken: lease.fencing_token,
        baseCommitSha: base,
        candidateCommitSha: candidate,
        artifactHash: HASH_A,
        contextManifestHash: HASH_B,
        targetRef: "refs/heads/main",
        actorId: "release-manager",
      }, { db: pool }),
    ]);
    assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
    const claim = claims.find((entry) => entry.status === "fulfilled").value;
    await assert.rejects(
      pool.query(
        `INSERT INTO artifacts(
           id, task_id, workspace_id, artifact_type, artifact_hash, diff_hash,
           context_manifest_hash, base_commit_sha, candidate_commit_sha,
           manifest_json, file_manifest_json, created_by
         ) VALUES ('artifact-phase16-superseding', $1, $2, 'CANDIDATE_COMMIT', $3, $4, $4,
                   $5, $6, '{}'::jsonb, '[]'::jsonb, 'builder')`,
        [taskId, workspaceId, HASH_B, HASH_A, base, "3".repeat(40)]
      ),
      /cannot supersede an active finalization claim/
    );
    await leaseService.releaseLease({
      leaseId: lease.lease_id,
      ownerInstanceId: lease.lease_owner_instance_id,
      ownerOperationId: lease.lease_owner_operation_id,
      fencingToken: lease.fencing_token,
    }, { db: pool });
    await assert.rejects(
      finalizerService.completeFinalization({
        finalizationId: claim.id,
        claimToken: claim.claim_token,
        status: "SUCCEEDED",
        integratedCommitSha: candidate,
        actorId: "release-manager",
      }, { db: pool }),
      /fence is no longer valid/
    );
    const reconciled = await finalizerService.completeFinalization({
      finalizationId: claim.id,
      claimToken: claim.claim_token,
      status: "NEEDS_RECONCILIATION",
      integratedCommitSha: null,
      errorMessage: "lease lost during test",
      actorId: "release-manager",
    }, { db: pool });
    assert.equal(reconciled.status, "NEEDS_RECONCILIATION");
    await assert.rejects(pool.query("UPDATE artifacts SET created_by = 'tamper' WHERE id = $1", [artifactId]), /immutable/);
    await assert.rejects(pool.query("DELETE FROM artifacts WHERE id = $1", [artifactId]), /immutable/);
  });

  test("bare-repository finalizer imports and atomically advances only the approved commit", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "phase16-source-"));
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "phase16-bare-"));
    const candidateRepository = fs.mkdtempSync(path.join(os.tmpdir(), "phase16-candidate-"));
    temporaryPaths.push(source, bare, candidateRepository);
    git(source, "init", "--quiet");
    git(source, "config", "user.name", "Phase 16 DB Test");
    git(source, "config", "user.email", "phase16-db@example.invalid");
    fs.writeFileSync(path.join(source, "artifact.txt"), "base\n");
    git(source, "add", "artifact.txt");
    git(source, "commit", "--quiet", "-m", "base");
    const base = git(source, "rev-parse", "HEAD");
    execFileSync("git", ["init", "--bare", "--quiet", bare]);
    git(source, "push", "--quiet", bare, `HEAD:refs/heads/main`);
    fs.rmSync(candidateRepository, { recursive: true, force: true });
    execFileSync("git", ["clone", "--quiet", source, candidateRepository]);
    git(candidateRepository, "config", "user.name", "Phase 16 Candidate");
    git(candidateRepository, "config", "user.email", "candidate@example.invalid");
    fs.writeFileSync(path.join(candidateRepository, "artifact.txt"), "candidate\n");
    git(candidateRepository, "add", "artifact.txt");
    git(candidateRepository, "commit", "--quiet", "-m", "candidate");
    const candidate = git(candidateRepository, "rev-parse", "HEAD");

    const taskId = "TASK-PHASE16-FINALIZER";
    const workspaceId = "canonical:phase16-finalizer";
    await createTask(taskId);
    const candidateArtifact = artifactService.buildCandidateArtifact({
      repositoryRoot: candidateRepository,
      taskId,
      baseCommitSha: base,
      candidateCommitSha: candidate,
      contextManifestHash: HASH_B,
    });
    const artifact = await artifactService.storeCandidateArtifact({
      artifactId: "artifact-phase16-finalizer",
      taskId,
      workspaceId,
      isolatedWorkspaceId: null,
      createdBy: "builder",
      candidateArtifact,
    }, { db: pool });
    const lease = await leaseService.acquireLease({
      workspaceId,
      ownerInstanceId: "release-manager",
      ownerTaskId: taskId,
      ownerOperationId: "finalize-real-git",
      mode: "FINALIZE_EXCLUSIVE",
      ttlMs: 30_000,
    }, { db: pool });
    const approval = await approvalService.openBoundApproval({
      taskId,
      requestedBy: "builder",
      artifactId: artifact.id,
      artifactHash: artifact.artifact_hash,
      contextManifestHash: artifact.context_manifest_hash,
      baseCommitSha: artifact.base_commit_sha,
      candidateCommitSha: artifact.candidate_commit_sha,
      workspaceId,
      leaseOwnerOperationId: lease.lease_owner_operation_id,
      fencingToken: lease.fencing_token,
      delegationScope: {
        allowedActorIds: ["release-manager"],
        allowedTargetRefs: ["refs/heads/main"],
      },
      expectedTaskState: "READY_FOR_COMMIT",
      expectedTaskVersion: 0,
      expiresAt: new Date(Date.now() + 60_000),
    }, { db: pool });
    const approved = await approvalService.resolveBoundApproval({
      approvalId: approval.id,
      artifactId: artifact.id,
      artifactHash: artifact.artifact_hash,
      contextManifestHash: artifact.context_manifest_hash,
      baseCommitSha: artifact.base_commit_sha,
      candidateCommitSha: artifact.candidate_commit_sha,
      approved: true,
      resolvedBy: "reviewer",
    }, { db: pool });
    const result = await finalizerService.finalizeCandidate({
      approval: approved,
      artifact,
      finalizerLease: lease,
      ownerOperationId: lease.lease_owner_operation_id,
      actorId: "release-manager",
      candidateRepository,
      canonicalRepository: bare,
      targetRef: "refs/heads/main",
    }, {
      db: pool,
      env: { ISOLATED_WORKSPACE_MODE: "true", CODER_WRITE_ENABLED: "true" },
    });
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(git(bare, "rev-parse", "refs/heads/main"), candidate);
  });

  test("task control records cancel intent before kill and reconciles dead owners", async () => {
    const hostId = hostIdentity.getHostId();
    const taskId = "TASK-PHASE16-CONTROL";
    await createTask(taskId, "CODING");
    await pool.query(
      `UPDATE tasks SET current_pid = 4242, current_host_id = $2, current_owner_instance_id = 'builder-1'
       WHERE id = $1`,
      [taskId, hostId]
    );
    const calls = [];
    const processApi = {
      pauseProcessTree(input) { calls.push(["pause", input]); return { target: input.pid, usedProcessGroup: false }; },
      resumeProcessTree(input) { calls.push(["resume", input]); return { target: input.pid, usedProcessGroup: false }; },
      async killProcessTree(input) {
        const state = await pool.query(`SELECT control_state FROM tasks WHERE id = $1`, [taskId]);
        assert.equal(state.rows[0].control_state, "CANCEL_REQUESTED");
        calls.push(["kill", input]);
        return { pid: input.pid, sigtermSent: true, sigkillSent: false };
      },
      isProcessAlive() { return false; },
      isProcessGroupAlive() { return false; },
    };
    const paused = await taskControlService.pauseTaskProcess({
      taskId,
      expectedVersion: 0,
      ownerInstanceId: "builder-1",
    }, { db: pool, processApi });
    assert.equal(paused.control_state, "PAUSED");
    assert.equal(paused.paused_from_status, "CODING");
    const resumed = await taskControlService.resumeTaskProcess({
      taskId,
      expectedVersion: 1,
      ownerInstanceId: "builder-1",
    }, { db: pool, processApi });
    assert.equal(resumed.control_state, "RUNNING");
    assert.equal(resumed.status, "CODING");
    const killed = await taskControlService.killTaskProcess({
      taskId,
      expectedVersion: 2,
      ownerInstanceId: "builder-1",
      killGraceMs: 1,
    }, { db: pool, processApi });
    assert.equal(killed.task.control_state, "CANCELLED");
    assert.equal(killed.task.current_pid, null);
    assert.deepEqual(calls.map(([name]) => name), ["pause", "resume", "kill"]);
    const events = await pool.query(
      `SELECT event_type FROM workspace_safety_events WHERE task_id = $1 ORDER BY id`,
      [taskId]
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), [
      "TASK_PROCESS_PAUSED",
      "TASK_PROCESS_RESUMED",
      "TASK_CANCEL_REQUESTED",
      "TASK_PROCESS_KILLED",
    ]);

    const orphanId = "TASK-PHASE16-ORPHAN";
    await createTask(orphanId, "CODING");
    await pool.query(
      `UPDATE tasks SET current_pid = 4343, current_host_id = $2, current_owner_instance_id = 'builder-2'
       WHERE id = $1`,
      [orphanId, hostId]
    );
    const reconciled = await taskControlService.reconcileOrphanedTaskProcesses(
      { actorId: "watchdog" },
      { db: pool, processApi, hostId }
    );
    assert.ok(reconciled.some((entry) => entry.taskId === orphanId && entry.action === "NEEDS_RECONCILIATION"));
    const orphan = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [orphanId]);
    assert.equal(orphan.rows[0].control_state, "NEEDS_RECONCILIATION");
    assert.equal(orphan.rows[0].current_pid, null);
  });

  test("orphaned isolated workspace is detected and cleaned without a canonical remote", async () => {
    const canonical = fs.mkdtempSync(path.join(os.tmpdir(), "phase16-workspace-canonical-"));
    const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase16-workspace-root-"));
    temporaryPaths.push(canonical, isolationRoot);
    git(canonical, "init", "--quiet");
    git(canonical, "config", "user.name", "Phase 16 Workspace Test");
    git(canonical, "config", "user.email", "workspace@example.invalid");
    fs.writeFileSync(path.join(canonical, "base.txt"), "canonical\n");
    git(canonical, "add", "base.txt");
    git(canonical, "commit", "--quiet", "-m", "base");
    const base = git(canonical, "rev-parse", "HEAD");
    const taskId = "TASK-PHASE16-WORKSPACE";
    await createTask(taskId, "CODING");
    const created = await isolatedWorkspaceService.createIsolatedWorkspace({
      isolatedWorkspaceId: "iw-phase16-orphan",
      taskId,
      canonicalRepository: canonical,
      baseCommitSha: base,
      ownerInstanceId: "builder-workspace",
      ownerOperationId: "workspace-operation",
      isolationRoot,
      shadowMode: true,
      leaseTtlMs: 30_000,
    }, { db: pool });
    assert.equal(created.workspace.status, "READY");
    assert.equal(git(created.workspace.workspace_path, "remote"), "");
    await pool.query(
      `UPDATE workspace_leases SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE lease_id = $1`,
      [created.lease.lease_id]
    );
    const candidates = await isolatedWorkspaceService.listReconciliationCandidates({ db: pool });
    assert.ok(candidates.some((candidateWorkspace) => candidateWorkspace.id === created.workspace.id));
    const cleaned = await isolatedWorkspaceService.cleanupIsolatedWorkspace({
      isolatedWorkspaceId: created.workspace.id,
      ownerInstanceId: "watchdog",
      ownerOperationId: "watchdog-cleanup",
      force: true,
    }, { db: pool, isolationRoot });
    assert.equal(cleaned.status, "CLEANED");
    assert.equal(fs.existsSync(created.workspace.workspace_path), false);
    assert.equal(git(canonical, "rev-parse", "HEAD"), base);
  });

  test("Phase 16 objects are not granted to PUBLIC", async () => {
    const routines = await pool.query(
      `SELECT routine_name FROM information_schema.routine_privileges
       WHERE routine_schema = 'public' AND grantee = 'PUBLIC' AND privilege_type = 'EXECUTE'
         AND (routine_name LIKE '%workspace_lease%' OR routine_name LIKE '%candidate_finalization%' OR routine_name LIKE 'phase16_%')`
    );
    assert.deepEqual(routines.rows, []);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND grantee = 'PUBLIC'
         AND table_name IN ('workspace_lock_heads', 'workspace_leases', 'isolated_workspaces', 'artifacts', 'workspace_finalizations', 'workspace_safety_events')`
    );
    assert.deepEqual(tables.rows, []);
  });

  test("017 rolls back without removing legacy task and approval data, then reapplies", async () => {
    await migrateDown("017_workspace_safety", { pool, allowDestructive: true });
    migrationApplied = false;
    const boundary = await pool.query(
      `SELECT to_regclass('public.tasks') AS tasks_table,
              to_regclass('public.approvals') AS approvals_table,
              to_regclass('public.workspace_leases') AS leases_table,
              EXISTS(
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'control_state'
              ) AS has_control_state`
    );
    assert.equal(boundary.rows[0].tasks_table, "tasks");
    assert.equal(boundary.rows[0].approvals_table, "approvals");
    assert.equal(boundary.rows[0].leases_table, null);
    assert.equal(boundary.rows[0].has_control_state, false);
    await migrateUp("017_workspace_safety", { pool });
    migrationApplied = true;
    const reapplied = await pool.query(`SELECT to_regclass('public.workspace_leases') AS leases_table`);
    assert.equal(reapplied.rows[0].leases_table, "workspace_leases");
  });
}
