const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");
const { Events, RESTEvents } = require("discord.js");
const {
  childEnvironment,
  entrypointFor,
  forceGatewayResume,
  parseArgs,
  probeRateLimit,
  validateProcessRecoveryEvidence,
  validateRateLimitEvidence,
} = require("../../scripts/phase17-discord-resilience-smoke");

const roles = ["manager", "planner", "coder", "reviewer", "qa", "summarizer"];
const profiles = roles.map((role) => ({ config: { role, instanceId: `${role}-01` }, env: {}, file: `.env.phase17/.env.${role}` }));

test("resilience smoke requires confirmation and bounded rate-limit requests", () => {
  assert.throws(() => parseArgs([]), /requires --confirm-live-discord/);
  assert.deepEqual(parseArgs(["--confirm-live-discord"]), {
    controlEnvFile: ".env",
    maxRateLimitRequests: 12,
    profiles: roles.map((role) => `.env.phase17/.env.${role}`),
    useLatestTaskChannel: false,
  });
  assert.throws(() => parseArgs(["--confirm-live-discord", "--max-rate-limit-requests", "41"]), /12 to 40/);
});

test("role child environment drops inherited plaintext tokens and conflicting profile keys", () => {
  const profile = {
    config: { role: "qa" }, file: ".env.phase17/.env.qa",
    env: { DATABASE_URL: "profile-db", BOT_ROLE: "qa", CHANNEL_TOKEN_MASTER_KEY: "profile-key" },
  };
  const env = childEnvironment(profile, {
    PATH: "/bin", DATABASE_URL: "wrong-db", BOT_ROLE: "wrong", CHANNEL_TOKEN_MASTER_KEY: "wrong-key",
    DISCORD_TOKEN: "legacy-token", CHANNEL_TOKEN: "legacy-channel-token",
  });
  assert.equal(env.PATH, "/bin");
  assert.match(env.ENV_FILE, /\.env\.phase17\/\.env\.qa$/);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.BOT_ROLE, undefined);
  assert.equal(env.CHANNEL_TOKEN_MASTER_KEY, undefined);
  assert.equal(env.DISCORD_TOKEN, undefined);
  assert.equal(env.CHANNEL_TOKEN, undefined);
  assert.equal(entrypointFor(profile), "roleBot.js");
  assert.equal(entrypointFor({ config: { role: "manager" } }), "managerBot.js");
});

test("process recovery evidence requires six new pids and final OFFLINE state", () => {
  const records = profiles.map(({ config }, index) => ({
    role: config.role,
    instanceId: config.instanceId,
    initialPid: 100 + index,
    restartPid: 200 + index,
    staleStatus: "ONLINE",
    finalStatus: "OFFLINE",
  }));
  assert.equal(validateProcessRecoveryEvidence(profiles, records), true);
  assert.throws(() => validateProcessRecoveryEvidence(profiles, records.map((record, index) => (
    index === 0 ? { ...record, restartPid: record.initialPid } : record
  ))), /invalid/);
});

test("controlled gateway resume observes reconnect and resume events", async () => {
  const client = new EventEmitter();
  client.isReady = () => true;
  client.ws = { _ws: { strategy: { shards: { first: () => ({
    async destroy() {
      client.emit(Events.ShardReconnecting, 0);
      client.emit(Events.ShardResume, 0, 0);
    },
  }) } } } };
  assert.equal(await forceGatewayResume(client), true);
});

test("rate-limit probe waits for an event and verifies a recovered request", async () => {
  const client = { rest: new EventEmitter(), isReady: () => true };
  let requests = 0;
  client.rest.get = async () => {
    requests += 1;
    if (requests === 3) client.rest.emit(RESTEvents.RateLimited, { global: false, retryAfter: 25, scope: "user" });
    return { id: "channel" };
  };
  const evidence = await probeRateLimit(client, "123456789012345678", 12);
  assert.equal(evidence.rateLimitEvents, 1);
  assert.equal(evidence.recoveredRequest, true);
});

test("rate-limit evidence requires all six roles to recover", () => {
  const records = roles.map((role) => ({
    role, rateLimitEvents: 1, maxRetryAfterMs: 10, recoveredRequest: true,
  }));
  assert.equal(validateRateLimitEvidence(profiles, records), true);
  assert.throws(() => validateRateLimitEvidence(profiles, records.slice(1)), /incomplete/);
});
