const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { after, before, test } = require("node:test");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const enabled = process.env.PHASE15_DB_TEST === "1";

if (!enabled) {
  test("Phase 15 PostgreSQL integration suite", { skip: "set PHASE15_DB_TEST=1 to run disposable DB tests" }, () => {});
} else {
  dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: false, quiet: true });

  const { migrateDown, migrateUp } = require("../../src/db/migrationRunner");
  const { credentialFingerprint } = require("../../src/delivery/phaseAssignmentPolicy");
  const phaseService = require("../../src/delivery/phaseService");
  const submissionService = require("../../src/delivery/phaseSubmissionService");
  const validationService = require("../../src/delivery/phaseValidationService");
  const findingService = require("../../src/delivery/phaseFindingService");
  const gateService = require("../../src/delivery/phaseGateService");
  const {
    importBootstrapPackage,
    publicKeyFingerprint,
    signVerdictPayload,
  } = require("../../src/delivery/deliveryBootstrapService");
  const { hashCanonicalJson } = require("../../src/delivery/canonicalSubmissionManifest");
  const credentialService = require("../../src/channels/channelCredentialService");

  const baseConnectionString = process.env.PHASE15_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!baseConnectionString) throw new Error("PHASE15_TEST_DATABASE_URL or DATABASE_URL is required");

  const databaseName = `ai_manager_phase15_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g, "_");
  const databaseUrl = new URL(baseConnectionString);
  databaseUrl.pathname = `/${databaseName}`;

  let adminPool;
  let pool;
  let repositoryRoot;
  let repositoryCommits;
  let sequence = 100;

  const HASH_A = `sha256:${"a".repeat(64)}`;
  const HASH_B = `sha256:${"b".repeat(64)}`;
  const HASH_C = `sha256:${"c".repeat(64)}`;

  function manifestFor(phaseId, workerId, round = 1) {
    return {
      schemaVersion: 1,
      phaseId,
      submissionRound: round,
      submittedBy: workerId,
      baseCommitSha: repositoryCommits[0],
      candidateCommitSha: repositoryCommits[Math.min(round, repositoryCommits.length - 1)],
      files: [{ path: `src/phase-${round}.js`, sha256: HASH_A, mode: "100644", type: "file" }],
      migrationArtifacts: [{ path: "src/db/migrations/015_delivery_governance.up.sql", sha256: HASH_B, mode: "100644", type: "file" }],
      testEvidence: [{ id: `db-test-${round}`, sha256: HASH_C }],
      requirementsTraceHash: HASH_A,
      rollbackPlanHash: HASH_B,
      knownIssuesHash: HASH_C,
    };
  }

  async function phaseVersion(phaseId) {
    const { rows } = await pool.query("SELECT row_version FROM delivery_phases WHERE id = $1", [phaseId]);
    return rows[0].row_version;
  }

  async function seedPhase(label = "test", { dependencies = [], start = true } = {}) {
    sequence += 1;
    const suffix = `${label}-${sequence}`;
    const phaseId = `phase-${suffix}`;
    const actors = {
      WORKER: `worker-${suffix}`,
      PLANNING_VALIDATOR: `planning-${suffix}`,
      DEVELOPMENT_VALIDATOR: `development-${suffix}`,
      GATE_ADMIN: `gate-${suffix}`,
    };
    const credentials = Object.fromEntries(
      Object.entries(actors).map(([role, actorId]) => [role, credentialFingerprint(`${actorId}-credential`)])
    );
    for (const [role, actorId] of Object.entries(actors)) {
      await phaseService.registerActor(
        {
          id: actorId,
          actorType: role.includes("VALIDATOR") ? "HUMAN" : "SERVICE",
          displayName: actorId,
          credentialBinding: credentials[role],
        },
        { db: pool }
      );
    }
    await phaseService.createPhase(
      { id: phaseId, name: `Phase ${suffix}`, sequenceNo: sequence, dependencies },
      { db: pool }
    );
    for (const [assignmentRole, actorId] of Object.entries(actors)) {
      await phaseService.assignActor(
        { phaseId, actorId, assignmentRole, assignedByActorId: actors.GATE_ADMIN },
        { db: pool }
      );
    }
    if (start) {
      await phaseService.startPhase(
        {
          phaseId,
          actorId: actors.GATE_ADMIN,
          credentialBinding: credentials.GATE_ADMIN,
          expectedVersion: 0,
        },
        { db: pool }
      );
    }
    return { phaseId, actors, credentials };
  }

  async function sealFirstSubmission(seed) {
    return submissionService.sealSubmission(
      {
        submissionId: `ps-${seed.phaseId}-1`,
        phaseId: seed.phaseId,
        submissionRound: 1,
        manifest: manifestFor(seed.phaseId, seed.actors.WORKER, 1),
        actorId: seed.actors.WORKER,
        credentialBinding: seed.credentials.WORKER,
        expectedVersion: await phaseVersion(seed.phaseId),
      },
      { db: pool, repositoryRoot }
    );
  }

  async function validate(seed, submissionId, validatorType, verdict = "APPROVED", findings = [], attempt = 1) {
    const role = validatorType === "PLANNING" ? "PLANNING_VALIDATOR" : "DEVELOPMENT_VALIDATOR";
    const validationId = `pv-${submissionId}-${validatorType.toLowerCase()}-${attempt}`;
    await validationService.startValidation(
      {
        validationId,
        phaseSubmissionId: submissionId,
        validatorType,
        validationAttempt: attempt,
        actorId: seed.actors[role],
        credentialBinding: seed.credentials[role],
      },
      { db: pool, repositoryRoot }
    );
    return validationService.completeValidation(
      {
        validationId,
        verdict,
        evidence: [`evidence-${validatorType.toLowerCase()}-${attempt}`],
        findings,
        actorId: seed.actors[role],
        credentialBinding: seed.credentials[role],
      },
      { db: pool }
    );
  }

  before(async () => {
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase15-db-git-"));
    const runGit = (...args) => execFileSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" }).trim();
    runGit("init", "--quiet");
    runGit("config", "user.name", "Phase 15 DB Test");
    runGit("config", "user.email", "phase15-db@example.invalid");
    repositoryCommits = [];
    for (const content of ["base\n", "candidate-1\n", "candidate-2\n"]) {
      fs.writeFileSync(path.join(repositoryRoot, "artifact.txt"), content);
      runGit("add", "artifact.txt");
      runGit("commit", "--quiet", "-m", `commit-${repositoryCommits.length}`);
      repositoryCommits.push(runGit("rev-parse", "HEAD"));
    }
    adminPool = new Pool({ connectionString: baseConnectionString });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 30 });
    await migrateUp("015_delivery_governance", { pool });
    await migrateUp("015_delivery_governance_security", { pool });
    await migrateUp("015_delivery_governance_rework", { pool });
    await migrateUp("015_delivery_governance_operations", { pool });
    await migrateUp("016_channel_credentials", { pool });
    process.env.CHANNEL_TOKEN_MASTER_KEY = crypto.randomBytes(32).toString("base64");
  });

  after(async () => {
    if (pool) {
      await migrateDown("016_channel_credentials", { pool, allowDestructive: true });
      await migrateDown("015_delivery_governance_operations", { pool, allowDestructive: true });
      await migrateDown("015_delivery_governance_rework", { pool, allowDestructive: true });
      await migrateDown("015_delivery_governance_security", { pool, allowDestructive: true });
      await migrateDown("015_delivery_governance", { pool, allowDestructive: true });
      const { rows } = await pool.query(
        `SELECT to_regclass('public.delivery_phases') AS delivery_table,
                to_regclass('public.channel_credentials') AS channel_table`
      );
      assert.equal(rows[0].delivery_table, null);
      assert.equal(rows[0].channel_table, null);
      const ledger = await pool.query(
        `SELECT id FROM schema_migrations
         WHERE id LIKE '015_delivery_governance%' OR id = '016_channel_credentials'`
      );
      assert.deepEqual(ledger.rows, []);
      await pool.end();
    }
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
    if (repositoryRoot) fs.rmSync(repositoryRoot, { recursive: true, force: true });
  });

  test("governance functions, tables, and sequences are not exposed to PUBLIC", async () => {
    const { rows: routines } = await pool.query(
      `SELECT routine_name
       FROM information_schema.routine_privileges
       WHERE routine_schema = 'public'
         AND grantee = 'PUBLIC'
         AND privilege_type = 'EXECUTE'
         AND (
           routine_name LIKE 'phase15_%'
           OR routine_name LIKE '%delivery_phase%'
           OR routine_name LIKE '%phase_validation%'
           OR routine_name LIKE '%phase_debt%'
           OR routine_name = 'seal_phase_submission'
         )`
    );
    assert.deepEqual(routines, []);
    const { rows: tables } = await pool.query(
      `SELECT table_name
       FROM information_schema.table_privileges
       WHERE table_schema = 'public'
         AND grantee = 'PUBLIC'
         AND (table_name LIKE 'delivery_%' OR table_name LIKE 'phase_%')`
    );
    assert.deepEqual(tables, []);
    const { rows: sequences } = await pool.query(
      `SELECT object_name
       FROM information_schema.usage_privileges
       WHERE object_schema = 'public'
         AND object_type = 'SEQUENCE'
         AND grantee = 'PUBLIC'
         AND (object_name LIKE 'delivery_%' OR object_name LIKE 'phase_%')`
    );
    assert.deepEqual(sequences, []);
  });

  test("channel credential revoke and rotation lifecycle works against PostgreSQL", async () => {
    const channelType = `discord-${process.pid}`;
    const botInstanceId = `integration-${Date.now()}`;
    await credentialService.storeToken({ channelType, botInstanceId, token: "integration-token-v1" }, { db: pool });
    assert.equal(await credentialService.getToken({ channelType, botInstanceId }, { db: pool }), "integration-token-v1");
    const revoked = await credentialService.revokeToken({
      channelType,
      botInstanceId,
      reason: "integration-test",
    }, { db: pool });
    assert.equal(revoked.status, "REVOKED");
    assert.equal(await credentialService.getToken({ channelType, botInstanceId }, { db: pool }), null);
    await credentialService.storeToken({ channelType, botInstanceId, token: "integration-token-v2" }, { db: pool });
    assert.equal(await credentialService.getToken({ channelType, botInstanceId }, { db: pool }), "integration-token-v2");
  });

  test("governance rollback can explicitly preserve channel credentials for the retained runtime", async () => {
    const preserveName = `ai_manager_phase15_preserve_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g, "_");
    const preserveUrl = new URL(baseConnectionString);
    preserveUrl.pathname = `/${preserveName}`;
    let preservePool;
    try {
      await adminPool.query(`CREATE DATABASE "${preserveName}"`);
      preservePool = new Pool({ connectionString: preserveUrl.toString() });
      for (const id of [
        "015_delivery_governance",
        "015_delivery_governance_security",
        "015_delivery_governance_rework",
        "015_delivery_governance_operations",
        "016_channel_credentials",
      ]) {
        await migrateUp(id, { pool: preservePool });
      }
      await credentialService.storeToken(
        { channelType: "discord", botInstanceId: "preserved-role", token: "preserved-test-token" },
        { db: preservePool }
      );
      for (const id of [
        "015_delivery_governance_operations",
        "015_delivery_governance_rework",
        "015_delivery_governance_security",
        "015_delivery_governance",
      ]) {
        await migrateDown(id, { pool: preservePool, allowDestructive: true });
      }
      const boundary = await preservePool.query(
        `SELECT to_regclass('public.delivery_phases') AS delivery_table,
                to_regclass('public.channel_credentials') AS channel_table,
                EXISTS(SELECT 1 FROM schema_migrations WHERE id = '016_channel_credentials') AS channel_applied`
      );
      assert.equal(boundary.rows[0].delivery_table, null);
      assert.equal(boundary.rows[0].channel_table, "channel_credentials");
      assert.equal(boundary.rows[0].channel_applied, true);
      assert.equal(
        await credentialService.getToken(
          { channelType: "discord", botInstanceId: "preserved-role" },
          { db: preservePool }
        ),
        "preserved-test-token"
      );
      await migrateDown("016_channel_credentials", { pool: preservePool, allowDestructive: true });
    } finally {
      if (preservePool) await preservePool.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${preserveName}" WITH (FORCE)`);
    }
  });

  test("database rejects self-validation assignments", async () => {
    sequence += 1;
    const phaseId = `phase-separation-${sequence}`;
    const actorId = `actor-separation-${sequence}`;
    await phaseService.registerActor(
      {
        id: actorId,
        actorType: "HUMAN",
        displayName: actorId,
        credentialBinding: credentialFingerprint(actorId),
      },
      { db: pool, repositoryRoot }
    );
    await phaseService.createPhase({ id: phaseId, name: phaseId, sequenceNo: sequence }, { db: pool });
    await phaseService.assignActor({ phaseId, actorId, assignmentRole: "WORKER" }, { db: pool });
    await assert.rejects(
      phaseService.assignActor({ phaseId, actorId, assignmentRole: "PLANNING_VALIDATOR" }, { db: pool }),
      /cannot hold both/
    );
  });

  test("concurrent assignments cannot give one actor two active roles", async () => {
    sequence += 1;
    const phaseId = `phase-assignment-race-${sequence}`;
    const actorId = `actor-assignment-race-${sequence}`;
    await phaseService.registerActor(
      {
        id: actorId,
        actorType: "HUMAN",
        displayName: actorId,
        credentialBinding: credentialFingerprint(actorId),
      },
      { db: pool }
    );
    await phaseService.createPhase({ id: phaseId, name: phaseId, sequenceNo: sequence }, { db: pool });
    const attempts = await Promise.allSettled([
      phaseService.assignActor({ phaseId, actorId, assignmentRole: "PLANNING_VALIDATOR" }, { db: pool }),
      phaseService.assignActor({ phaseId, actorId, assignmentRole: "DEVELOPMENT_VALIDATOR" }, { db: pool }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM phase_assignments
       WHERE phase_id = $1 AND actor_id = $2 AND revoked_at IS NULL`,
      [phaseId, actorId]
    );
    assert.equal(rows[0].count, 1);
  });

  test("sealed submissions, terminal validations, and gate events are immutable", async () => {
    const seed = await seedPhase("immutable");
    const sealed = await sealFirstSubmission(seed);
    await assert.rejects(
      pool.query("UPDATE phase_submissions SET candidate_commit_sha = 'tampered' WHERE id = $1", [sealed.submission.id]),
      /immutable/
    );
    await assert.rejects(
      pool.query("DELETE FROM phase_submissions WHERE id = $1", [sealed.submission.id]),
      /immutable/
    );
    const validation = await validate(seed, sealed.submission.id, "PLANNING");
    await assert.rejects(
      pool.query("UPDATE phase_validations SET verdict = 'BLOCKED' WHERE id = $1", [validation.id]),
      /immutable/
    );
    await assert.rejects(
      pool.query("DELETE FROM phase_validations WHERE id = $1", [validation.id]),
      /immutable/
    );
    const { rows: events } = await pool.query(
      "SELECT id FROM phase_gate_events WHERE phase_id = $1 ORDER BY id LIMIT 1",
      [seed.phaseId]
    );
    await assert.rejects(
      pool.query("UPDATE phase_gate_events SET event_type = 'TAMPERED' WHERE id = $1", [events[0].id]),
      /append-only/
    );
    await assert.rejects(
      pool.query("DELETE FROM phase_gate_events WHERE id = $1", [events[0].id]),
      /append-only/
    );

    const inProgressId = `pv-${seed.phaseId}-development-disposable`;
    await validationService.startValidation(
      {
        validationId: inProgressId,
        phaseSubmissionId: sealed.submission.id,
        validatorType: "DEVELOPMENT",
        validationAttempt: 1,
        actorId: seed.actors.DEVELOPMENT_VALIDATOR,
        credentialBinding: seed.credentials.DEVELOPMENT_VALIDATOR,
      },
      { db: pool }
    );
    const deleted = await pool.query("DELETE FROM phase_validations WHERE id = $1", [inProgressId]);
    assert.equal(deleted.rowCount, 1);
  });

  test("validation retries require failed infrastructure and cannot overlap or replace a verdict", async () => {
    const seed = await seedPhase("attempt-policy");
    const sealed = await sealFirstSubmission(seed);
    const firstId = `pv-${seed.phaseId}-planning-1`;
    await validationService.startValidation(
      {
        validationId: firstId,
        phaseSubmissionId: sealed.submission.id,
        validatorType: "PLANNING",
        validationAttempt: 1,
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    await assert.rejects(
      validationService.startValidation(
        {
          validationId: `pv-${seed.phaseId}-planning-overlap`,
          phaseSubmissionId: sealed.submission.id,
          validatorType: "PLANNING",
          validationAttempt: 2,
          actorId: seed.actors.PLANNING_VALIDATOR,
          credentialBinding: seed.credentials.PLANNING_VALIDATOR,
        },
        { db: pool }
      ),
      /previous attempt to be INFRA_FAILED or CANCELLED/
    );
    await validationService.failValidationAttempt(
      {
        validationId: firstId,
        terminalStatus: "INFRA_FAILED",
        evidence: ["runner-failed"],
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    const secondId = `pv-${seed.phaseId}-planning-2`;
    await validationService.startValidation(
      {
        validationId: secondId,
        phaseSubmissionId: sealed.submission.id,
        validatorType: "PLANNING",
        validationAttempt: 2,
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    await validationService.completeValidation(
      {
        validationId: secondId,
        verdict: "APPROVED",
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    await assert.rejects(
      validationService.startValidation(
        {
          validationId: `pv-${seed.phaseId}-planning-after-verdict`,
          phaseSubmissionId: sealed.submission.id,
          validatorType: "PLANNING",
          validationAttempt: 3,
          actorId: seed.actors.PLANNING_VALIDATOR,
          credentialBinding: seed.credentials.PLANNING_VALIDATOR,
        },
        { db: pool }
      ),
      /previous attempt to be INFRA_FAILED or CANCELLED/
    );
  });

  test("submission worker remains forbidden after assignment revocation and role change", async () => {
    const seed = await seedPhase("worker-snapshot");
    const sealed = await sealFirstSubmission(seed);
    await validate(seed, sealed.submission.id, "PLANNING");
    const replacementWorker = `replacement-${seed.phaseId}`;
    await phaseService.registerActor(
      {
        id: replacementWorker,
        actorType: "AGENT",
        displayName: replacementWorker,
        credentialBinding: credentialFingerprint(`${replacementWorker}-credential`),
      },
      { db: pool }
    );
    await phaseService.replaceAssignment(
      {
        phaseId: seed.phaseId,
        assignmentRole: "WORKER",
        newActorId: replacementWorker,
        reason: "worker rotation test",
        actorId: seed.actors.GATE_ADMIN,
        credentialBinding: seed.credentials.GATE_ADMIN,
        expectedVersion: await phaseVersion(seed.phaseId),
      },
      { db: pool }
    );
    await phaseService.replaceAssignment(
      {
        phaseId: seed.phaseId,
        assignmentRole: "DEVELOPMENT_VALIDATOR",
        newActorId: seed.actors.WORKER,
        reason: "validator rotation test",
        actorId: seed.actors.GATE_ADMIN,
        credentialBinding: seed.credentials.GATE_ADMIN,
        expectedVersion: await phaseVersion(seed.phaseId),
      },
      { db: pool }
    );
    await assert.rejects(
      validationService.startValidation(
        {
          validationId: `pv-${seed.phaseId}-worker-development`,
          phaseSubmissionId: sealed.submission.id,
          validatorType: "DEVELOPMENT",
          validationAttempt: 1,
          actorId: seed.actors.WORKER,
          credentialBinding: seed.credentials.WORKER,
        },
        { db: pool }
      ),
      /cannot validate its own submission/
    );

    await pool.query(
      `INSERT INTO phase_validations(
         id, phase_submission_id, validator_type, validation_attempt, attempt_status,
         verdict, artifact_bundle_hash, validated_by_actor_id, completed_at
       ) VALUES ($1, $2, 'DEVELOPMENT', 1, 'COMPLETED', 'APPROVED', $3, $4, CURRENT_TIMESTAMP)`,
      [`pv-${seed.phaseId}-forced-worker`, sealed.submission.id, sealed.artifactBundleHash, seed.actors.WORKER]
    );
    await assert.rejects(
      gateService.gatePhase(
        {
          phaseId: seed.phaseId,
          actorId: seed.actors.GATE_ADMIN,
          credentialBinding: seed.credentials.GATE_ADMIN,
          expectedVersion: await phaseVersion(seed.phaseId),
        },
        { db: pool }
      ),
      /worker cannot validate its own submission/
    );
  });

  test("BLOCKED verdict keeps precedence over a later CHANGES_REQUESTED verdict", async () => {
    const seed = await seedPhase("blocked-precedence");
    const sealed = await sealFirstSubmission(seed);
    await validate(seed, sealed.submission.id, "PLANNING", "BLOCKED");
    await validate(seed, sealed.submission.id, "DEVELOPMENT", "CHANGES_REQUESTED");
    const status = await phaseService.getPhaseStatus(seed.phaseId, { db: pool });
    assert.equal(status.phase.status, "BLOCKED");
    const rework = await phaseService.startRework(
      {
        phaseId: seed.phaseId,
        actorId: seed.actors.WORKER,
        credentialBinding: seed.credentials.WORKER,
        expectedVersion: status.phase.row_version,
      },
      { db: pool }
    );
    assert.equal(rework.status, "REWORK_IN_PROGRESS");
  });

  test("unassigned actors and cross-actor verdict completion are rejected", async () => {
    const seed = await seedPhase("credential-boundary");
    const sealed = await sealFirstSubmission(seed);
    const validationId = `pv-${seed.phaseId}-planning-1`;
    await validationService.startValidation(
      {
        validationId,
        phaseSubmissionId: sealed.submission.id,
        validatorType: "PLANNING",
        validationAttempt: 1,
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    await assert.rejects(
      validationService.completeValidation(
        {
          validationId,
          verdict: "APPROVED",
          actorId: seed.actors.DEVELOPMENT_VALIDATOR,
          credentialBinding: seed.credentials.DEVELOPMENT_VALIDATOR,
        },
        { db: pool }
      ),
      /belongs to a different actor/
    );
    await assert.rejects(
      validationService.startValidation(
        {
          validationId: `pv-${seed.phaseId}-unassigned`,
          phaseSubmissionId: sealed.submission.id,
          validatorType: "DEVELOPMENT",
          validationAttempt: 1,
          actorId: seed.actors.PLANNING_VALIDATOR,
          credentialBinding: seed.credentials.PLANNING_VALIDATOR,
        },
        { db: pool }
      ),
      /not authorized as DEVELOPMENT_VALIDATOR/
    );
  });

  test("validation infrastructure failure creates a new attempt without overwriting terminal evidence", async () => {
    const seed = await seedPhase("retry");
    const sealed = await sealFirstSubmission(seed);
    const firstId = `pv-${seed.phaseId}-planning-1`;
    await validationService.startValidation(
      {
        validationId: firstId,
        phaseSubmissionId: sealed.submission.id,
        validatorType: "PLANNING",
        validationAttempt: 1,
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    await validationService.failValidationAttempt(
      {
        validationId: firstId,
        terminalStatus: "INFRA_FAILED",
        evidence: ["runner-disconnected"],
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    await validationService.startValidation(
      {
        validationId: `pv-${seed.phaseId}-planning-2`,
        phaseSubmissionId: sealed.submission.id,
        validatorType: "PLANNING",
        validationAttempt: 2,
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    const { rows } = await pool.query(
      `SELECT validation_attempt, attempt_status
       FROM phase_validations
       WHERE phase_submission_id = $1 AND validator_type = 'PLANNING'
       ORDER BY validation_attempt`,
      [sealed.submission.id]
    );
    assert.deepEqual(rows, [
      { validation_attempt: 1, attempt_status: "INFRA_FAILED" },
      { validation_attempt: 2, attempt_status: "IN_PROGRESS" },
    ]);
  });

  test("late verdict for a superseded submission is STALE_ON_ARRIVAL", async () => {
    const seed = await seedPhase("stale");
    const first = await sealFirstSubmission(seed);
    const developmentValidationId = `pv-${seed.phaseId}-development-late`;
    await validationService.startValidation(
      {
        validationId: developmentValidationId,
        phaseSubmissionId: first.submission.id,
        validatorType: "DEVELOPMENT",
        validationAttempt: 1,
        actorId: seed.actors.DEVELOPMENT_VALIDATOR,
        credentialBinding: seed.credentials.DEVELOPMENT_VALIDATOR,
      },
      { db: pool }
    );
    await validate(
      seed,
      first.submission.id,
      "PLANNING",
      "CHANGES_REQUESTED",
      [{ findingKey: "plan-1", severity: "MAJOR", category: "REQUIREMENTS", title: "Missing trace", detail: "Trace matrix is incomplete" }]
    );
    await phaseService.startRework(
      {
        phaseId: seed.phaseId,
        actorId: seed.actors.WORKER,
        credentialBinding: seed.credentials.WORKER,
        expectedVersion: await phaseVersion(seed.phaseId),
      },
      { db: pool }
    );
    await submissionService.sealSubmission(
      {
        submissionId: `ps-${seed.phaseId}-2`,
        phaseId: seed.phaseId,
        submissionRound: 2,
        manifest: manifestFor(seed.phaseId, seed.actors.WORKER, 2),
        actorId: seed.actors.WORKER,
        credentialBinding: seed.credentials.WORKER,
        expectedVersion: await phaseVersion(seed.phaseId),
      },
      { db: pool, repositoryRoot }
    );
    const late = await validationService.completeValidation(
      {
        validationId: developmentValidationId,
        verdict: "APPROVED",
        evidence: ["late-evidence"],
        findings: [],
        actorId: seed.actors.DEVELOPMENT_VALIDATOR,
        credentialBinding: seed.credentials.DEVELOPMENT_VALIDATOR,
      },
      { db: pool }
    );
    assert.equal(late.attempt_status, "STALE_ON_ARRIVAL");
  });

  test("twenty concurrent Gate requests accept exactly once", async () => {
    const seed = await seedPhase("gate-race");
    const sealed = await sealFirstSubmission(seed);
    await validate(seed, sealed.submission.id, "PLANNING");
    await validate(seed, sealed.submission.id, "DEVELOPMENT");
    const expectedVersion = await phaseVersion(seed.phaseId);
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => gateService.gatePhase(
        {
          phaseId: seed.phaseId,
          actorId: seed.actors.GATE_ADMIN,
          credentialBinding: seed.credentials.GATE_ADMIN,
          expectedVersion,
        },
        { db: pool }
      ))
    );
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const { rows: events } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM phase_gate_events WHERE phase_id = $1 AND event_type = 'PHASE_ACCEPTED'",
      [seed.phaseId]
    );
    assert.equal(events[0].count, 1);
  });

  test("Gate rejects a latest validation whose artifact hash does not match the sealed submission", async () => {
    const seed = await seedPhase("hash-mismatch");
    const sealed = await sealFirstSubmission(seed);
    await validate(seed, sealed.submission.id, "PLANNING");
    await validate(seed, sealed.submission.id, "DEVELOPMENT");
    await pool.query(
      `INSERT INTO phase_validations(
         id, phase_submission_id, validator_type, validation_attempt, attempt_status,
         verdict, artifact_bundle_hash, validated_by_actor_id, completed_at
       ) VALUES ($1, $2, 'PLANNING', 2, 'COMPLETED', 'APPROVED', $3, $4, CURRENT_TIMESTAMP)`,
      [`pv-${seed.phaseId}-planning-forced-mismatch`, sealed.submission.id, HASH_B, seed.actors.PLANNING_VALIDATOR]
    );
    await assert.rejects(
      gateService.gatePhase(
        {
          phaseId: seed.phaseId,
          actorId: seed.actors.GATE_ADMIN,
          credentialBinding: seed.credentials.GATE_ADMIN,
          expectedVersion: await phaseVersion(seed.phaseId),
        },
        { db: pool }
      ),
      /artifact hash does not match/
    );
  });

  test("Gate rejects open BLOCKER and unapproved MAJOR findings", async () => {
    const blockerSeed = await seedPhase("open-blocker");
    const blockerSubmission = await sealFirstSubmission(blockerSeed);
    const blockerPlanning = await validate(blockerSeed, blockerSubmission.submission.id, "PLANNING");
    await validate(blockerSeed, blockerSubmission.submission.id, "DEVELOPMENT");
    await pool.query(
      `INSERT INTO phase_validation_findings(
         id, phase_validation_id, finding_key, severity, category, title, detail
       ) VALUES ($1, $2, 'forced-blocker', 'BLOCKER', 'SECURITY', 'Forced blocker', 'Gate defense test')`,
      [`finding-${blockerSeed.phaseId}`, blockerPlanning.id]
    );
    await assert.rejects(
      gateService.gatePhase(
        {
          phaseId: blockerSeed.phaseId,
          actorId: blockerSeed.actors.GATE_ADMIN,
          credentialBinding: blockerSeed.credentials.GATE_ADMIN,
          expectedVersion: await phaseVersion(blockerSeed.phaseId),
        },
        { db: pool }
      ),
      /open BLOCKER/
    );

    const majorSeed = await seedPhase("open-major");
    const majorSubmission = await sealFirstSubmission(majorSeed);
    await validate(
      majorSeed,
      majorSubmission.submission.id,
      "PLANNING",
      "APPROVED",
      [{ severity: "MAJOR", category: "OPERATIONS", title: "Open major", detail: "No debt approval" }]
    );
    await validate(majorSeed, majorSubmission.submission.id, "DEVELOPMENT");
    await assert.rejects(
      gateService.gatePhase(
        {
          phaseId: majorSeed.phaseId,
          actorId: majorSeed.actors.GATE_ADMIN,
          credentialBinding: majorSeed.credentials.GATE_ADMIN,
          expectedVersion: await phaseVersion(majorSeed.phaseId),
        },
        { db: pool }
      ),
      /open MAJOR findings require ACCEPTED_WITH_DEBT/
    );
  });

  test("dependency activation is emitted once and blocks successor start until predecessor acceptance", async () => {
    const predecessor = await seedPhase("dependency-predecessor");
    const successor = await seedPhase(
      "dependency-successor",
      { dependencies: [predecessor.phaseId], start: false }
    );
    await assert.rejects(
      phaseService.startPhase(
        {
          phaseId: successor.phaseId,
          actorId: successor.actors.GATE_ADMIN,
          credentialBinding: successor.credentials.GATE_ADMIN,
          expectedVersion: 0,
        },
        { db: pool }
      ),
      /not accepted and activated/
    );

    const sealed = await sealFirstSubmission(predecessor);
    await validate(predecessor, sealed.submission.id, "PLANNING");
    await validate(predecessor, sealed.submission.id, "DEVELOPMENT");
    await gateService.gatePhase(
      {
        phaseId: predecessor.phaseId,
        actorId: predecessor.actors.GATE_ADMIN,
        credentialBinding: predecessor.credentials.GATE_ADMIN,
        expectedVersion: await phaseVersion(predecessor.phaseId),
      },
      { db: pool }
    );
    const started = await phaseService.startPhase(
      {
        phaseId: successor.phaseId,
        actorId: successor.actors.GATE_ADMIN,
        credentialBinding: successor.credentials.GATE_ADMIN,
        expectedVersion: 0,
      },
      { db: pool }
    );
    assert.equal(started.status, "IN_PROGRESS");
    await assert.rejects(
      phaseService.startPhase(
        {
          phaseId: successor.phaseId,
          actorId: successor.actors.GATE_ADMIN,
          credentialBinding: successor.credentials.GATE_ADMIN,
          expectedVersion: started.row_version,
        },
        { db: pool }
      ),
      /cannot start from status IN_PROGRESS/
    );
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM phase_dependency_activations
          WHERE phase_id = $1 AND depends_on_phase_id = $2) AS activation_count,
         (SELECT COUNT(*)::int FROM phase_gate_events
          WHERE phase_id = $1 AND event_type = 'PHASE_DEPENDENCY_ACTIVATED') AS event_count`,
      [successor.phaseId, predecessor.phaseId]
    );
    assert.deepEqual(rows[0], { activation_count: 1, event_count: 1 });
    const status = await phaseService.getPhaseStatus(successor.phaseId, { db: pool });
    assert.equal(status.dependencies[0].activated_by_submission_id, sealed.submission.id);
  });

  test("Gate administrator can cancel an active phase with an audited reason", async () => {
    const seed = await seedPhase("cancel");
    const cancelled = await phaseService.cancelPhase(
      {
        phaseId: seed.phaseId,
        reason: "phase scope withdrawn",
        actorId: seed.actors.GATE_ADMIN,
        credentialBinding: seed.credentials.GATE_ADMIN,
        expectedVersion: await phaseVersion(seed.phaseId),
      },
      { db: pool }
    );
    assert.equal(cancelled.status, "CANCELLED");
    const { rows } = await pool.query(
      `SELECT event_payload->>'reason' AS reason FROM phase_gate_events
       WHERE phase_id = $1 AND event_type = 'PHASE_CANCELLED'`,
      [seed.phaseId]
    );
    assert.equal(rows[0].reason, "phase scope withdrawn");
  });

  test("non-security MAJOR debt needs explicit approvals from both current validators", async () => {
    const seed = await seedPhase("debt");
    const sealed = await sealFirstSubmission(seed);
    const planning = await validate(
      seed,
      sealed.submission.id,
      "PLANNING",
      "APPROVED",
      [{ id: `finding-${seed.phaseId}`, findingKey: "ops-debt", severity: "MAJOR", category: "OPERATIONS", title: "Manual rotation", detail: "Automation follows in Phase 16" }]
    );
    await validate(seed, sealed.submission.id, "DEVELOPMENT");
    const findingId = `finding-${seed.phaseId}`;
    const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const debt = await findingService.registerDebt(
      {
        debtId: `debt-${seed.phaseId}`,
        findingId,
        debtOwnerActorId: seed.actors.WORKER,
        riskOwnerActorId: seed.actors.GATE_ADMIN,
        dueDate,
        impactScope: "Phase 15 bootstrap operations only",
        actorId: seed.actors.GATE_ADMIN,
        credentialBinding: seed.credentials.GATE_ADMIN,
      },
      { db: pool }
    );
    await assert.rejects(
      gateService.gatePhase(
        {
          phaseId: seed.phaseId,
          actorId: seed.actors.GATE_ADMIN,
          credentialBinding: seed.credentials.GATE_ADMIN,
          expectedVersion: await phaseVersion(seed.phaseId),
          acceptWithDebt: true,
        },
        { db: pool }
      ),
      /not eligible or fully approved as successor-safe debt/
    );
    await findingService.approveDebt(
      {
        debtId: debt.id,
        validatorType: "PLANNING",
        successorSafe: true,
        safetyRationale: "Debt is isolated to Phase 15 operator documentation.",
        actorId: seed.actors.PLANNING_VALIDATOR,
        credentialBinding: seed.credentials.PLANNING_VALIDATOR,
      },
      { db: pool }
    );
    await findingService.approveDebt(
      {
        debtId: debt.id,
        validatorType: "DEVELOPMENT",
        successorSafe: true,
        safetyRationale: "Debt does not affect the Phase 16 workspace safety boundary.",
        actorId: seed.actors.DEVELOPMENT_VALIDATOR,
        credentialBinding: seed.credentials.DEVELOPMENT_VALIDATOR,
      },
      { db: pool }
    );
    await findingService.acceptDebtRisk(
      {
        debtId: debt.id,
        actorId: seed.actors.GATE_ADMIN,
        credentialBinding: seed.credentials.GATE_ADMIN,
      },
      { db: pool }
    );
    const accepted = await gateService.gatePhase(
      {
        phaseId: seed.phaseId,
        actorId: seed.actors.GATE_ADMIN,
        credentialBinding: seed.credentials.GATE_ADMIN,
        expectedVersion: await phaseVersion(seed.phaseId),
        acceptWithDebt: true,
      },
      { db: pool }
    );
    assert.equal(planning.verdict, "APPROVED");
    assert.equal(accepted.status, "ACCEPTED_WITH_DEBT");
  });

  test("signed bootstrap package imports and replays through the self-hosted Gate", async () => {
    const planningKeys = crypto.generateKeyPairSync("ed25519");
    const developmentKeys = crypto.generateKeyPairSync("ed25519");
    const planningPem = planningKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const developmentPem = developmentKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const manifest = {
      ...manifestFor("phase-15", "bootstrap-worker", 1),
      baseCommitSha: repositoryCommits[0],
      candidateCommitSha: repositoryCommits[1],
    };
    const artifactBundleHash = hashCanonicalJson(manifest);
    const submissionId = "ps-bootstrap-phase15-1";
    const planningPayload = {
      validationId: "pv-bootstrap-planning-1",
      validatorType: "PLANNING",
      phaseId: "phase-15",
      phaseSubmissionId: submissionId,
      artifactBundleHash,
      verdict: "APPROVED",
      validatedBy: "bootstrap-planning",
      evidenceArtifactIds: ["planning-evidence"],
      findings: [],
      signedAt: new Date().toISOString(),
    };
    const developmentPayload = {
      validationId: "pv-bootstrap-development-1",
      validatorType: "DEVELOPMENT",
      phaseId: "phase-15",
      phaseSubmissionId: submissionId,
      artifactBundleHash,
      verdict: "APPROVED",
      validatedBy: "bootstrap-development",
      evidenceArtifactIds: ["development-evidence"],
      findings: [],
      signedAt: new Date().toISOString(),
    };
    const bootstrapPackage = {
      manifest,
      submissionId,
      assignments: {
        WORKER: "bootstrap-worker",
        PLANNING_VALIDATOR: "bootstrap-planning",
        DEVELOPMENT_VALIDATOR: "bootstrap-development",
        GATE_ADMIN: "bootstrap-gate",
      },
      actors: [
        { id: "bootstrap-worker", actorType: "AGENT", displayName: "Worker", credentialBinding: credentialFingerprint("bootstrap-worker") },
        { id: "bootstrap-planning", actorType: "HUMAN", displayName: "Planning", credentialBinding: publicKeyFingerprint(planningPem) },
        { id: "bootstrap-development", actorType: "HUMAN", displayName: "Development", credentialBinding: publicKeyFingerprint(developmentPem) },
        { id: "bootstrap-gate", actorType: "SERVICE", displayName: "Gate", credentialBinding: credentialFingerprint("bootstrap-gate") },
      ],
      planningVerdict: {
        payload: planningPayload,
        publicKeyPem: planningPem,
        signature: signVerdictPayload(planningPayload, planningKeys.privateKey),
      },
      developmentVerdict: {
        payload: developmentPayload,
        publicKeyPem: developmentPem,
        signature: signVerdictPayload(developmentPayload, developmentKeys.privateKey),
      },
    };
    const result = await importBootstrapPackage(bootstrapPackage, { db: pool, repositoryRoot });
    assert.equal(result.accepted.status, "ACCEPTED");
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM phase_gate_events WHERE phase_id = 'phase-15' AND event_type = 'BOOTSTRAP_ACCEPTED'"
    );
    assert.equal(rows[0].count, 1);
    const { rows: activationRows } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM phase_dependency_activations
       WHERE phase_id = 'phase-16' AND depends_on_phase_id = 'phase-15'`
    );
    assert.equal(activationRows[0].count, 1);
  });
}
