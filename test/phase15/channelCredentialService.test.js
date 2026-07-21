const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const credentialService = require("../../src/channels/channelCredentialService");
const { interactiveSetup } = require("../../scripts/channel-credentials");
const DiscordAdapter = require("../../src/channels/discordAdapter");
const { ensureMasterKey, launchRoles, requestedRole, ROLE_LABELS, selectRole } = require("../../bot");

test("channel token encryption round-trips without storing plaintext", async () => {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const token = "discord-token-test-value";
    const encrypted = credentialService.encryptToken(token);
    assert.notEqual(encrypted.ciphertext.toString("utf8"), token);
    const row = {
      encrypted_token: encrypted.ciphertext.toString("base64"),
      nonce: encrypted.iv.toString("base64"),
      auth_tag: encrypted.authTag.toString("base64"),
    };
    assert.equal(credentialService.decryptToken(row), token);

    const calls = [];
    const fakeDb = { query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 1, channel_type: "discord", bot_instance_id: "test" }] };
    } };
    await credentialService.storeToken({ channelType: "discord", botInstanceId: "test", token }, { db: fakeDb });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].params.includes(token));
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
});

test("channel token encryption rejects missing or invalid master keys", () => {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  try {
    delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    assert.throws(() => credentialService.encryptToken("token"), /CHANNEL_TOKEN_MASTER_KEY is required/);
    process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(16, 3).toString("base64");
    assert.throws(() => credentialService.encryptToken("token"), /must decode to 32 bytes/);
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
});

test("fingerprint backfill decrypts all rows before metadata-only updates", async () => {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(32, 8).toString("base64");
  const first = credentialService.encryptToken("first-token");
  const second = credentialService.encryptToken("second-token");
  const updates = [];
  const row = (id, encrypted) => ({
    id,
    encrypted_token: encrypted.ciphertext.toString("base64"),
    nonce: encrypted.iv.toString("base64"),
    auth_tag: encrypted.authTag.toString("base64"),
    key_version: encrypted.keyVersion,
  });
  const fakeDb = {
    async query(sql, params) {
      if (sql.includes("SELECT id, encrypted_token")) return { rows: [row(1, first), row(2, second)] };
      updates.push({ sql, params });
      return { rows: [] };
    },
  };
  try {
    const result = await credentialService.backfillTokenFingerprints({ channelType: "discord" }, { db: fakeDb });
    assert.deepEqual(result, { channelType: "discord", fingerprinted: 2 });
    assert.equal(updates.length, 2);
    assert.match(updates[0].params[0], /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(updates[0].params[0], updates[1].params[0]);
    assert.equal(updates.every(({ sql }) => !sql.includes("encrypted_token =")), true);
    assert.equal(updates.some(({ params }) => params.includes("first-token") || params.includes("second-token")), false);
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
});

test("re-storing a revoked credential reactivates it", async () => {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  let status = "REVOKED";
  let encryptedRow = null;
  const replacement = credentialService.encryptToken("rotated-token");
  const fakeDb = {
    query: async (sql, params) => {
      if (sql.includes("INSERT INTO channel_credentials")) {
        encryptedRow = {
          encrypted_token: replacement.ciphertext.toString("base64"),
          nonce: replacement.iv.toString("base64"),
          auth_tag: replacement.authTag.toString("base64"),
          key_version: replacement.keyVersion,
        };
        status = "ACTIVE";
        return { rows: [{ id: 1, channel_type: "discord", bot_instance_id: "test", status }] };
      }
      if (sql.includes("SELECT encrypted_token")) return { rows: status === "ACTIVE" ? [encryptedRow] : [] };
      return { rows: [] };
    },
  };
  try {
    assert.equal(await credentialService.getToken({ channelType: "discord", botInstanceId: "test" }, { db: fakeDb }), null);
    await credentialService.storeToken({ channelType: "discord", botInstanceId: "test", token: "rotated-token" }, { db: fakeDb });
    assert.equal(await credentialService.getToken({ channelType: "discord", botInstanceId: "test" }, { db: fakeDb }), "rotated-token");
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
});

test("interactive setup stores a hidden token for the selected role", async () => {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
  const answers = ["discord", "planning-validator"];
  const calls = { migrated: [], saved: [] };
  try {
    const result = await interactiveSetup({
      ask: async () => answers.shift(),
      askSecret: async () => "interactive-secret-token",
      migrate: async (id) => calls.migrated.push(id),
      statusLookup: async () => null,
      isInteractive: () => true,
      save: async (value) => {
        calls.saved.push(value);
        return { key_version: 1 };
      },
    });
    assert.deepEqual(calls.migrated, ["016_channel_credentials"]);
    assert.equal(calls.saved[0].botInstanceId, "planning-validator");
    assert.equal(calls.saved[0].token, "interactive-secret-token");
    assert.equal(calls.saved[0].metadata.source, "interactive-setup");
    assert.deepEqual(result, {
      configured: true,
      channelType: "discord",
      botInstanceId: "planning-validator",
      status: "ACTIVE",
      keyVersion: 1,
    });
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
});

test("interactive setup preserves an existing ACTIVE credential by default", async () => {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
  const answers = ["discord", "worker", "no"];
  let secretPrompted = false;
  try {
    const result = await interactiveSetup({
      ask: async () => answers.shift(),
      askSecret: async () => {
        secretPrompted = true;
        return "should-not-be-read";
      },
      migrate: async () => {},
      statusLookup: async () => ({ status: "ACTIVE" }),
      isInteractive: () => true,
      save: async () => {
        throw new Error("save must not be called");
      },
    });
    assert.equal(secretPrompted, false);
    assert.deepEqual(result, {
      configured: false,
      reason: "existing-active",
      channelType: "discord",
      botInstanceId: "worker",
    });
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
});

test("interactive setup rejects non-TTY input with a non-zero exit", () => {
  const script = path.resolve(__dirname, "../../scripts/channel-credentials.js");
  const result = spawnSync(process.execPath, [script, "setup"], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
    input: "discord\nworker\nsecret-token\n",
    env: {
      ...process.env,
      CHANNEL_TOKEN_MASTER_KEY: Buffer.alloc(32, 13).toString("base64"),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a TTY/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-token/);
});

test("interactive setup validates the master key before prompting", async () => {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  process.env.CHANNEL_TOKEN_MASTER_KEY = Buffer.alloc(16, 14).toString("base64");
  let prompted = false;
  try {
    await assert.rejects(
      interactiveSetup({
        ask: async () => {
          prompted = true;
          return "discord";
        },
        askSecret: async () => {
          prompted = true;
          return "token";
        },
        isInteractive: () => true,
      }),
      /must decode to 32 bytes/
    );
    assert.equal(prompted, false);
  } finally {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
});

test("bot launcher selects supported roles by number or name", async () => {
  assert.deepEqual(require("../../bot").ROLES, [
    "worker",
    "planning-validator",
    "development-validator",
    "gate-admin",
  ]);
  assert.deepEqual(ROLE_LABELS, {
    worker: "Developer",
    "planning-validator": "PM",
    "development-validator": "Code Reviewer",
    "gate-admin": "Release Manager",
  });
  assert.equal(await selectRole(async () => "2"), "planning-validator");
  assert.equal(await selectRole(async () => "gate-admin"), "gate-admin");
  assert.equal(await selectRole(async () => "Code Reviewer"), "development-validator");
  await assert.rejects(selectRole(async () => "unknown"), /Unsupported role/);
  assert.equal(requestedRole(["--role", "worker"]), "worker");
  assert.equal(requestedRole([]), null);
  assert.throws(() => requestedRole(["--role", "typo"]), /Unsupported role: typo/);
  assert.throws(() => requestedRole(["--role"]), /Unsupported role: missing/);
});

test("bot launcher creates a protected local master key without exposing it", async () => {
  const previous = process.env.CHANNEL_TOKEN_MASTER_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-launcher-key-"));
  const targetEnvFile = path.join(tempDir, ".env");
  try {
    delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    assert.equal(await ensureMasterKey(async () => "yes", { targetEnvFile }), true);
    const contents = fs.readFileSync(targetEnvFile, "utf8");
    assert.match(contents, /^CHANNEL_TOKEN_MASTER_KEY=[A-Za-z0-9+/]+={0,2}\n$/);
    assert.equal(Buffer.from(process.env.CHANNEL_TOKEN_MASTER_KEY, "base64").length, 32);
    assert.equal(fs.statSync(targetEnvFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CHANNEL_TOKEN_MASTER_KEY;
    else process.env.CHANNEL_TOKEN_MASTER_KEY = previous;
  }
});

test("bot supervisor launches role processes with distinct default prefixes", async () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 1000 + calls.length;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ command, args, options, child });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  assert.equal(await launchRoles(["worker", "planning-validator"], { spawnProcess: fakeSpawn }), 0);
  assert.equal(calls[0].options.env.BOT_INSTANCE_ID, "worker");
  assert.equal(calls[0].options.env.COMMAND_PREFIX, "!dev");
  assert.equal(calls[1].options.env.BOT_INSTANCE_ID, "planning-validator");
  assert.equal(calls[1].options.env.COMMAND_PREFIX, "!pm");
  assert.match(calls[0].args[0], /bot-runtime\.js$/);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
});

test("bot supervisor prefixes output and fails fast when one role exits non-zero", async () => {
  const calls = [];
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdout = { write: (value) => stdoutChunks.push(String(value)) };
  const stderr = { write: (value) => stderrChunks.push(String(value)) };
  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 2000 + calls.length;
    child.killed = false;
    child.kill = (signal) => {
      if (child.killed) return false;
      child.killed = true;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    calls.push({ command, args, options, child });
    return child;
  };

  const running = launchRoles(["worker", "planning-validator"], { spawnProcess: fakeSpawn, stdout, stderr });
  calls[0].child.stdout.emit("data", "online\n");
  calls[1].child.stderr.emit("data", "warning\n");
  calls[0].child.emit("exit", 7, null);

  assert.equal(await running, 7);
  assert.equal(calls[1].child.killed, true);
  assert.match(stdoutChunks.join(""), /\[Developer\] online/);
  assert.match(stderrChunks.join(""), /\[PM\] warning/);
  assert.match(stderrChunks.join(""), /Developer exited code=7/);
  assert.match(stderrChunks.join(""), /DEGRADED: Developer stopped/);
  assert.match(stderrChunks.join(""), /PM exited signal=SIGTERM/);
});

test("DiscordAdapter subscribes to clientReady without deprecated ready events", () => {
  const events = [];
  const client = {
    once: (event, handler) => events.push({ event, handler }),
    on: () => {},
    login: async () => {},
  };
  const adapter = new DiscordAdapter(client);
  const handler = () => {};
  adapter.onReady(handler);
  assert.deepEqual(events, [{ event: "clientReady", handler }]);
});

test("bot runtime resolves Discord credentials from the database only", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../bot-runtime.js"), "utf8");
  assert.doesNotMatch(source, /process\.env\.DISCORD_TOKEN/);
  assert.match(source, /channelCredentialService\.getToken/);
  assert.match(source, /BOT_ROLE_LABEL/);
  assert.match(source, /`- role: \\`\$\{BOT_ROLE_LABEL\}\\`/);
});

test("Phase 15 operator rollback requires an explicit channel credential boundary", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../scripts/phase15-governance.js"), "utf8");
  assert.match(source, /--preserve-channel-credentials/);
  assert.match(source, /--delete-channel-credentials/);
  assert.match(source, /preserveChannels === deleteChannels/);
  assert.match(source, /BUNDLED_MIGRATION_IDS/);
});
