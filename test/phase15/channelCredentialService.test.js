const assert = require("node:assert/strict");
const test = require("node:test");

const credentialService = require("../../src/channels/channelCredentialService");

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
