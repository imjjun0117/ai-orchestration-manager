const roleJobService = require("./roleJobService");

class RoleWorker {
  constructor({ config, db, executeJob, logger = console }) {
    if (!config || config.role === "manager") throw new Error("RoleWorker requires a non-manager role config");
    if (typeof executeJob !== "function") throw new Error("RoleWorker requires executeJob");
    this.config = config;
    this.db = db;
    this.executeJob = executeJob;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  async tick() {
    if (this.running || this.config.executionMode === "disabled") return null;
    this.running = true;
    let job;
    try {
      job = await roleJobService.claim({ instanceId: this.config.instanceId, leaseMs: this.config.jobLeaseMs }, { db: this.db });
      if (!job) return null;
      const heartbeat = setInterval(() => {
        roleJobService.heartbeat({
          jobId: job.id, instanceId: this.config.instanceId,
          claimToken: job.claim_token, leaseMs: this.config.jobLeaseMs,
        }, { db: this.db }).catch((error) => this.logger.error(`[role-worker] heartbeat failed: ${error.message}`));
      }, Math.max(1_000, Math.floor(this.config.jobLeaseMs / 3)));
      heartbeat.unref?.();
      try {
        const output = await this.executeJob(job, this.config, { db: this.db });
        return await roleJobService.complete({
          jobId: job.id, instanceId: this.config.instanceId, claimToken: job.claim_token,
          inputArtifactHash: job.input_artifact_hash, outputArtifactId: output.outputArtifactId,
          result: output.result || {},
        }, { db: this.db });
      } catch (error) {
        return await roleJobService.fail({
          jobId: job.id, instanceId: this.config.instanceId, claimToken: job.claim_token,
          errorCode: error.code || "ROLE_EXECUTION_FAILED", errorDetail: error.message,
          sideEffectUncertain: configRoleMayWrite(this.config.role),
        }, { db: this.db });
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error(`[role-worker] ${error.message}`)), this.config.jobPollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function configRoleMayWrite(role) {
  return role === "coder" || role === "qa";
}

module.exports = { RoleWorker, configRoleMayWrite };
