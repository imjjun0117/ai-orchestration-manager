#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const { Client, GatewayIntentBits } = require("discord.js");
const { Pool } = require("pg");
const { getInstanceBoundToken } = require("../src/channels/channelCredentialService");
const { loadRoleConfig, ROLES, validateSixRoleSet } = require("../src/controlPlane/roleConfig");
const { createManagerIngress } = require("../src/discord/managerCommandIngress");
const { createDiscordPublicationTransport } = require("../src/discord/discordPublicationTransport");

const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_PROFILES = ROLES.map((role) => `.env.phase17/.env.${role}`);
const MASTER_KEY_PREFIX = "CHANNEL_TOKEN_MASTER_KEY";

function parseArgs(argv) {
  let confirmed = false;
  let cleanup = true;
  let rounds = 2;
  let controlEnvFile = ".env";
  let useLatestTaskChannel = false;
  const profiles = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-live-discord") confirmed = true;
    else if (argument === "--keep-messages") cleanup = false;
    else if (argument === "--use-latest-task-channel") useLatestTaskChannel = true;
    else if (argument === "--rounds") rounds = Number.parseInt(argv[++index], 10);
    else if (argument === "--control-env") controlEnvFile = argv[++index];
    else profiles.push(argument);
  }
  if (!confirmed) throw new Error("live Discord smoke requires --confirm-live-discord");
  if (!Number.isInteger(rounds) || rounds < 2 || rounds > 5) throw new Error("--rounds must be an integer from 2 to 5");
  const selectedProfiles = profiles.length ? profiles : DEFAULT_PROFILES;
  if (selectedProfiles.length !== ROLES.length) throw new Error("exactly six role profile files are required");
  return { cleanup, controlEnvFile, profiles: selectedProfiles, rounds, useLatestTaskChannel };
}

function parseRoleProfile(contents, file = "role profile") {
  const parsed = dotenv.parse(contents);
  if (parsed.DISCORD_TOKEN || parsed.CHANNEL_TOKEN) {
    throw new Error(`${file} contains a plaintext Discord token`);
  }
  const config = loadRoleConfig(parsed);
  if (config.mode !== "shadow") throw new Error(`${file} must remain in shadow mode for this pre-Gate smoke`);
  return { config, env: parsed, file };
}

