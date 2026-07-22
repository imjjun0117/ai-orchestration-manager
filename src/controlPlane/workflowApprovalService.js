const approvalServiceDefault = require("../core/approvalService");
const workspaceWorkflowDefault = require("../workspace/taskWorkspaceWorkflowService");

const APPROVAL_COMMANDS = new Set(["!approve", "!reject"]);
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function parseApprovalCommand(parsed) {
  if (!parsed || !APPROVAL_COMMANDS.has(parsed.command)) return null;
  const request = String(parsed.request || "").trim();
  const separator = request.indexOf(" ");
  const nodeId = separator < 0 ? request : request.slice(0, separator);
  const reason = separator < 0 ? "" : request.slice(separator + 1).trim();
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error(`${parsed.command} requires a valid workflow node ID`);
  }
  if (parsed.command === "!reject" && !reason) {
    throw new Error("!reject requires a rejection reason");
  }
  return { approved: parsed.command === "!approve", nodeId, reason: reason || null };
}

async function getPendingBinding({ nodeId, discordUserId, channelId }, { db }) {
  const { rows } = await db.query(
    `SELECT a.id AS workflow_approval_id, a.workflow_run_id, a.workflow_node_id,
            a.expected_task_state, a.expected_task_version,
            r.task_id, r.workflow_definition_id, n.node_key,
            t.created_by, t.channel_id,
            NULLIF(spec.node_spec->>'next', '') IS NULL AS terminal_node
     FROM approvals a
     JOIN workflow_runs r ON r.id = a.workflow_run_id
     JOIN workflow_nodes n ON n.id = a.workflow_node_id AND n.workflow_run_id = r.id
     JOIN tasks t ON t.id = r.task_id
     JOIN workflow_definitions d ON d.id = r.workflow_definition_id
     JOIN LATERAL (
       SELECT node AS node_spec
       FROM jsonb_array_elements(d.graph_json->'nodes') node
       WHERE node->>'key' = n.node_key
     ) spec ON TRUE
     WHERE a.workflow_node_id = $1
       AND a.status = 'PENDING'
       AND r.status = 'WAITING_APPROVAL'
     ORDER BY a.id DESC
     LIMIT 1`,
    [nodeId]
  );
  const binding = rows[0];
  if (!binding) throw new Error("pending workflow approval does not exist");
  if (String(binding.created_by) !== String(discordUserId)
      || String(binding.channel_id) !== String(channelId)) {
    const error = new Error("workflow approval is restricted to the task requester in its original channel");
    error.code = "WORKFLOW_APPROVAL_FORBIDDEN";
    throw error;
  }
  return binding;
}

function candidateMatchesWorkflow(candidate, binding) {
  return Boolean(
    candidate
    && candidate.action === "commit_approval_phase16"
    && candidate.taskId === binding.task_id
    && candidate.expectedTaskState === binding.expected_task_state
    && Number(candidate.expectedTaskVersion) === Number(binding.expected_task_version)
  );
}

async function resolveApprovalCommand(
  {
    parsed,
    managerInstanceId,
    discordUserId,
    channelId,
  },
  {
    db,
    env = process.env,
    approvalService = approvalServiceDefault,
    workspaceWorkflow = workspaceWorkflowDefault,
  } = {}
) {
  if (!db || typeof db.query !== "function") throw new Error("workflow approval requires a database connection");
  const command = parseApprovalCommand(parsed);
  if (!command) return null;
  const binding = await getPendingBinding({
    nodeId: command.nodeId,
    discordUserId,
    channelId,
  }, { db });

  let candidate = null;
  let candidateResult = null;
  if (binding.terminal_node) {
    const displayed = await approvalService.getBoundApprovalDisplay({ taskId: binding.task_id }, { db });
    if (displayed && !candidateMatchesWorkflow(displayed, binding)) {
      throw new Error("bound candidate does not match the terminal workflow approval");
    }
    if (displayed) candidate = displayed;
  }

  if (candidate) {
    if (command.approved) {
      candidateResult = await workspaceWorkflow.finalizeApprovedCandidate({
        approvalId: candidate.approvalId,
        resolvedBy: String(discordUserId),
        actorId: managerInstanceId,
      }, { db, env });
    } else {
      candidateResult = await workspaceWorkflow.rejectCandidateApproval({
        approvalId: candidate.approvalId,
        resolvedBy: String(discordUserId),
        reason: command.reason,
      }, { db });
    }
    if (candidateResult.reconciliationRequired) {
      throw new Error("candidate settlement requires reconciliation before workflow approval");
    }
  }

  const { rows } = await db.query(
    "SELECT * FROM resolve_discord_workflow_approval($1,$2,$3,$4,$5,$6,$7)",
    [
      binding.workflow_run_id,
      binding.workflow_node_id,
      managerInstanceId,
      String(discordUserId),
      String(channelId),
      command.approved,
      command.reason,
    ]
  );
  if (!rows[0]) throw new Error("workflow approval did not return a workflow run");
  return {
    approved: command.approved,
    nodeId: command.nodeId,
    taskId: binding.task_id,
    workflowRun: rows[0],
    candidateSettled: Boolean(candidate),
  };
}

module.exports = {
  APPROVAL_COMMANDS,
  candidateMatchesWorkflow,
  getPendingBinding,
  parseApprovalCommand,
  resolveApprovalCommand,
};
