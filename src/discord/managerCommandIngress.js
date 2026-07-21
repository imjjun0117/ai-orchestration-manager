const operations = require("../controlPlane/operationsService");
const workflowService = require("../controlPlane/workflowService");

const OPS_COMMANDS = new Set(["!team", "!health", "!roles", "!instance"]);

function shouldIgnoreMessage(message, registeredBotUserIds = new Set()) {
  if (!message || !message.author) return true;
  return Boolean(
    message.author.bot
    || message.webhookId
    || message.system
    || registeredBotUserIds.has(String(message.author.id))
  );
}

function createManagerIngress({ config, db, registeredBotUserIds = new Set() }) {
  if (!config || config.role !== "manager") throw new Error("Manager ingress requires BOT_ROLE=manager");
  return async function handle(message) {
    if (shouldIgnoreMessage(message, registeredBotUserIds)) return { ignored: true, reason: "non-user-message" };
    const parsed = workflowService.parseCommand(message.content, process.env.COMMAND_PREFIX || "!");
    if (!parsed) return { ignored: true, reason: "not-a-command" };
    if (OPS_COMMANDS.has(parsed.command)) {
      const selector = parsed.request || config.instanceId;
      const output = parsed.command === "!team" ? await operations.team({ db })
        : parsed.command === "!health" ? await operations.health({ db })
          : parsed.command === "!roles" ? operations.roles()
            : await operations.instance(selector, { db });
      await db.query("SELECT * FROM enqueue_manager_notice($1,$2,$3,'OPERATIONAL_RESPONSE',$4)", [
        config.instanceId, String(message.id), String(message.channelId), output,
      ]);
      return { operational: true, command: parsed.command, queued: true };
    }
    const accepted = await workflowService.receiveCommand({
      parsed,
      sourceMessageId: String(message.id), guildId: message.guildId ? String(message.guildId) : null,
      channelId: String(message.channelId), managerInstanceId: config.instanceId,
      createdBy: String(message.author.id),
    }, { db });
    return accepted || { ignored: true, reason: "unsupported-command" };
  };
}

module.exports = { OPS_COMMANDS, createManagerIngress, shouldIgnoreMessage };