function parseControlEnv(contents) {
  const parsed = dotenv.parse(contents);
  const databaseUrl = String(parsed.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("control env file does not contain DATABASE_URL");
  return {
    channelId: String(parsed.AI_WAR_ROOM_CHANNEL_ID || "").trim(),
    databaseUrl,
  };
}

function loadInputs({ controlEnvFile, profiles, useLatestTaskChannel }, { fileSystem = fs, root = repoRoot } = {}) {
  const controlPath = path.resolve(root, controlEnvFile);
  if (!fileSystem.existsSync(controlPath)) throw new Error(`control env file not found: ${controlEnvFile}`);
  const control = parseControlEnv(fileSystem.readFileSync(controlPath));
  const channelId = control.channelId;
  if (!/^\d{17,20}$/.test(channelId) && !useLatestTaskChannel) {
    throw new Error("AI_WAR_ROOM_CHANNEL_ID must be a Discord channel ID; otherwise pass --use-latest-task-channel");
  }
  const loaded = profiles.map((file) => {
    const absolute = path.resolve(root, file);
    if (!fileSystem.existsSync(absolute)) throw new Error(`role profile not found: ${file}`);
    return parseRoleProfile(fileSystem.readFileSync(absolute), file);
  });
  validateSixRoleSet(loaded.map(({ config }) => config));
  return {
    channelId: /^\d{17,20}$/.test(channelId) ? channelId : null,
    controlDatabaseUrl: control.databaseUrl,
    profiles: loaded,
  };
}

async function resolveChannelId(inputs, options, pools) {
  if (inputs.channelId) return inputs.channelId;
  if (!options.useLatestTaskChannel) throw new Error("Discord channel selection was not authorized");
  const manager = inputs.profiles.find(({ config }) => config.role === "manager");
  const managerPool = pools.get(manager.config.instanceId);
  const { rows } = await managerPool.query(
    `SELECT channel_id, MAX(created_at) AS latest
     FROM tasks
     WHERE channel_id ~ $1
     GROUP BY channel_id
     ORDER BY latest DESC
     LIMIT 2`,
    ["^[0-9]{17,20}$"]
  );
  if (rows.length !== 1) throw new Error("latest task channel fallback requires exactly one numeric Discord channel candidate");
  return String(rows[0].channel_id);
}

async function withCredentialEnvironment(profileEnv, callback) {
  const updates = Object.entries(profileEnv).filter(([key]) => key === MASTER_KEY_PREFIX || key.startsWith(`${MASTER_KEY_PREFIX}_`));
  if (!updates.some(([key]) => key === MASTER_KEY_PREFIX)) throw new Error("role profile is missing CHANNEL_TOKEN_MASTER_KEY");
  const previous = new Map(updates.map(([key]) => [key, process.env[key]]));
  try {
    for (const [key, value] of updates) process.env[key] = value;
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validateIdentityBindings(profiles, identities, rows) {
  if (rows.length !== ROLES.length) throw new Error("DB does not contain all six bot identity bindings");
  const byInstance = new Map(rows.map((row) => [row.instance_id, row]));
  const seen = new Set();
  for (const { config } of profiles) {
    const row = byInstance.get(config.instanceId);
    const actualId = String(identities.get(config.instanceId) || "");
    if (!row || row.bot_role !== config.role || !row.discord_user_id) {
      throw new Error(`DB identity binding is incomplete for ${config.instanceId}`);
    }
    if (String(row.discord_user_id) !== actualId) throw new Error(`Discord identity does not match DB binding for ${config.instanceId}`);
    if (seen.has(actualId)) throw new Error("Discord identities must be distinct for all six roles");
    seen.add(actualId);
  }
  return true;
}

function validateMessageEvidence({ profiles, rounds, records, ingressResults, receiptCount }) {
  const expectedCount = profiles.length * rounds;
  if (records.length !== expectedCount) throw new Error(`expected ${expectedCount} Discord messages, received ${records.length}`);
  if (ingressResults.size !== expectedCount) throw new Error("Manager did not observe every live Discord smoke message");
  if (receiptCount !== 0) throw new Error("Manager accepted a bot-authored smoke command");
  for (const record of records) {
    if (String(record.sentAuthorId) !== String(record.expectedAuthorId)
      || String(record.fetchedAuthorId) !== String(record.expectedAuthorId)) {
      throw new Error(`Discord author mismatch for ${record.instanceId} round ${record.round}`);
    }
    const ingress = ingressResults.get(record.messageId);
    if (!ingress || ingress.ignored !== true || ingress.reason !== "non-user-message") {
      throw new Error(`Manager ingress did not reject bot message for ${record.instanceId} round ${record.round}`);
    }
  }
  return true;
}

async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function runLiveSmoke(options, dependencies = {}) {
  const inputs = dependencies.inputs || loadInputs(options);
  const PoolClass = dependencies.PoolClass || Pool;
  const ClientClass = dependencies.ClientClass || Client;
  const pools = new Map();
  const clients = new Map();
  const credentials = new Map();
  const records = [];
  const ingressResults = new Map();
  const cleanupErrors = [];
  const runId = crypto.randomUUID();
  const controlPool = new PoolClass({ connectionString: inputs.controlDatabaseUrl });
  let channelId;
  let verified = false;
  let failure = null;
  try {
    for (const profile of inputs.profiles) {
      const pool = new PoolClass({ connectionString: profile.config.databaseUrl });
      pools.set(profile.config.instanceId, pool);
      const token = await withCredentialEnvironment(profile.env, () => getInstanceBoundToken(
        { botInstanceId: profile.config.instanceId }, { db: pool }
      ));
      if (!token) throw new Error(`ACTIVE Discord credential is missing for ${profile.config.instanceId}`);
      credentials.set(profile.config.instanceId, token);
    }
    channelId = await resolveChannelId(inputs, options, pools);

    for (const profile of inputs.profiles) {
      const intents = profile.config.role === "manager"
        ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
        : [GatewayIntentBits.Guilds];
      const client = new ClientClass({ intents });
      clients.set(profile.config.instanceId, client);
      const token = credentials.get(profile.config.instanceId);
      await client.login(token);
      credentials.delete(profile.config.instanceId);
      if (!client.user || !client.user.id) throw new Error(`Discord identity is missing for ${profile.config.instanceId}`);
    }

    const managerProfile = inputs.profiles.find(({ config }) => config.role === "manager");
    const managerClient = clients.get(managerProfile.config.instanceId);
    const managerPool = pools.get(managerProfile.config.instanceId);
    const identities = new Map(inputs.profiles.map(({ config }) => [config.instanceId, clients.get(config.instanceId).user.id]));
    const { rows } = await managerPool.query(
      "SELECT instance_id, bot_role, discord_user_id FROM bot_instances WHERE instance_id = ANY($1) ORDER BY instance_id",
      [inputs.profiles.map(({ config }) => config.instanceId)]
    );
    validateIdentityBindings(inputs.profiles, identities, rows);
    const ingress = createManagerIngress({
      config: managerProfile.config,
      db: managerPool,
      registeredBotUserIds: new Set(identities.values()),
    });
    managerClient.on("messageCreate", (message) => {
      if (!String(message.content || "").includes(`[phase17-author-smoke:${runId}:`)) return;
      ingress(message).then((result) => ingressResults.set(String(message.id), result))
        .catch((error) => ingressResults.set(String(message.id), { error: error.message }));
    });

    const managerChannel = await managerClient.channels.fetch(channelId);
    if (!managerChannel || !managerChannel.messages || typeof managerChannel.messages.fetch !== "function") {
      throw new Error("Manager cannot fetch messages from AI_WAR_ROOM_CHANNEL_ID");
    }
    for (let round = 1; round <= options.rounds; round += 1) {
      for (const profile of inputs.profiles) {
        const client = clients.get(profile.config.instanceId);
        const transport = createDiscordPublicationTransport(client);
        const content = `!task [phase17-author-smoke:${runId}:${profile.config.role}:${round}] 역할별 Discord 발신 ID 및 Manager ingress 거부 검증 메시지입니다.`;
        const sent = await transport.send({ channelId, content });
        const fetched = await managerChannel.messages.fetch(sent.id);
        records.push({
          instanceId: profile.config.instanceId,
          round,
          messageId: String(sent.id),
          expectedAuthorId: String(client.user.id),
          sentAuthorId: String(sent.author && sent.author.id),
          fetchedAuthorId: String(fetched.author && fetched.author.id),
          message: sent,
        });
      }
    }
    await waitFor(() => ingressResults.size === records.length);
    const receipt = await controlPool.query(
      "SELECT COUNT(*)::int AS count FROM discord_event_receipts WHERE source_message_id = ANY($1)",
      [records.map(({ messageId }) => messageId)]
    );
    validateMessageEvidence({
      profiles: inputs.profiles,
      rounds: options.rounds,
      records,
      ingressResults,
      receiptCount: receipt.rows[0].count,
    });
    verified = true;
  } catch (error) {
    failure = error;
  } finally {
    if (options.cleanup) {
      for (const record of [...records].reverse()) {
        try {
          await record.message.delete();
        } catch (error) {
          cleanupErrors.push({ instanceId: record.instanceId, messageId: record.messageId, error: error.message });
        }
      }
    }
    credentials.clear();
    for (const client of clients.values()) client.destroy();
    await Promise.all([...pools.values()].map((pool) => pool.end().catch(() => {})));
    await controlPool.end().catch(() => {});
  }
  if (cleanupErrors.length) {
    throw new Error(`failed to clean up ${cleanupErrors.length} test messages${failure ? ` after: ${failure.message}` : ""}`);
  }
  if (failure) throw failure;
  if (!verified) throw new Error("live Discord author smoke did not complete");
  return {
    mode: "shadow",
    rolesVerified: inputs.profiles.length,
    rounds: options.rounds,
    messagesVerified: records.length,
    managerIgnoredBotCommands: ingressResults.size,
    discordEventReceipts: 0,
    messagesCleaned: options.cleanup ? records.length : 0,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await runLiveSmoke(options);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(`[phase17-author-smoke] ${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  DEFAULT_PROFILES,
  loadInputs,
  parseArgs,
  parseControlEnv,
  parseRoleProfile,
  resolveChannelId,
  runLiveSmoke,
  validateIdentityBindings,
  validateMessageEvidence,
  waitFor,
  withCredentialEnvironment,
};
