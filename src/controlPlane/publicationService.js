const crypto = require("node:crypto");
const outboxService = require("./outboxService");

const PUBLICATION_EVENTS = new Set(["COMMAND_ACCEPTED", "OPERATIONAL_RESPONSE", "ROLE_RESULT_PUBLICATION", "APPROVAL_REQUIRED", "WORKFLOW_SUCCEEDED"]);

function markerFor(event) {
  return `ai-manager:${event.correlation_id}:${event.id}`;
}

function render(event, marker) {
  const payload = event.payload_json || {};
  const result = payload.result || {};
  const body = typeof result.text === "string"
    ? result.text
    : event.event_type === "COMMAND_ACCEPTED"
      ? `작업을 접수했습니다. task=${payload.taskId}`
      : event.event_type === "APPROVAL_REQUIRED"
      ? `승인이 필요합니다. task=${payload.taskId} node=${payload.nodeId}`
      : event.event_type === "WORKFLOW_SUCCEEDED"
        ? `작업이 완료되었습니다. task=${payload.taskId}`
        : JSON.stringify(result);
  return `${String(body || event.event_type).slice(0, 1800)}\n\n[${marker}]`;
}

async function withTransaction(db, callback) {
  const connectionPool = typeof db?.connect === "function" ? db : db?.pool;
  if (!connectionPool || typeof connectionPool.connect !== "function") {
    throw new Error("publication transaction requires a database pool");
  }
  const client = await connectionPool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ensurePublication(event, status, { db }) {
  const payload = event.payload_json || {};
  const marker = markerFor(event);
  const publicationKey = `${payload.taskId || event.aggregate_id}:${payload.nodeId || event.aggregate_id}:${event.event_type}`;
  let channelId = payload.channelId || null;
  if (!channelId && payload.taskId) {
    const channel = await db.query("SELECT channel_id FROM tasks WHERE id = $1", [payload.taskId]);
    channelId = channel.rows[0] && channel.rows[0].channel_id;
  }
  if (!channelId) throw new Error("publication channel binding was not found");
  const { rows } = await db.query(
    `INSERT INTO discord_publications(
       id, outbox_event_id, task_id, workflow_run_id, workflow_node_id,
       publication_key, target_role, target_instance_id, channel_id,
       correlation_marker, status
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (publication_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      `publication-${crypto.randomUUID()}`, event.id, payload.taskId || null,
      payload.workflowRunId || null, payload.nodeId || null, publicationKey,
      event.target_role || "manager", event.target_instance_id || null, channelId, marker, status,
    ]
  );
  if (!rows[0]) throw new Error("publication binding was not found");
  return rows[0];
}

async function suppressPublication(event, { config, db }) {
  return withTransaction(db, async (client) => {
    const publication = await ensurePublication(event, "SHADOWED", { db: client });
    await outboxService.suppress({ outboxId: event.id, instanceId: config.instanceId, claimToken: event.claim_token }, { db: client });
    return publication;
  });
}

async function publish(event, { config, db, transport, discordUserId }) {
  if (!PUBLICATION_EVENTS.has(event.event_type)) throw new Error(`event ${event.event_type} is not publishable`);
  if (config.mode === "shadow") return suppressPublication(event, { config, db });
  if (config.mode !== "enforced") throw new Error(`publication is unavailable in ${config.mode} mode`);
  if (!transport || typeof transport.send !== "function" || typeof transport.findByMarker !== "function") {
    throw new Error("Discord publication transport is incomplete");
  }
  const publication = await ensurePublication(event, "DISPATCHING", { db });
  if (publication.outbox_event_id !== event.id) {
    if (config.mode === "shadow") {
      await outboxService.suppress({ outboxId: event.id, instanceId: config.instanceId, claimToken: event.claim_token }, { db });
    } else {
      await outboxService.complete({ outboxId: event.id, instanceId: config.instanceId, claimToken: event.claim_token }, { db });
    }
    return publication;
  }
  if (publication.status === "POSTED") {
    await outboxService.complete({ outboxId: event.id, instanceId: config.instanceId, claimToken: event.claim_token }, { db });
    return publication;
  }
  if (publication.status === "SHADOWED") {
    await outboxService.suppress({ outboxId: event.id, instanceId: config.instanceId, claimToken: event.claim_token }, { db });
    return publication;
  }
  const matches = await transport.findByMarker({
    channelId: publication.channel_id,
    marker: publication.correlation_marker,
    authorId: discordUserId,
  });
  if (matches.length > 1) {
    await outboxService.fail({
      outboxId: event.id, instanceId: config.instanceId, claimToken: event.claim_token,
      errorCode: "PUBLICATION_MARKER_AMBIGUOUS", errorDetail: "multiple matching role publications", uncertain: true,
    }, { db });
    throw new Error("publication marker reconciliation is ambiguous");
  }
  let messageId = matches[0] && matches[0].id;
  if (!messageId) {
    const sent = await transport.send({
      channelId: publication.channel_id,
      content: render(event, publication.correlation_marker),
    });
    messageId = sent.id;
  }
  return withTransaction(db, async (client) => {
    const { rows } = await client.query(
      `UPDATE discord_publications SET status = 'POSTED', discord_message_id = $2,
              posted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN ('DISPATCHING','PENDING') RETURNING *`,
      [publication.id, messageId]
    );
    if (!rows[0]) throw new Error("publication acknowledgement was rejected");
    await outboxService.complete({ outboxId: event.id, instanceId: config.instanceId, claimToken: event.claim_token }, { db: client });
    return rows[0];
  });
}

module.exports = { PUBLICATION_EVENTS, markerFor, publish, render, suppressPublication };
