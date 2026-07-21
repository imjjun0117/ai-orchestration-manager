const { Client, GatewayIntentBits } = require("discord.js");
const db = require("../db");
const { revokeInstanceBoundToken } = require("../channels/channelCredentialService");
const { resolveRuntimeCredential } = require("../channels/runtimeCredentialEnrollment");
const { createDiscordPublicationTransport } = require("../discord/discordPublicationTransport");
const { assertRoleModeAllowed } = require("./featureFlags");
const instanceService = require("./instanceService");
const { OutboxDispatcher } = require("./outboxDispatcher");

function createClient(role) {
  const intents = role === "manager"
    ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    : [GatewayIntentBits.Guilds];
  return new Client({ intents });
}

function invalidDiscordToken(error) {
  return error && (
    error.code === "TokenInvalid"
    || error.name === "TokenInvalid"
    || /invalid token/i.test(String(error.message || ""))
  );
}

async function bootRuntime(config, {
  client = createClient(config.role),
  database = db,
  resolveCredential = resolveRuntimeCredential,
  revokeCredential = revokeInstanceBoundToken,
} = {}) {
  await assertRoleModeAllowed({ db: database });
  if (config.mode === "off") throw new Error("role bot entrypoints require MULTIBOT_ROLE_MODE=shadow|enforced");
  let registered = false;
  let identity;
  try {
    await instanceService.register(config, {}, { db: database });
    registered = true;
    const credential = await resolveCredential(config, { db: database });
    try {
      await client.login(credential.token);
    } catch (error) {
      if (invalidDiscordToken(error)) {
        await revokeCredential({
          botInstanceId: config.instanceId,
          reason: "Discord rejected runtime credential",
        }, { db: database });
        throw new Error(`Discord rejected the token for ${config.instanceId}; the DB credential was revoked. Run the node again to enroll a replacement`, { cause: error });
      }
      throw error;
    }
    if (!client.user) throw new Error("Discord login completed without a user identity");
    identity = {
      discordUserId: client.user.id,
      discordApplicationId: client.application && client.application.id,
    };
    await instanceService.register(config, identity, { db: database });
  } catch (error) {
    if (registered) await instanceService.offline(config.instanceId, { db: database }).catch(() => {});
    client.destroy();
    throw error;
  }
  const transport = createDiscordPublicationTransport(client);
  const outbox = new OutboxDispatcher({
    config, db: database, transport, discordUserId: identity.discordUserId,
  });
  const heartbeatTimer = setInterval(() => instanceService.heartbeat({
    instanceId: config.instanceId, status: null,
    cliHealth: { executionMode: config.executionMode }, workspaceHealth: {},
  }, { db: database }).catch((error) => console.error(`[${config.instanceId}] heartbeat: ${error.message}`)), config.heartbeatMs);
  heartbeatTimer.unref?.();
  const outboxTimer = setInterval(() => outbox.tick().catch((error) => console.error(`[${config.instanceId}] outbox: ${error.message}`)), config.jobPollMs);
  outboxTimer.unref?.();
  return {
    client, database, identity, outbox,
    async stop() {
      clearInterval(heartbeatTimer);
      clearInterval(outboxTimer);
      await instanceService.offline(config.instanceId, { db: database }).catch(() => {});
      client.destroy();
      if (database.pool && typeof database.pool.end === "function") await database.pool.end();
    },
  };
}

module.exports = { bootRuntime, createClient, invalidDiscordToken };
