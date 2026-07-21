const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  PHASE17_BOTS,
  configurePhase17Credentials,
  selectSetupMode,
} = require("../../bot");

async function withMasterKey(callback) {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(32, 31).toString("base64");
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
}

test("Phase 17 bot setup exposes the six required role instances", async () => {
  assert.deepEqual(
    PHASE17_BOTS.map(({ role, instanceId }) => ({ role, instanceId })),
    [
      { role: "manager", instanceId: "manager-01" },
      { role: "planner", instanceId: "planner-01" },
      { role: "coder", instanceId: "coder-01" },
      { role: "reviewer", instanceId: "reviewer-01" },
      { role: "qa", instanceId: "qa-01" },
      { role: "summarizer", instanceId: "summarizer-01" },
    ]
  );
  assert.equal(await selectSetupMode(async () => ""), "phase17");
  assert.equal(await selectSetupMode(async () => "legacy"), "legacy");
  assert.equal(await selectSetupMode(async () => "q"), "exit");
  await assert.rejects(selectSetupMode(async () => "unknown"), /Unsupported setup mode/);
});

test("Phase 17 setup stores six distinct hidden tokens with role metadata", async () => withMasterKey(async () => {
  const tokens = PHASE17_BOTS.map(({ role }) => `secret-${role}`);
  const saved = [];
  const migrated = [];
  const output = [];
  const result = await configurePhase17Credentials({
    ask: async () => { throw new Error("text prompt should not be used for missing credentials"); },
    askSecret: async () => tokens.shift(),
    migrate: async (id) => migrated.push(id),
    statusLookup: async () => null,
    save: async (credential) => {
      saved.push(credential);
      return { key_version: 3 };
    },
    fingerprint: (token) => `fingerprint:${token}`,
    encrypt: () => {},
    output: { write: (value) => output.push(String(value)) },
    isInteractive: () => true,
  });

  assert.deepEqual(migrated, ["016_channel_credentials"]);
  assert.deepEqual(saved.map(({ botInstanceId }) => botInstanceId), PHASE17_BOTS.map(({ instanceId }) => instanceId));
  assert.deepEqual(saved.map(({ metadata }) => metadata.role), PHASE17_BOTS.map(({ role }) => role));
  assert.equal(saved.every(({ channelType, metadata }) => (
    channelType === "discord" && metadata.source === "bot-js-phase17-setup"
  )), true);
  assert.deepEqual(result, {
    configured: PHASE17_BOTS.map(({ instanceId }) => instanceId),
    skipped: [],
    total: 6,
  });
  assert.doesNotMatch(output.join(""), /secret-(manager|planner|coder|reviewer|qa|summarizer)/);
  assert.match(output.join(""), /configured=6, preserved=0/);
}));

test("Phase 17 setup preserves ACTIVE rows by default and reprompts for a duplicate token", async () => withMasterKey(async () => {
  const statuses = {
    "manager-01": { status: "ACTIVE", token_fingerprint: "fingerprint:manager-token" },
    "planner-01": { status: "ACTIVE", token_fingerprint: "fingerprint:old-planner-token" },
  };
  const textAnswers = ["no", "yes"];
  const secretAnswers = [
    "manager-token",
    "new-planner-token",
    "coder-token",
    "reviewer-token",
    "qa-token",
    "summarizer-token",
  ];
  const saved = [];
  const output = [];
  const result = await configurePhase17Credentials({
    ask: async () => textAnswers.shift(),
    askSecret: async () => secretAnswers.shift(),
    migrate: async () => {},
    statusLookup: async ({ botInstanceId }) => statuses[botInstanceId] || null,
    save: async (credential) => {
      saved.push(credential);
      return { key_version: 1 };
    },
    fingerprint: (token) => `fingerprint:${token}`,
    encrypt: () => {},
    output: { write: (value) => output.push(String(value)) },
    isInteractive: () => true,
  });

  assert.deepEqual(result.skipped, ["manager-01"]);
  assert.deepEqual(result.configured, ["planner-01", "coder-01", "reviewer-01", "qa-01", "summarizer-01"]);
  assert.equal(saved[0].token, "new-planner-token");
  assert.equal(saved.some(({ token }) => token === "manager-token"), false);
  assert.match(output.join(""), /already assigned to another Phase 17 bot/);
  for (const token of ["manager-token", "new-planner-token", "coder-token", "reviewer-token", "qa-token", "summarizer-token"]) {
    assert.equal(output.join("").includes(token), false);
  }
}));

test("Phase 17 setup fails closed for unsafe input and missing ACTIVE fingerprints", async () => withMasterKey(async () => {
  await assert.rejects(
    configurePhase17Credentials({
      ask: async () => "no",
      askSecret: async () => "secret",
      isInteractive: () => false,
    }),
    /requires a TTY/
  );

  let secretPrompted = false;
  await assert.rejects(
    configurePhase17Credentials({
      ask: async () => "no",
      askSecret: async () => { secretPrompted = true; return "secret"; },
      migrate: async () => {},
      statusLookup: async ({ botInstanceId }) => (
        botInstanceId === "manager-01" ? { status: "ACTIVE", token_fingerprint: null } : null
      ),
      encrypt: () => {},
      isInteractive: () => true,
    }),
    /ACTIVE but has no credential fingerprint/
  );
  assert.equal(secretPrompted, false);
}));

test("node bot.js refuses non-TTY token input without consuming a secret", () => {
  const root = path.resolve(__dirname, "../..");
  const result = spawnSync(process.execPath, [path.join(root, "bot.js")], {
    cwd: root,
    encoding: "utf8",
    input: "1\nsecret-that-must-not-be-read\n",
    env: { ...process.env, BOT_INSTANCE_ID: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a TTY/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-that-must-not-be-read/);
});
