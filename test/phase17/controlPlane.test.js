const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createManagerIngress, shouldIgnoreMessage } = require("../../src/discord/managerCommandIngress");
const publication = require("../../src/controlPlane/publicationService");
const { createDiscordPublicationTransport } = require("../../src/discord/discordPublicationTransport");
const {
  adoptLegacyCredentials,
  bootstrapRoles,
  importCandidateCredentials,
  readiness,
  reconcile,
  reconciliationInventory,
  revokeCandidateCredentials,
  roleFunctions,
  rollback,
  verifyRoleProfiles,
} = require("../../scripts/phase17-control-plane");
const { loadRoleConfig, validateSixRoleSet } = require("../../src/controlPlane/roleConfig");
const { parseCommand } = require("../../src/controlPlane/workflowService");
const {
  parseApprovalCommand,
  resolveApprovalCommand,
} = require("../../src/controlPlane/workflowApprovalService");
const { resolveControlDatabaseUrl } = require("../../scripts/run-phase17-multibot");
const { bootRuntime } = require("../../src/controlPlane/runtime");
const { resolveRuntimeCredential } = require("../../src/channels/runtimeCredentialEnrollment");
const operations = require("../../src/controlPlane/operationsService");
const { jobPrompt } = require("../../src/controlPlane/roleExecutor");

function env(overrides = {}) {
  return {
    BOT_ROLE: "planner",
    BOT_INSTANCE_ID: "planner-01",
    DATABASE_URL: "postgres://example.invalid/db",
    MULTIBOT_ROLE_MODE: "shadow",
    ...overrides,
  };
}

test("role config rejects unknown roles, modes, and duplicate six-role identities", () => {
  assert.equal(loadRoleConfig(env()).executionMode, "dry-run");
  assert.throws(() => loadRoleConfig(env({ BOT_ROLE: "root" })), /BOT_ROLE/);
  assert.throws(() => loadRoleConfig(env({ MULTIBOT_ROLE_MODE: "live" })), /MULTIBOT_ROLE_MODE/);
  const roles = ["manager", "planner", "coder", "reviewer", "qa", "summarizer"];
  const configs = roles.map((role) => ({ role, instanceId: `${role}-01`, tokenFingerprint: `sha256:${role}` }));
  assert.equal(validateSixRoleSet(configs), true);
  assert.throws(() => validateSixRoleSet(configs.map((item, index) => ({
    ...item, tokenFingerprint: index < 2 ? "same" : item.tokenFingerprint,
  }))), /credentials must be distinct/);
});

test("six-role runner reads only the control DATABASE_URL fallback", () => {
  const fileSystem = {
    existsSync: () => true,
    readFileSync: () => Buffer.from("DATABASE_URL=postgres://operator:secret@localhost/db\nDISCORD_TOKEN=must-not-propagate\n"),
  };
  assert.equal(
    resolveControlDatabaseUrl({}, { fileSystem, root: "/safe-root" }),
    "postgres://operator:secret@localhost/db"
  );
});

