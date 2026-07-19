#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");
const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(repoRoot, ".env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const db = require("../src/db");
const { migrateDown, migrateUp } = require("../src/db/migrationRunner");
const { buildSubmissionManifest, hashCanonicalJson } = require("../src/delivery/canonicalSubmissionManifest");
const { importBootstrapPackage, verifyBootstrapPackage } = require("../src/delivery/deliveryBootstrapService");
const { getPhaseStatus } = require("../src/delivery/phaseService");

const phaseService = require("../src/delivery/phaseService");
const submissionService = require("../src/delivery/phaseSubmissionService");
const validationService = require("../src/delivery/phaseValidationService");
const findingService = require("../src/delivery/phaseFindingService");
const gateService = require("../src/delivery/phaseGateService");

const GOVERNANCE_MIGRATION_IDS = [
  "015_delivery_governance",
  "015_delivery_governance_security",
  "015_delivery_governance_rework",
  "015_delivery_governance_operations",
];
const CHANNEL_CREDENTIAL_MIGRATION_ID = "016_channel_credentials";
const BUNDLED_MIGRATION_IDS = [...GOVERNANCE_MIGRATION_IDS, CHANNEL_CREDENTIAL_MIGRATION_ID];

function usage() {
  console.log([
    "Usage:",
    "  node scripts/phase15-governance.js migrate",
    "  node scripts/phase15-governance.js rollback --confirm-phase15-rollback --preserve-channel-credentials",
    "  node scripts/phase15-governance.js rollback --confirm-phase15-rollback --delete-channel-credentials",
    "  node scripts/phase15-governance.js hash <manifest.json>",
    "  node scripts/phase15-governance.js hash-draft <manifest.json>",
    "  node scripts/phase15-governance.js verify-bootstrap <bootstrap-package.json>",
    "  node scripts/phase15-governance.js import-bootstrap <bootstrap-package.json>",
    "  node scripts/phase15-governance.js start <request.json>",
    "  node scripts/phase15-governance.js actor-register <request.json>",
    "  node scripts/phase15-governance.js phase-create <request.json>",
    "  node scripts/phase15-governance.js assignment-create <request.json>",
    "  node scripts/phase15-governance.js assignment-replace <request.json>",
    "  node scripts/phase15-governance.js submit <request.json>",
    "  node scripts/phase15-governance.js validation-start <request.json>",
    "  node scripts/phase15-governance.js validation-complete <request.json>",
    "  node scripts/phase15-governance.js validation-fail <request.json>",
    "  node scripts/phase15-governance.js rework <request.json>",
    "  node scripts/phase15-governance.js finding-resolve <request.json>",
    "  node scripts/phase15-governance.js debt-register <request.json>",
    "  node scripts/phase15-governance.js debt-approve <request.json>",
    "  node scripts/phase15-governance.js debt-risk-accept <request.json>",
    "  node scripts/phase15-governance.js cancel <request.json>",
    "  node scripts/phase15-governance.js gate <request.json>",
    "  node scripts/phase15-governance.js status [phase-id]",
    "",
    "Credential secrets and private signing keys must not be passed on argv.",
  ].join("\n"));
}

function readJson(inputPath) {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function requireRequest(argument, command) {
  if (!argument) throw new Error(`${command} requires a request JSON path`);
  return readJson(argument);
}

async function main() {
  const commandArgs = process.argv.slice(2);
  const [command, argument] = commandArgs;
  const flags = new Set(commandArgs.slice(1));
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "migrate") {
    const results = [];
    for (const migrationId of BUNDLED_MIGRATION_IDS) results.push(await migrateUp(migrationId));
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (command === "rollback") {
    if (!flags.has("--confirm-phase15-rollback")) {
      throw new Error("rollback requires --confirm-phase15-rollback");
    }
    const preserveChannels = flags.has("--preserve-channel-credentials");
    const deleteChannels = flags.has("--delete-channel-credentials");
    if (preserveChannels === deleteChannels) {
      throw new Error(
        "rollback requires exactly one channel boundary: --preserve-channel-credentials or --delete-channel-credentials"
      );
    }
    const rollbackIds = deleteChannels ? BUNDLED_MIGRATION_IDS : GOVERNANCE_MIGRATION_IDS;
    const results = [];
    for (const migrationId of [...rollbackIds].reverse()) {
      results.push(await migrateDown(migrationId, { allowDestructive: true }));
    }
    console.log(JSON.stringify({
      channelCredentialBoundary: preserveChannels ? "PRESERVED" : "DELETED",
      results,
      retainedMigrations: preserveChannels ? [CHANNEL_CREDENTIAL_MIGRATION_ID] : [],
    }, null, 2));
    return;
  }

  if (command === "hash") {
    if (!argument) throw new Error("hash requires a manifest JSON path");
    const manifest = buildSubmissionManifest(readJson(argument));
    console.log(JSON.stringify({ artifactBundleHash: hashCanonicalJson(manifest), manifest }, null, 2));
    return;
  }

  if (command === "hash-draft") {
    if (!argument) throw new Error("hash-draft requires a manifest JSON path");
    const manifest = buildSubmissionManifest(readJson(argument), { allowUnavailableCommits: true });
    console.log(JSON.stringify({ artifactBundleHash: hashCanonicalJson(manifest), manifest, sealed: false }, null, 2));
    return;
  }

  if (command === "verify-bootstrap") {
    if (!argument) throw new Error("verify-bootstrap requires a package JSON path");
    const repositoryRoot = process.env.DELIVERY_AUTHORITATIVE_REPOSITORY || process.env.PHASE15_AUTHORITATIVE_REPOSITORY;
    if (!repositoryRoot) throw new Error("DELIVERY_AUTHORITATIVE_REPOSITORY is required for bootstrap verification");
    const verified = verifyBootstrapPackage(readJson(argument), { repositoryRoot, requireRepositoryBinding: true });
    console.log(JSON.stringify({
      valid: true,
      submissionId: verified.submissionId,
      artifactBundleHash: verified.artifactBundleHash,
      bootstrapPackageHash: verified.bootstrapPackageHash,
      planningValidator: verified.planning.payload.validatedBy,
      developmentValidator: verified.development.payload.validatedBy,
    }, null, 2));
    return;
  }

  if (command === "import-bootstrap") {
    if (!argument) throw new Error("import-bootstrap requires a package JSON path");
    for (const migrationId of BUNDLED_MIGRATION_IDS) await migrateUp(migrationId);
    const repositoryRoot = process.env.DELIVERY_AUTHORITATIVE_REPOSITORY || process.env.PHASE15_AUTHORITATIVE_REPOSITORY;
    if (!repositoryRoot) throw new Error("DELIVERY_AUTHORITATIVE_REPOSITORY is required for bootstrap import");
    const result = await importBootstrapPackage(readJson(argument), { repositoryRoot });
    console.log(JSON.stringify({
      phaseId: result.accepted.id,
      status: result.accepted.status,
      artifactBundleHash: result.verified.artifactBundleHash,
      bootstrapPackageHash: result.verified.bootstrapPackageHash,
    }, null, 2));
    return;
  }


  const requestCommands = {
    "actor-register": phaseService.registerActor,
    "phase-create": phaseService.createPhase,
    "assignment-create": phaseService.assignActor,
    "assignment-replace": phaseService.replaceAssignment,
    start: phaseService.startPhase,
    submit: submissionService.sealSubmission,
    "validation-start": validationService.startValidation,
    "validation-complete": validationService.completeValidation,
    "validation-fail": validationService.failValidationAttempt,
    rework: phaseService.startRework,
    "finding-resolve": findingService.resolveFinding,
    "debt-register": findingService.registerDebt,
    "debt-approve": findingService.approveDebt,
    "debt-risk-accept": findingService.acceptDebtRisk,
    cancel: phaseService.cancelPhase,
    gate: gateService.gatePhase,
  };
  if (requestCommands[command]) {
    const result = await requestCommands[command](requireRequest(argument, command));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    const phaseId = argument || "phase-15";
    const status = await getPhaseStatus(phaseId);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main()
  .catch((error) => {
    console.error(`[phase15] ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
