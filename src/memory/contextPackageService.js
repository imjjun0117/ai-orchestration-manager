const crypto = require("node:crypto");
const dbDefault = require("../db");
const { canonicalJson } = require("../delivery/canonicalSubmissionManifest");
const {
  contentHash,
  detectPromptInjection,
  estimateTokens,
  frameMemoryData,
  manifestHash,
} = require("./contentAddressing");
const { loadMemoryPolicy, taskProjectKey } = require("./memoryPolicy");
const { RetrievalLimiter, rerankCandidates, selectWithinBudget } = require("./retrieval");

const POLICY_VERSION = "phase18-v1";
const limiters = new Map();

function limiterFor(policy) {
  const key = `${policy.concurrency}:${policy.queueLimit}`;
  if (!limiters.has(key)) {
    limiters.set(key, new RetrievalLimiter({ concurrency: policy.concurrency, queueLimit: policy.queueLimit }));
  }
  return limiters.get(key);
}

function truncateToTokenBudget(value, tokenBudget) {
  const maxBytes = Math.max(0, tokenBudget * 4);
  let output = "";
  let bytes = 0;
  for (const character of Array.from(String(value || ""))) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function errorCode(error) {
  const value = String(error && error.code || "MEMORY_RETRIEVAL_FAILED").trim().toUpperCase();
  return /^[A-Z0-9_]{1,80}$/.test(value) ? value : "MEMORY_RETRIEVAL_FAILED";
}

function withTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("memory retrieval exceeded its latency budget");
      error.code = "MEMORY_RETRIEVAL_TIMEOUT";
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function retrievalQuery(task, job) {
  const payload = JSON.stringify(job.payload_json || {});
  return `${task.title || ""}\n${task.original_request || ""}\n${payload}`.slice(0, 4000);
}

function metadataEntry(entry) {
  return {
    itemId: entry.itemId,
    sourceId: entry.sourceId,
    sourceVersion: Number(entry.sourceVersion),
    indexRevision: Number(entry.indexRevision || 1),
    tier: entry.tier,
    classification: entry.classification,
    contentHash: entry.contentHash,
    tokenCount: Number(entry.tokenCount),
    promptInjectionDetected: Boolean(entry.promptInjectionDetected),
    lexicalScore: Number(entry.lexicalScore || 0),
    semanticScore: Number(entry.semanticScore || 0),
    score: Number(entry.score || 0),
  };
}

function candidateEntry(row) {
  return {
    itemId: row.item_id,
    sourceId: row.source_id,
    sourceVersion: Number(row.source_version),
    indexRevision: Number(row.index_revision),
    ordinal: Number(row.ordinal),
    tier: row.tier,
    classification: row.security_classification,
    contentHash: row.content_hash,
    content: row.content_text,
    embedding_json: row.embedding_json,
    token_count: Number(row.token_count),
    tokenCount: Number(row.token_count),
    promptInjectionDetected: Boolean(row.prompt_injection_detected),
    lexical_score: Number(row.lexical_score),
    created_at: row.created_at,
  };
}

function evidenceSummary(rows) {
  const safeRows = rows.map((row) => ({
    eventId: Number(row.event_id),
    sourceId: row.source_id,
    sourceVersion: row.source_version === null ? null : Number(row.source_version),
    eventType: row.event_type,
    evidenceHash: manifestHash(row.evidence || {}),
  }));
  return {
    events: safeRows,
    staleEventCount: safeRows.filter((row) => ["SOURCE_SUPERSEDED", "INDEX_DELETED"].includes(row.eventType)).length,
    conflictEventCount: safeRows.filter((row) => row.eventType === "SOURCE_CONFLICT_DETECTED").length,
    promptInjectionEventCount: safeRows.filter((row) => row.eventType === "PROMPT_INJECTION_DETECTED").length,
  };
}

async function recordManifest({
  job,
  config,
  projectKey,
  mode,
  status,
  manifestId,
  manifest,
  manifestDigest,
  packageDigest,
  legacyDigest,
  policy,
  tokenCount,
  candidateCount,
  selectedItemCount,
  latencyMs,
  evidence,
  fallbackCode = null,
}, { db }) {
  const { rows } = await db.query(
    `SELECT * FROM record_phase18_context_manifest(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20::jsonb,$21
     )`,
    [
      config.instanceId,
      job.task_id,
      job.id,
      config.role,
      manifestId,
      projectKey,
      POLICY_VERSION,
      mode,
      status,
      manifestDigest,
      packageDigest,
      legacyDigest,
      policy.tokenBudget,
      tokenCount,
      candidateCount,
      selectedItemCount,
      latencyMs,
      JSON.stringify(manifest),
      canonicalJson(manifest),
      JSON.stringify(evidence),
      fallbackCode,
    ]
  );
  return rows[0];
}

async function tryRecordFallback({ job, config, task, legacyPrompt, policy, code, latencyMs }, { db }) {
  try {
    const projectKey = taskProjectKey(task);
    const legacyDigest = contentHash(legacyPrompt);
    const manifest = {
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
      taskId: job.task_id,
      roleJobId: job.id,
      role: config.role,
      projectKey,
      mode: policy.mode,
      status: "FALLBACK",
      queryHash: contentHash(retrievalQuery(task, job)),
      tokenBudget: policy.tokenBudget,
      tokenCount: 0,
      candidateCount: 0,
      selectionTruncated: false,
      entries: [],
      evidence: { fallbackCode: code },
    };
    const digest = manifestHash(manifest);
    await recordManifest({
      job,
      config,
      projectKey,
      mode: policy.mode,
      status: "FALLBACK",
      manifestId: `memory-manifest-${crypto.randomUUID()}`,
      manifest,
      manifestDigest: digest,
      packageDigest: contentHash(""),
      legacyDigest,
      policy,
      tokenCount: 0,
      candidateCount: 0,
      selectedItemCount: 0,
      latencyMs: Math.min(policy.retrievalTimeoutMs, Math.max(0, latencyMs)),
      evidence: { injectionItemCount: 0, staleEventCount: 0, conflictEventCount: 0, fallbackCode: code },
      fallbackCode: code,
    }, { db });
  } catch {
    // Retrieval failure must never replace the safe legacy fallback with another failure.
  }
}

async function buildRoleContext(job, config, legacyPrompt, {
  db = dbDefault,
  env = process.env,
  now = () => Date.now(),
  limiter = null,
} = {}) {
  const policy = loadMemoryPolicy(config.role, env);
  if (policy.mode === "off") {
    return {
      prompt: legacyPrompt,
      mode: "off",
      applied: false,
      fallback: false,
      manifestId: null,
      manifestHash: null,
    };
  }
  const startedAt = now();
  let task;
  try {
    const { rows: taskRows } = await db.query(
      `SELECT id, title, original_request, channel_id, memory_project_key, row_version
       FROM tasks WHERE id = $1`,
      [job.task_id]
    );
    task = taskRows[0];
    if (!task) throw new Error("memory context task does not exist");
    const projectKey = taskProjectKey(task);
    const query = retrievalQuery(task, job);
    const activeLimiter = limiter || limiterFor(policy);
    const retrieval = await activeLimiter.run(() => withTimeout(Promise.all([
      db.query(
        `SELECT * FROM retrieve_phase18_memory_candidates($1,$2,$3,$4,$5,$6)`,
        [config.instanceId, job.task_id, job.id, config.role, query, policy.candidateLimit]
      ),
      db.query(
        `SELECT * FROM inspect_phase18_memory_evidence($1,$2,$3,$4,$5)`,
        [config.instanceId, job.task_id, job.id, config.role, 100]
      ),
    ]), policy.retrievalTimeoutMs));
    const candidateRows = retrieval[0].rows || [];
    const evidenceRows = retrieval[1].rows || [];

    const shortBudget = Math.max(64, Math.floor(policy.tokenBudget * 0.20));
    const shortContent = truncateToTokenBudget(task.original_request, shortBudget);
    const shortInjection = detectPromptInjection(shortContent);
    const shortEntry = {
      itemId: `task-short:${task.id}:v${task.row_version}`,
      sourceId: `task-short:${task.id}`,
      sourceVersion: Number(task.row_version),
      indexRevision: 1,
      tier: "SHORT",
      classification: "INTERNAL",
      contentHash: contentHash(shortContent),
      content: shortContent,
      tokenCount: estimateTokens(shortContent),
      promptInjectionDetected: shortInjection.detected,
      lexicalScore: 1,
      semanticScore: 1,
      score: 1,
    };
    const ranked = rerankCandidates(query, candidateRows.map(candidateEntry), { now: now() });
    const remainingBudget = Math.max(0, policy.tokenBudget - shortEntry.tokenCount);
    const selectedResult = remainingBudget > 0
      ? selectWithinBudget(ranked, {
        tokenBudget: remainingBudget,
        selectedLimit: Math.max(1, policy.selectedLimit - 1),
      })
      : { selected: [], tokenCount: 0, truncated: ranked.length > 0 };
    const selected = [shortEntry, ...selectedResult.selected];
    const tokenCount = shortEntry.tokenCount + selectedResult.tokenCount;
    const evidence = evidenceSummary(evidenceRows);
    const injectionItemCount = selected.filter((entry) => entry.promptInjectionDetected).length;
    const status = policy.mode === "shadow" ? "SHADOW" : "APPLIED";
    const manifest = {
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
      taskId: job.task_id,
      roleJobId: job.id,
      role: config.role,
      projectKey,
      mode: policy.mode,
      status,
      queryHash: contentHash(query),
      tokenBudget: policy.tokenBudget,
      tokenCount,
      candidateCount: candidateRows.length,
      selectionTruncated: selectedResult.truncated,
      entries: selected.map(metadataEntry),
      evidence: {
        events: evidence.events,
        staleEventCount: evidence.staleEventCount,
        conflictEventCount: evidence.conflictEventCount,
        promptInjectionEventCount: evidence.promptInjectionEventCount,
      },
    };
    const manifestDigest = manifestHash(manifest);
    const packageText = frameMemoryData(selected);
    const packageDigest = contentHash(packageText);
    const legacyDigest = contentHash(legacyPrompt);
    const latencyMs = Math.min(30_000, Math.max(0, now() - startedAt));
    const manifestId = `memory-manifest-${crypto.randomUUID()}`;
    await recordManifest({
      job,
      config,
      projectKey,
      mode: policy.mode,
      status,
      manifestId,
      manifest,
      manifestDigest,
      packageDigest,
      legacyDigest,
      policy,
      tokenCount,
      candidateCount: candidateRows.length,
      selectedItemCount: selected.length,
      latencyMs,
      evidence: {
        injectionItemCount,
        staleEventCount: evidence.staleEventCount,
        conflictEventCount: evidence.conflictEventCount,
        promptInjectionEventCount: evidence.promptInjectionEventCount,
      },
    }, { db });
    return {
      prompt: policy.mode === "enforced" ? `${legacyPrompt}\n\n${packageText}` : legacyPrompt,
      mode: policy.mode,
      applied: policy.mode === "enforced",
      fallback: false,
      manifestId,
      manifestHash: manifestDigest,
      packageHash: packageDigest,
      tokenCount,
      selectedItemCount: selected.length,
    };
  } catch (error) {
    const code = errorCode(error);
    if (task) {
      await tryRecordFallback({
        job,
        config,
        task,
        legacyPrompt,
        policy,
        code,
        latencyMs: now() - startedAt,
      }, { db });
    }
    return {
      prompt: legacyPrompt,
      mode: policy.mode,
      applied: false,
      fallback: true,
      fallbackCode: code,
      manifestId: null,
      manifestHash: null,
    };
  }
}

async function replayContextManifest(manifestId, { db = dbDefault } = {}) {
  const { rows } = await db.query("SELECT * FROM replay_phase18_context_manifest($1)", [manifestId]);
  const row = rows[0];
  if (!row) throw new Error("context manifest replay returned no result");
  const recomputed = manifestHash(row.manifest_json);
  if (recomputed !== row.manifest_hash) throw new Error("context manifest replay hash mismatch");
  return {
    manifestHash: row.manifest_hash,
    manifest: row.manifest_json,
    sourceItemsAvailable: Boolean(row.source_items_available),
  };
}

async function shadowQuality({ minimumReports = 5, db = dbDefault } = {}) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS reports,
            COUNT(DISTINCT role)::int AS covered_roles,
            COUNT(DISTINCT role) FILTER (WHERE selection.non_short_items > 0)::int AS memory_roles,
            COUNT(*) FILTER (WHERE status = 'FALLBACK')::int AS fallbacks,
            COALESCE(MAX(retrieval_latency_ms), 0)::int AS max_latency_ms,
            COALESCE(SUM(selection.non_short_items), 0)::int AS non_short_selected_items
     FROM memory_context_manifests manifest
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS non_short_items
       FROM jsonb_array_elements(manifest.manifest_json->'entries') entry
       WHERE entry->>'tier' <> 'SHORT'
     ) selection
     WHERE mode = 'shadow'`
  );
  const result = rows[0] || {
    reports: 0, covered_roles: 0, memory_roles: 0, fallbacks: 0,
    max_latency_ms: 0, non_short_selected_items: 0,
  };
  return {
    ...result,
    ready: Number(result.reports) >= minimumReports
      && Number(result.covered_roles) >= 5
      && Number(result.memory_roles) >= 5
      && Number(result.fallbacks) === 0
      && Number(result.non_short_selected_items) >= minimumReports,
  };
}

module.exports = {
  POLICY_VERSION,
  buildRoleContext,
  candidateEntry,
  evidenceSummary,
  replayContextManifest,
  shadowQuality,
  truncateToTokenBudget,
  withTimeout,
};
