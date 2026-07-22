const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PROFILES,
  parseArgs,
  parseControlEnv,
  parseRoleProfile,
  validateIdentityBindings,
  validateMessageEvidence,
} = require("../../scripts/phase17-discord-author-smoke");

function profile(role) {
  return {
    config: { role, instanceId: `${role}-01` },
  };
}

test("live author smoke requires confirmation and defaults to two cleaned rounds", () => {
  assert.throws(() => parseArgs([]), /requires --confirm-live-discord/);
  assert.deepEqual(parseArgs(["--confirm-live-discord"]), {
    cleanup: true,
    controlEnvFile: ".env",
    profiles: DEFAULT_PROFILES,
    rounds: 2,
    useLatestTaskChannel: false,
  });
  assert.equal(parseArgs(["--confirm-live-discord", "--use-latest-task-channel"]).useLatestTaskChannel, true);
  assert.throws(() => parseArgs(["--confirm-live-discord", "--rounds", "1"]), /2 to 5/);
});

test("role profile parser rejects plaintext tokens and enforced mode", () => {
  const base = [
    "BOT_ROLE=qa",
    "BOT_INSTANCE_ID=qa-01",
    "DATABASE_URL=postgres://example.invalid/db",
    "CHANNEL_TOKEN_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ];
  assert.throws(() => parseRoleProfile(Buffer.from([...base, "MULTIBOT_ROLE_MODE=shadow", "DISCORD_TOKEN=secret"].join("\n"))), /plaintext/);
  assert.throws(() => parseRoleProfile(Buffer.from([...base, "MULTIBOT_ROLE_MODE=enforced"].join("\n"))), /must remain in shadow/);
  assert.equal(parseRoleProfile(Buffer.from([...base, "MULTIBOT_ROLE_MODE=shadow"].join("\n"))).config.role, "qa");
});

test("control env parser returns only channel and database bindings", () => {
  assert.deepEqual(parseControlEnv(Buffer.from([
    "AI_WAR_ROOM_CHANNEL_ID=123456789012345678",
    "DATABASE_URL=postgres://operator:secret@localhost/db",
    "DISCORD_TOKEN=must-not-propagate",
  ].join("\n"))), {
    channelId: "123456789012345678",
    databaseUrl: "postgres://operator:secret@localhost/db",
  });
});

test("identity validation requires exact distinct DB bindings", () => {
  const profiles = ["manager", "planner", "coder", "reviewer", "qa", "summarizer"].map(profile);
  const identities = new Map(profiles.map(({ config }, index) => [config.instanceId, `identity-${index}`]));
  const rows = profiles.map(({ config }, index) => ({
    instance_id: config.instanceId,
    bot_role: config.role,
    discord_user_id: `identity-${index}`,
  }));
  assert.equal(validateIdentityBindings(profiles, identities, rows), true);
  assert.throws(() => validateIdentityBindings(profiles, identities, rows.map((row, index) => (
    index === 2 ? { ...row, discord_user_id: "wrong" } : row
  ))), /does not match/);
});

test("message evidence requires every repeated author match and Manager rejection", () => {
  const profiles = ["manager", "planner", "coder", "reviewer", "qa", "summarizer"].map(profile);
  const records = profiles.flatMap(({ config }) => [1, 2].map((round) => ({
    instanceId: config.instanceId,
    round,
    messageId: `${config.role}-${round}`,
    expectedAuthorId: config.role,
    sentAuthorId: config.role,
    fetchedAuthorId: config.role,
  })));
  const ingressResults = new Map(records.map(({ messageId }) => [messageId, { ignored: true, reason: "non-user-message" }]));
  assert.equal(validateMessageEvidence({ profiles, rounds: 2, records, ingressResults, receiptCount: 0 }), true);
  assert.throws(() => validateMessageEvidence({ profiles, rounds: 2, records, ingressResults, receiptCount: 1 }), /accepted/);
});
