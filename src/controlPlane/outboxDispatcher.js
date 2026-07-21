const outboxService = require("./outboxService");
const publicationService = require("./publicationService");
const workflowService = require("./workflowService");

class OutboxDispatcher {
  constructor({ config, db, transport = null, discordUserId = null, logger = console }) {
    this.config = config;
    this.db = db;
    this.transport = transport;
    this.discordUserId = discordUserId;
    this.logger = logger;
    this.running = false;
  }

  async tick() {
    if (this.running || this.config.mode === "off") return null;
    this.running = true;
    let event;
    try {
      event = await outboxService.claim({ instanceId: this.config.instanceId, leaseMs: this.config.jobLeaseMs }, { db: this.db });
      if (!event) return null;
      if (event.event_type === "ROLE_JOB_AVAILABLE") {
        return outboxService.complete({ outboxId: event.id, instanceId: this.config.instanceId, claimToken: event.claim_token }, { db: this.db });
      }
      if (event.event_type === "WORKFLOW_ADVANCE_REQUIRED") {
        if (this.config.role !== "manager") throw new Error("only Manager may advance workflows");
        await workflowService.advance({
          workflowRunId: event.payload_json.workflowRunId,
          workflowNodeId: event.payload_json.nodeId,
          managerInstanceId: this.config.instanceId,
        }, { db: this.db });
        return outboxService.complete({ outboxId: event.id, instanceId: this.config.instanceId, claimToken: event.claim_token }, { db: this.db });
      }
      if (publicationService.PUBLICATION_EVENTS.has(event.event_type)) {
        return publicationService.publish(event, {
          config: this.config, db: this.db, transport: this.transport, discordUserId: this.discordUserId,
        });
      }
      throw new Error(`unsupported outbox event type: ${event.event_type}`);
    } catch (error) {
      if (event && event.status === "DISPATCHING") {
        await outboxService.fail({
          outboxId: event.id, instanceId: this.config.instanceId, claimToken: event.claim_token,
          errorCode: error.code || "OUTBOX_DISPATCH_FAILED", errorDetail: error.message,
          uncertain: publicationService.PUBLICATION_EVENTS.has(event.event_type),
        }, { db: this.db }).catch(() => {});
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { OutboxDispatcher };
