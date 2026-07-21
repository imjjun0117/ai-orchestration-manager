const crypto = require("node:crypto");
const dbDefault = require("../db");

const COMMAND_WORKFLOWS = Object.freeze({
  "!task": "phase17-default-v1",
  "!autotask": "phase17-default-v1",
  "!pm": "phase17-planner-v1",
  "!coder": "phase17-coder-v1",
  "!reviewer": "phase17-reviewer-v1",
  "!qa": "phase17-qa-v1",
  "!summary": "phase17-summarizer-v1",
});

function database(db) { return db || dbDefault; }
function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }

function parseCommand(content, prefix = "!") {
  const text = String(content || "").trim();
  if (!text.startsWith(prefix)) return null;
  const separator = text.indexOf(" ");
  return {
    command: (separator < 0 ? text : text.slice(0, separator)).toLowerCase(),
    request: separator < 0 ? "" : text.slice(separator + 1).trim(),
  };
}

async function receiveCommand(input, { db } = {}) {
  const parsed = input.parsed || parseCommand(input.content, input.prefix || "!");
  if (!parsed || !COMMAND_WORKFLOWS[parsed.command]) return null;
  if (!parsed.request) throw new Error(`${parsed.command} requires a request`);
  const ids = {
    correlationId: input.correlationId || id("corr"),
    taskId: input.taskId || id("task").slice(0, 50),
    workflowRunId: input.workflowRunId || id("run"),
    workflowNodeId: input.workflowNodeId || id("node"),
    roleJobId: input.roleJobId || id("job"),
  };
  const result = await database(db).query(
    `SELECT * FROM receive_discord_command($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      input.sourceMessageId, input.guildId || null, input.channelId, input.managerInstanceId,
      ids.correlationId, ids.taskId, parsed.request.slice(0, 200), parsed.request,
      input.createdBy || "discord-user", ids.workflowRunId, ids.workflowNodeId, ids.roleJobId,
      COMMAND_WORKFLOWS[parsed.command],
    ]
  );
  return { ...result.rows[0], ...ids, command: parsed.command };
}

async function advance({ workflowRunId, workflowNodeId, managerInstanceId }, { db } = {}) {
  const result = await database(db).query("SELECT * FROM advance_workflow_node($1,$2,$3)", [workflowRunId, workflowNodeId, managerInstanceId]);
  return result.rows[0];
}

async function resolveApproval({ workflowRunId, workflowNodeId, managerInstanceId, approved, reason = null }, { db } = {}) {
  const result = await database(db).query(
    "SELECT * FROM resolve_workflow_approval($1,$2,$3,$4,$5)",
    [workflowRunId, workflowNodeId, managerInstanceId, Boolean(approved), reason]
  );
  return result.rows[0];
}

module.exports = { COMMAND_WORKFLOWS, advance, parseCommand, receiveCommand, resolveApproval };