test("runtime marks a registered instance offline when Discord login fails", async () => {
  const previousMode = process.env.MULTIBOT_ROLE_MODE;
  process.env.MULTIBOT_ROLE_MODE = "shadow";
  const calls = [];
  const database = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM delivery_phases")) return { rows: [{ id: "phase-16", status: "ACCEPTED" }] };
      if (sql.includes("register_bot_instance")) return { rows: [{}] };
      if (sql.includes("mark_bot_instance_offline")) return { rows: [{}] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  let destroyed = false;
  let revoked = false;
  const client = {
    async login() { throw new Error("invalid token"); },
    destroy() { destroyed = true; },
  };
  try {
    await assert.rejects(
      bootRuntime(loadRoleConfig(env()), {
        client,
        database,
        resolveCredential: async () => ({ token: "invalid-discord-token", enrolled: false }),
        revokeCredential: async () => { revoked = true; },
      }),
      /DB credential was revoked/
    );
    assert.equal(calls.some((sql) => sql.includes("mark_bot_instance_offline")), true);
    assert.equal(revoked, true);
    assert.equal(destroyed, true);
  } finally {
    if (previousMode === undefined) delete process.env.MULTIBOT_ROLE_MODE;
    else process.env.MULTIBOT_ROLE_MODE = previousMode;
  }
});

test("missing runtime credential is hidden-prompted and encrypted into the principal-bound DB API", async () => {
  const previousKey = process.env.CHANNEL_TOKEN_MASTER_KEY;
  process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(32, 22).toString("base64");
  const calls = [];
  const outputChunks = [];
  const database = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("get_phase17_channel_credential")) return { rows: [] };
      if (sql.includes("store_phase17_channel_credential")) {
        return { rows: [{ bot_instance_id: "planner-01", channel_type: "discord", status: "ACTIVE", key_version: 1 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  try {
    const result = await resolveRuntimeCredential(loadRoleConfig(env()), {
      db: database,
      input: { isTTY: true },
      output: { isTTY: true, write: (value) => outputChunks.push(String(value)) },
      prompt: async (label) => {
        assert.match(label, /planner-01/);
        return "runtime-entered-secret";
      },
    });
    assert.deepEqual(result, { token: "runtime-entered-secret", enrolled: true });
    const store = calls.find(({ sql }) => sql.includes("store_phase17_channel_credential"));
    assert.ok(store);
    assert.equal(store.params.includes("runtime-entered-secret"), false);
    assert.doesNotMatch(JSON.stringify(store.params), /runtime-entered-secret/);
    assert.doesNotMatch(outputChunks.join(""), /runtime-entered-secret/);
    assert.match(outputChunks.join(""), /encrypted and stored in DB/);
  } finally {
    if (previousKey === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previousKey;
  }
});

test("missing runtime credential fails without prompting when node stdin is not a TTY", async () => {
  let prompted = false;
  await assert.rejects(
    resolveRuntimeCredential(loadRoleConfig(env()), {
      db: { async query() { return { rows: [] }; } },
      input: { isTTY: false },
      output: { isTTY: false },
      prompt: async () => { prompted = true; return "secret"; },
    }),
    /run this role node directly in a TTY/
  );
  assert.equal(prompted, false);
});

test("Manager command parsing is bounded and role bot messages are ignored", () => {
  assert.deepEqual(parseCommand("!qa run regression"), { command: "!qa", request: "run regression" });
  assert.equal(parseCommand("hello"), null);
  assert.equal(shouldIgnoreMessage({ author: { id: "bot", bot: true } }), true);
  assert.equal(shouldIgnoreMessage({ author: { id: "known", bot: false } }, new Set(["known"])), true);
  assert.equal(shouldIgnoreMessage({ author: { id: "user", bot: false }, webhookId: null, system: false }), false);
});

test("role execution and operational output use Korean by default", async () => {
  const prompt = jobPrompt({
    target_role: "planner",
    task_id: "task-korean",
    job_type: "TASK_PLAN",
    correlation_id: "corr-korean",
    payload_json: { request: "기능 계획" },
  });
  assert.match(prompt, /모든 분석, 계획, 검토, 테스트 결과와 최종 보고는 한국어로 작성한다/);
  assert.match(prompt, /기술 문자열은 원문을 유지한다/);
  assert.match(operations.roles(), /PM\(기획\) \(planner\)/);
  assert.match(
    await operations.instance("missing", { db: { query: async () => ({ rows: [] }) } }),
    /인스턴스를 찾을 수 없습니다/
  );
});

test("operational ingress queues an outbox response and never replies directly", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM bot_instances")) return { rows: [] };
      return { rows: [{}] };
    },
  };
  const ingress = createManagerIngress({
    config: { role: "manager", instanceId: "manager-primary" }, db,
  });
  const result = await ingress({
    id: "m1", content: "!team", channelId: "c1", guildId: "g1",
    author: { id: "u1", bot: false }, webhookId: null, system: false,
  });
  assert.equal(result.queued, true);
  assert.equal(calls.some((call) => call.sql.includes("enqueue_manager_notice")), true);
});

test("approval commands require a bounded node ID and a rejection reason", () => {
  assert.deepEqual(parseApprovalCommand(parseCommand("!approve node-123")), {
    approved: true, nodeId: "node-123", reason: null,
  });
  assert.deepEqual(parseApprovalCommand(parseCommand("!reject node-123 테스트 실패")), {
    approved: false, nodeId: "node-123", reason: "테스트 실패",
  });
  assert.throws(() => parseApprovalCommand(parseCommand("!reject node-123")), /rejection reason/);
  assert.throws(() => parseApprovalCommand(parseCommand("!approve ../node")), /valid workflow node ID/);
});

test("workflow approval is bound to its Discord requester and original channel", async () => {
  const binding = {
    workflow_approval_id: 1,
    workflow_run_id: "run-1",
    workflow_node_id: "node-1",
    expected_task_state: "CREATED",
    expected_task_version: "0",
    task_id: "task-1",
    workflow_definition_id: "phase17-default-v1",
    node_key: "planner",
    created_by: "user-1",
    channel_id: "channel-1",
    terminal_node: false,
  };
  let resolvedCall = null;
  const db = {
    async query(sql, params) {
      if (sql.includes("FROM approvals a")) return { rows: [binding] };
      if (sql.includes("resolve_discord_workflow_approval")) {
        resolvedCall = { sql, params };
        return { rows: [{ id: "run-1", status: "RUNNING" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await assert.rejects(
    resolveApprovalCommand({
      parsed: parseCommand("!approve node-1"), managerInstanceId: "manager-01",
      discordUserId: "intruder", channelId: "channel-1",
    }, { db }),
    /restricted to the task requester/
  );
  const result = await resolveApprovalCommand({
    parsed: parseCommand("!approve node-1"), managerInstanceId: "manager-01",
    discordUserId: "user-1", channelId: "channel-1",
  }, { db });
  assert.equal(result.approved, true);
  assert.equal(result.candidateSettled, false);
  assert.deepEqual(resolvedCall.params, [
    "run-1", "node-1", "manager-01", "user-1", "channel-1", true, null,
  ]);
});

test("terminal workflow approval settles the exact bound candidate first", async () => {
  const calls = [];
  const db = {
    async query(sql) {
      if (sql.includes("FROM approvals a")) {
        return { rows: [{
          workflow_run_id: "run-1", workflow_node_id: "node-final",
          expected_task_state: "CREATED", expected_task_version: "1",
          task_id: "task-1", node_key: "summarizer",
          created_by: "user-1", channel_id: "channel-1", terminal_node: true,
        }] };
      }
      if (sql.includes("resolve_discord_workflow_approval")) return { rows: [{ id: "run-1", status: "SUCCEEDED" }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await resolveApprovalCommand({
    parsed: parseCommand("!approve node-final"), managerInstanceId: "manager-01",
    discordUserId: "user-1", channelId: "channel-1",
  }, {
    db,
    approvalService: {
      async getBoundApprovalDisplay() {
        return {
          approvalId: 77, action: "commit_approval_phase16", taskId: "task-1",
          expectedTaskState: "CREATED", expectedTaskVersion: 1,
        };
      },
    },
    workspaceWorkflow: {
      async finalizeApprovedCandidate(input) {
        calls.push(input);
        return { reconciliationRequired: false };
      },
    },
  });
  assert.deepEqual(calls, [{ approvalId: 77, resolvedBy: "user-1", actorId: "manager-01" }]);
  assert.equal(result.candidateSettled, true);
});

test("terminal workflow rejection settles and cleans the bound candidate first", async () => {
  const calls = [];
  let resolutionParams = null;
  const db = {
    async query(sql, params) {
      if (sql.includes("FROM approvals a")) {
        return { rows: [{
          workflow_run_id: "run-1", workflow_node_id: "node-final",
          expected_task_state: "CREATED", expected_task_version: "1",
          task_id: "task-1", node_key: "summarizer",
          created_by: "user-1", channel_id: "channel-1", terminal_node: true,
        }] };
      }
      if (sql.includes("resolve_discord_workflow_approval")) {
        resolutionParams = params;
        return { rows: [{ id: "run-1", status: "REJECTED" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await resolveApprovalCommand({
    parsed: parseCommand("!reject node-final QA 실패"), managerInstanceId: "manager-01",
    discordUserId: "user-1", channelId: "channel-1",
  }, {
    db,
    approvalService: {
      async getBoundApprovalDisplay() {
        return {
          approvalId: 78, action: "commit_approval_phase16", taskId: "task-1",
          expectedTaskState: "CREATED", expectedTaskVersion: 1,
        };
      },
    },
    workspaceWorkflow: {
      async rejectCandidateApproval(input) {
        calls.push(input);
        return { reconciliationRequired: false };
      },
    },
  });
  assert.deepEqual(calls, [{ approvalId: 78, resolvedBy: "user-1", reason: "QA 실패" }]);
  assert.deepEqual(resolutionParams, [
    "run-1", "node-final", "manager-01", "user-1", "channel-1", false, "QA 실패",
  ]);
  assert.equal(result.workflowRun.status, "REJECTED");
});

test("terminal workflow approval fails closed on a mismatched bound candidate", async () => {
  const db = {
    async query(sql) {
      if (sql.includes("FROM approvals a")) {
        return { rows: [{
          workflow_run_id: "run-1", workflow_node_id: "node-final",
          expected_task_state: "CREATED", expected_task_version: "2",
          task_id: "task-1", node_key: "summarizer",
          created_by: "user-1", channel_id: "channel-1", terminal_node: true,
        }] };
      }
      throw new Error("workflow resolution must not run");
    },
  };
  await assert.rejects(
    resolveApprovalCommand({
      parsed: parseCommand("!approve node-final"), managerInstanceId: "manager-01",
      discordUserId: "user-1", channelId: "channel-1",
    }, {
      db,
      approvalService: {
        async getBoundApprovalDisplay() {
          return {
            approvalId: 77, action: "commit_approval_phase16", taskId: "task-1",
            expectedTaskState: "CREATED", expectedTaskVersion: 1,
          };
        },
      },
    }),
    /does not match the terminal workflow approval/
  );
});

test("approval ingress queues an audited Korean acknowledgement", async () => {
  const queries = [];
  const ingress = createManagerIngress({
    config: { role: "manager", instanceId: "manager-01" },
    db: { async query(sql, params) { queries.push({ sql, params }); return { rows: [{}] }; } },
    async resolveApprovalCommand(input) {
      assert.equal(input.discordUserId, "user-1");
      return { approved: true, taskId: "task-1", nodeId: "node-1" };
    },
  });
  const result = await ingress({
    id: "message-approve", content: "!approve node-1", channelId: "channel-1",
    author: { id: "user-1", bot: false }, webhookId: null, system: false,
  });
  assert.equal(result.approval, true);
  assert.match(queries[0].params[3], /승인 처리했습니다/);
});

test("publication markers are deterministic and do not expose secrets", () => {
  const event = { id: "o1", correlation_id: "c1", event_type: "COMMAND_ACCEPTED", payload_json: { taskId: "t1" } };
  const marker = publication.markerFor(event);
  assert.equal(marker, "ai-manager:c1:o1");
  assert.match(publication.render(event, marker), /작업을 접수했습니다/);
  const approval = {
    id: "o2", correlation_id: "c2", event_type: "APPROVAL_REQUIRED",
    payload_json: { taskId: "t1", nodeId: "node-1" },
  };
  assert.match(publication.render(approval, publication.markerFor(approval)), /!approve node-1/);
  assert.match(publication.render(approval, publication.markerFor(approval)), /!reject node-1/);
  assert.doesNotMatch(publication.render(event, marker), /DATABASE_URL|TOKEN/);
});

test("shadow publication uses the application database adapter pool", async () => {
  const queries = [];
  let released = false;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("INSERT INTO discord_publications")) {
        return { rows: [{ id: "publication-1", status: "SHADOWED" }] };
      }
      if (sql.includes("suppress_outbox_event")) {
        return { rows: [{ id: "outbox-1", status: "SHADOWED" }] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  const database = {
    query: async () => { throw new Error("transaction queries must use the checked-out client"); },
    pool: { connect: async () => client },
  };
  const result = await publication.publish({
    id: "outbox-1",
    event_type: "COMMAND_ACCEPTED",
    aggregate_id: "task-1",
    correlation_id: "correlation-1",
    claim_token: "claim-1",
    target_role: "manager",
    payload_json: { taskId: "task-1", channelId: "channel-1" },
  }, {
    config: { mode: "shadow", instanceId: "manager-01" },
    db: database,
  });
  assert.equal(result.status, "SHADOWED");
  assert.equal(queries[0], "BEGIN");
  assert.equal(queries.at(-1), "COMMIT");
  assert.equal(queries.some((sql) => sql.includes("suppress_outbox_event")), true);
  assert.equal(released, true);
});

test("Discord marker reconciliation paginates a bounded history", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `message-${index}`, author: { id: "role-bot" }, content: "ordinary",
  }));
  const secondPage = [{ id: "matching", author: { id: "role-bot" }, content: "[marker-1]" }];
  const client = {
    channels: {
      async fetch() {
        return {
          messages: {
            async fetch(options) {
              calls.push(options);
              const page = calls.length === 1 ? firstPage : secondPage;
              return new Map(page.map((message) => [message.id, message]));
            },
          },
        };
      },
    },
  };
  const transport = createDiscordPublicationTransport(client);
  assert.deepEqual(await transport.findByMarker({ channelId: "channel", marker: "marker-1", authorId: "role-bot" }), [{ id: "matching" }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].before, "message-99");
});

test("role grants keep Manager transaction APIs away from workers", () => {
  assert.equal(roleFunctions("planner").some((signature) => signature.startsWith("receive_discord_command")), false);
  assert.equal(roleFunctions("manager").some((signature) => signature.startsWith("receive_discord_command")), true);
  assert.equal(roleFunctions("coder").some((signature) => signature.startsWith("acquire_workspace_lease")), true);
});

test("role bootstrap creates six fail-closed principals and secret-safe shadow profiles", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase17-bootstrap-test-"));
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("SELECT 1 FROM pg_roles")) return { rows: [] };
      if (sql.includes("SELECT quote_literal")) return { rows: [{ password: "'generated-password'" }] };
      return { rows: [] };
    },
    release() {},
  };
  let randomCounter = 0;
  try {
    const result = await bootstrapRoles(
      ["--create-postgres-roles", "--write-env-profiles"],
      {
        database: { pool: { async connect() { return client; } } },
        env: {
          DATABASE_URL: "postgres://operator:control-secret@localhost/ai_manager",
          CHANNEL_TOKEN_MASTER_KEY: "master-key-material",
        },
        randomBytes(size) {
          randomCounter += 1;
          return Buffer.alloc(size, randomCounter);
        },
        workingDirectory: temporaryRoot,
      }
    );
    assert.equal(result.created.length, 6);
    assert.equal(queries.filter(({ sql }) => sql.startsWith("CREATE ROLE")).length, 6);
    assert.doesNotMatch(JSON.stringify(result), /control-secret|master-key-material|generated-password/);
    for (const { role, principal, instanceId } of result.created) {
      const profilePath = path.join(temporaryRoot, ".env.phase17", `.env.${role}`);
      const contents = fs.readFileSync(profilePath, "utf8");
      assert.match(contents, new RegExp(`BOT_ROLE=\\"${role}\\"`));
      assert.match(contents, new RegExp(`BOT_INSTANCE_ID=\\"${instanceId}\\"`));
      assert.match(contents, new RegExp(`DATABASE_URL=\\"postgres://`));
      assert.match(contents, new RegExp(`${principal}`));
      assert.match(contents, /MULTIBOT_ROLE_MODE="shadow"/);
      assert.doesNotMatch(contents, /DISCORD_TOKEN|CHANNEL_TOKEN=/);
      assert.equal(fs.statSync(profilePath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("legacy credential adoption requires four distinct sources and never returns cipher material", async () => {
  const sources = [
    { bot_instance_id: "development-validator", token_fingerprint: "sha256:development" },
    { bot_instance_id: "gate-admin", token_fingerprint: "sha256:manager" },
    { bot_instance_id: "planning-validator", token_fingerprint: "sha256:planner" },
    { bot_instance_id: "worker", token_fingerprint: "sha256:coder" },
  ];
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("metadata_json->>'tokenFingerprint'")) return { rows: sources };
      if (sql.includes("SELECT bot_instance_id FROM channel_credentials")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const result = await adoptLegacyCredentials(
    ["--confirm-legacy-role-mapping"],
    { database: { pool: { async connect() { return client; } } } }
  );
  assert.equal(result.adopted.length, 4);
  assert.equal(queries.filter(({ sql }) => sql.includes("INSERT INTO channel_credentials")).length, 4);
  assert.doesNotMatch(JSON.stringify(result), /encrypted_token|nonce|auth_tag/);
});

test("role profile verification proves principal bindings without returning connection secrets", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase17-profile-test-"));
  const roleDirectory = path.join(temporaryRoot, ".env.phase17");
  fs.mkdirSync(roleDirectory, { mode: 0o700 });
  const roles = ["manager", "planner", "coder", "reviewer", "qa", "summarizer"];
  for (const role of roles) {
    fs.writeFileSync(path.join(roleDirectory, `.env.${role}`), [
      `BOT_ROLE=${role}`,
      `BOT_INSTANCE_ID=${role}-01`,
      `DATABASE_URL=postgres://${role}_db:database-secret@localhost/ai_manager`,
      "MULTIBOT_ROLE_MODE=shadow",
      "ROLE_WORKER_EXECUTION=dry-run",
      "CHANNEL_TOKEN_MASTER_KEY=master-secret",
      "",
    ].join("\n"), { mode: 0o600 });
  }
  class FakePool {
    constructor(databaseUrl) { this.principal = new URL(databaseUrl).username; }
    async query(sql) {
      if (sql.includes("has_function_privilege")) return { rows: [{ can_store: true, can_revoke: true }] };
      return { rows: [{ principal: this.principal }] };
    }
    async end() {}
  }
  try {
    const result = await verifyRoleProfiles([], {
      workingDirectory: temporaryRoot,
      poolFactory: (databaseUrl) => new FakePool(databaseUrl),
      database: {
        async query(sql, params) {
          assert.match(sql, /bot_role_principals/);
          return { rows: [{ bot_role: params[0].replace(/_db$/, ""), enabled: true }] };
        },
      },
    });
    assert.equal(result.verified.length, 6);
    assert.doesNotMatch(JSON.stringify(result), /database-secret|master-secret|DATABASE_URL/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("candidate credential import rejects duplicates and returns no token material", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase17-candidate-test-"));
  fs.writeFileSync(path.join(temporaryRoot, ".env.bot-a"), "DISCORD_TOKEN=qa-candidate-secret\n", { mode: 0o600 });
  fs.writeFileSync(path.join(temporaryRoot, ".env.bot-b"), "DISCORD_TOKEN=summarizer-candidate-secret\n", { mode: 0o600 });
  const inserts = [];
  const client = {
    async query(sql, params = []) {
      if (sql.includes("INSERT INTO channel_credentials")) inserts.push({ sql, params });
      return { rows: [] };
    },
    release() {},
  };
  try {
    const result = await importCandidateCredentials(
      ["--confirm-candidate-import"],
      {
        database: { pool: { async connect() { return client; } } },
        encrypt(token) {
          return {
            ciphertext: Buffer.from(`encrypted-${token.length}`),
            iv: Buffer.from("123456789012"),
            authTag: Buffer.from("1234567890123456"),
            keyVersion: 1,
          };
        },
        fingerprint: (token) => `sha256:${Buffer.from(token).toString("hex")}`,
        workingDirectory: temporaryRoot,
      }
    );
    assert.equal(result.imported.length, 2);
    assert.equal(inserts.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /candidate-secret|encrypted_token|auth_tag/);
    assert.equal(inserts.some(({ params }) => params.includes("qa-candidate-secret") || params.includes("summarizer-candidate-secret")), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("candidate credential revocation is limited to imported Phase 17 targets", async () => {
  const calls = [];
  const result = await revokeCandidateCredentials(
    ["--confirm-invalid-candidate-revocation"],
    {
      database: {
        async query(sql, params) {
          calls.push({ sql, params });
          return { rows: [{ bot_instance_id: "summarizer-01" }, { bot_instance_id: "qa-01" }] };
        },
      },
    }
  );
  assert.deepEqual(result, { revoked: ["qa-01", "summarizer-01"] });
  assert.match(calls[0].sql, /source' = 'legacy-env-import/);
  assert.deepEqual(calls[0].params[0], ["qa-01", "summarizer-01"]);
});

test("readiness reports missing principals, credentials, and instances without secret fields", async () => {
  const database = {
    async query(sql) {
      if (sql.includes("FROM delivery_phases")) return { rows: [{ id: "phase-16", status: "ACCEPTED" }, { id: "phase-17", status: "IN_PROGRESS" }] };
      if (sql.includes("FROM schema_migrations")) return { rows: [{ id: "018_durable_control_plane" }, { id: "019_phase17_credential_enrollment" }, { id: "020_phase17_operator_reconciliation" }, { id: "021_phase17_workflow_approvals" }] };
      if (sql.includes("FROM bot_role_principals")) return { rows: [] };
      if (sql.includes("FROM channel_credentials")) return { rows: [{ active_credentials: 0, distinct_fingerprints: 0, missing_fingerprints: 0 }] };
      if (sql.includes("FROM workflow_definitions")) return { rows: [{ count: 6 }] };
      if (sql.includes("FROM bot_instances")) return { rows: [] };
      if (sql.includes("FROM role_jobs")) return { rows: [{ active_jobs: 0, unhealthy_jobs: 0, pending_outbox: 0, unhealthy_outbox: 0 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await readiness({ database });
  assert.equal(result.readyForShadowSixBotSmoke, false);
  assert.ok(result.blockers.includes("no enabled DB principal for manager"));
  assert.ok(result.blockers.includes("fewer than six ACTIVE Discord credentials"));
  assert.doesNotMatch(JSON.stringify(result), /DATABASE_URL|encrypted_token|auth_tag/);
});

test("operator reconciliation inventory excludes payload and error detail", async () => {
  let statement = "";
  const rows = [{
    item_type: "OUTBOX_EVENT", item_id: "outbox-1", status: "NEEDS_RECONCILIATION",
    reconciliation_revision: "2", target_role: "manager", item_kind: "OPERATIONAL_RESPONSE",
    last_error_code: "ACK_UNKNOWN",
  }];
  const result = await reconciliationInventory({
    database: { async query(sql) { statement = sql; return { rows }; } },
  });
  assert.deepEqual(result, rows);
  assert.doesNotMatch(statement, /payload_json|last_error_detail_redacted|correlation_id|channel_id/);
});

test("operator reconciliation requires explicit confirmation and complete fenced evidence", async () => {
  const baseArgs = [
    "--request-id", "operator-request-001",
    "--item-type", "outbox-event",
    "--item-id", "outbox-1",
    "--decision", "retry",
    "--expected-revision", "2",
    "--reason", "Discord marker가 없음을 확인했습니다.",
    "--evidence-ref", "incident:phase17-001",
  ];
  await assert.rejects(reconcile(baseArgs, { database: { async query() { throw new Error("must not query"); } } }), /confirm-reconciliation/);
  let call;
  const result = await reconcile([...baseArgs, "--confirm-reconciliation"], {
    database: {
      async query(sql, params) {
        call = { sql, params };
        return { rows: [{ request_id: params[0], item_type: params[1], decision: params[3] }] };
      },
    },
  });
  assert.deepEqual(result, { request_id: "operator-request-001", item_type: "OUTBOX_EVENT", decision: "RETRY" });
  assert.match(call.sql, /reconcile_phase17_item/);
  assert.deepEqual(call.params.slice(0, 5), ["operator-request-001", "OUTBOX_EVENT", "outbox-1", "RETRY", "2"]);
  await assert.rejects(
    reconcile([...baseArgs.filter((value) => value !== "incident:phase17-001"), "unsafe evidence with spaces", "--confirm-reconciliation"], {
      database: { async query() { throw new Error("must not query"); } },
    }),
    /evidence ref/
  );
});

test("rollback fails closed for live workflows and undelivered outbox events", async () => {
  const args = ["--allow-destructive", "--confirm-phase17"];
  let migrated = false;
  await assert.rejects(
    rollback(args, {
      env: { MULTIBOT_ROLE_MODE: "off" },
      database: { async query() { return { rows: [{ count: 1 }] }; } },
      migrate: async () => { migrated = true; },
    }),
    /workflows are non-terminal/
  );
  assert.equal(migrated, false);

  let queryIndex = 0;
  await assert.rejects(
    rollback(args, {
      env: { MULTIBOT_ROLE_MODE: "off" },
      database: { async query() { queryIndex += 1; return { rows: [{ count: queryIndex === 1 ? 0 : 1 }] }; } },
      migrate: async () => { migrated = true; },
    }),
    /outbox events are undelivered/
  );
  assert.equal(migrated, false);

  queryIndex = 0;
  const result = await rollback(args, {
    env: { MULTIBOT_ROLE_MODE: "off" },
    database: { async query() { queryIndex += 1; return { rows: [{ count: 0 }] }; } },
    migrate: async (id, options) => ({ id, options }),
  });
  assert.equal(queryIndex, 2);
  assert.deepEqual(result.map(({ id }) => id), ["021_phase17_workflow_approvals", "020_phase17_operator_reconciliation", "019_phase17_credential_enrollment", "018_durable_control_plane"]);
  assert.equal(result.every(({ options }) => options.allowDestructive), true);
});
