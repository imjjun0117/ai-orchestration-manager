const operations = require("../controlPlane/operationsService");
const workflowService = require("../controlPlane/workflowService");
const workflowApprovalService = require("../controlPlane/workflowApprovalService");

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

function approvalErrorMessage(error, command) {
  const message = String(error && error.message ? error.message : "");
  if (message.includes("rejection reason")) {
    return "반려 사유가 필요합니다. 형식: !reject <node-id> <사유>";
  }
  if (message.includes("valid workflow node ID")) {
    return `${command} 명령의 node-id 형식이 올바르지 않습니다.`;
  }
  if (message.includes("pending workflow approval does not exist")) {
    return "처리할 대기 중 승인이 없거나 이미 종료되었습니다.";
  }
  if (error && error.code === "WORKFLOW_APPROVAL_FORBIDDEN") {
    return "이 승인은 작업 요청자와 원래 채널에서만 처리할 수 있습니다.";
  }
  return "승인 명령을 처리하지 못했습니다. !health로 상태를 확인한 뒤 다시 시도해 주세요.";
}

function createManagerIngress({
  config,
  db,
  registeredBotUserIds = new Set(),
  resolveApprovalCommand = workflowApprovalService.resolveApprovalCommand,
}) {
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
    if (workflowApprovalService.APPROVAL_COMMANDS.has(parsed.command)) {
      try {
        const resolved = await resolveApprovalCommand({
          parsed,
          managerInstanceId: config.instanceId,
          discordUserId: String(message.author.id),
          channelId: String(message.channelId),
        }, { db });
        const action = resolved.approved ? "승인" : "반려";
        await db.query("SELECT * FROM enqueue_manager_notice($1,$2,$3,'OPERATIONAL_RESPONSE',$4)", [
          config.instanceId,
          String(message.id),
          String(message.channelId),
          `${action} 처리했습니다. task=${resolved.taskId} node=${resolved.nodeId}`,
        ]);
        return { approval: true, command: parsed.command, queued: true, ...resolved };
      } catch (error) {
        await db.query("SELECT * FROM enqueue_manager_notice($1,$2,$3,'OPERATIONAL_RESPONSE',$4)", [
          config.instanceId,
          String(message.id),
          String(message.channelId),
          approvalErrorMessage(error, parsed.command),
        ]);
        return { approval: true, command: parsed.command, queued: true, resolved: false };
      }
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

module.exports = { OPS_COMMANDS, approvalErrorMessage, createManagerIngress, shouldIgnoreMessage };
