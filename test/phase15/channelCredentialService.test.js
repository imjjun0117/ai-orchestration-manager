const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const credentialService = require("../../src/channels/channelCredentialService");
const { interactiveSetup } = require("../../scripts/channel-credentials");
const DiscordAdapter = require("../../src/channels/discordAdapter");
const { ensureMasterKey, requestedRole, selectRole } = require("../../bot");

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
  assert.equal(await selectRole(async () => "2"), "planning-validator");
  assert.equal(await selectRole(async () => "gate-admin"), "gate-admin");
  await assert.rejects(selectRole(async () => "unknown"), /Unsupported role/);
  assert.equal(requestedRole(["--role", "worker"]), "worker");
  assert.equal(requestedRole([]), null);
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
});
