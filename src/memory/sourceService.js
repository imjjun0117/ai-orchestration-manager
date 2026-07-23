const dbDefault = require("../db");
const {
  MEMORY_TIERS,
  RETRIEVAL_ROLES,
  SECURITY_CLASSIFICATIONS,
  normalizedIdentifier,
} = require("./memoryPolicy");
const {
  chunkContent,
  contentHash,
  detectPromptInjection,
  manifestHash,
} = require("./contentAddressing");

const DEFAULT_RETENTION_DAYS = Object.freeze({ LONG: 365, EPISODIC: 30, SHORT: 7 });

function plainObject(name, value, fallback = {}) {
  const candidate = value === undefined ? fallback : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`${name} must be an object`);
  }
  return candidate;
}

function normalizedRoles(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("allowedRoles must be a non-empty array");
  const roles = [...new Set(values.map((value) => String(value || "").trim().toLowerCase()))].sort();
  for (const role of roles) if (!RETRIEVAL_ROLES.includes(role)) throw new Error(`unsupported memory ACL role: ${role}`);
  return roles;
}

function normalizedProvenance(values, tier) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new Error("derivedFrom must be an array");
  if (values.length > 0 && tier !== "EPISODIC") throw new Error("only EPISODIC memory may declare derived provenance");
  return values.map((entry) => {
    const sourceId = normalizedIdentifier("derived sourceId", entry && entry.sourceId, 160);
    const sourceVersion = Number(entry && entry.sourceVersion);
    if (!Number.isInteger(sourceVersion) || sourceVersion < 1) throw new Error("derived sourceVersion must be positive");
    const itemId = entry && entry.itemId ? normalizedIdentifier("derived itemId", entry.itemId, 240) : null;
    return { sourceId, sourceVersion, itemId };
  }).sort((left, right) => (
    left.sourceId.localeCompare(right.sourceId)
    || left.sourceVersion - right.sourceVersion
    || String(left.itemId || "").localeCompare(String(right.itemId || ""))
  ));
}

function buildIngestionPlan(input, {
  now = new Date(),
  maxTokens = 512,
  overlapTokens = 48,
} = {}) {
  const sourceId = normalizedIdentifier("sourceId", input && input.sourceId, 160);
  const projectKey = normalizedIdentifier("projectKey", input && input.projectKey, 200);
  const ownerRef = normalizedIdentifier("ownerRef", input && input.ownerRef, 160);
  const tier = String(input && input.tier || "").trim().toUpperCase();
  if (!MEMORY_TIERS.includes(tier)) throw new Error(`tier must be one of: ${MEMORY_TIERS.join(", ")}`);
  const classification = String(input && input.classification || "INTERNAL").trim().toUpperCase();
  if (!SECURITY_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`classification must be one of: ${SECURITY_CLASSIFICATIONS.join(", ")}`);
  }
  const content = String(input && input.content || "").trim();
  const sourceContentHash = contentHash(content);
  const retentionDays = Number(input && input.retentionDays === undefined
    ? DEFAULT_RETENTION_DAYS[tier]
    : input.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new Error("retentionDays must be an integer between 1 and 3650");
  }
  const allowedRoles = normalizedRoles(input && input.allowedRoles);
  const conflictKey = input && input.conflictKey
    ? normalizedIdentifier("conflictKey", input.conflictKey, 160)
    : null;
  const taskId = input && input.taskId ? normalizedIdentifier("taskId", input.taskId, 50) : null;
  const metadata = plainObject("metadata", input && input.metadata, {});
  const provenance = normalizedProvenance(input && input.derivedFrom, tier);
  const injection = detectPromptInjection(content);
  const chunks = chunkContent(content, { maxTokens, overlapTokens }).map((chunk) => ({
    ...chunk,
    promptInjectionDetected: injection.detected,
    promptInjectionRuleIds: injection.ruleIds,
  }));
  const expiresAt = new Date(now.getTime() + (retentionDays * 86_400_000)).toISOString();
  const ingestionHash = manifestHash({
    schemaVersion: 1,
    sourceId,
    projectKey,
    taskId,
    ownerRef,
    tier,
    classification,
    sourceContentHash,
    retentionDays,
    allowedRoles,
    conflictKey,
    metadata,
    provenance,
  });
  return {
    sourceId,
    projectKey,
    taskId,
    ownerRef,
    tier,
    classification,
    content,
    sourceContentHash,
    ingestionHash,
    retentionDays,
    expiresAt,
    allowedRoles,
    conflictKey,
    metadata,
    provenance,
    injection,
    chunks,
  };
}

async function withTransaction(database, operation) {
  const pool = database.pool || database;
  if (!pool || typeof pool.connect !== "function") throw new Error("memory mutation requires a database pool");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function insertMemoryEvent(client, {
  sourceId,
  sourceVersion = null,
  itemId = null,
  eventType,
  payload = {},
  actorRef,
}) {
  await client.query(
    `INSERT INTO memory_events(source_id, source_version, item_id, event_type, event_payload, actor_ref)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [sourceId, sourceVersion, itemId, eventType, JSON.stringify(payload), actorRef]
  );
}

async function reconcileConflictGroup(client, { projectKey, conflictKey, actorRef, focusSourceId = null }) {
  if (!conflictKey) return { conflict: false, sourceIds: [] };
  const { rows } = await client.query(
    `SELECT id, current_version, current_content_hash, conflict_state
     FROM memory_sources
     WHERE project_key = $1 AND conflict_key = $2 AND status = 'ACTIVE'
     ORDER BY id FOR UPDATE`,
    [projectKey, conflictKey]
  );
  const sourceIds = rows.map((row) => row.id);
  const conflict = new Set(rows.map((row) => row.current_content_hash)).size > 1;
  const nextState = conflict ? "CONFLICT" : "CLEAR";
  await client.query(
    `UPDATE memory_sources SET conflict_state = $3, updated_at = CURRENT_TIMESTAMP
     WHERE project_key = $1 AND conflict_key = $2 AND status = 'ACTIVE'`,
    [projectKey, conflictKey, nextState]
  );
  const changed = rows.filter((row) => row.conflict_state !== nextState);
  for (const row of changed) {
    await insertMemoryEvent(client, {
      sourceId: row.id,
      sourceVersion: Number(row.current_version),
      eventType: conflict ? "SOURCE_CONFLICT_DETECTED" : "SOURCE_CONFLICT_RESOLVED",
      actorRef,
      payload: {
        conflictKey,
        conflictingSourceIds: conflict ? sourceIds.filter((id) => id !== row.id) : [],
        focusSourceId,
      },
    });
  }
  return { conflict, sourceIds };
}

async function writeChunks(client, plan, sourceVersion, indexRevision = 1) {
  for (const chunk of plan.chunks) {
    const itemId = `${plan.sourceId}:v${sourceVersion}:r${indexRevision}:i${chunk.ordinal}`;
    await client.query(
      `INSERT INTO memory_items(
         id, source_id, source_version, index_revision, tier, ordinal, content_hash, content_text,
         embedding_json, token_count, prompt_injection_detected, prompt_injection_rule_ids
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb)`,
      [
        itemId,
        plan.sourceId,
        sourceVersion,
        indexRevision,
        plan.tier,
        chunk.ordinal,
        chunk.contentHash,
        chunk.content,
        JSON.stringify(chunk.embedding),
        chunk.tokenCount,
        chunk.promptInjectionDetected,
        JSON.stringify(chunk.promptInjectionRuleIds),
      ]
    );
  }
}

async function ingestMemorySource(input, {
  db = dbDefault,
  now = new Date(),
  maxTokens = 512,
  overlapTokens = 48,
} = {}) {
  const plan = buildIngestionPlan(input, { now, maxTokens, overlapTokens });
  return withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('phase18-memory-mutation'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phase18-source:${plan.sourceId}`]);
    const { rows: sourceRows } = await client.query(
      "SELECT * FROM memory_sources WHERE id = $1 FOR UPDATE",
      [plan.sourceId]
    );
    const existing = sourceRows[0] || null;
    if (existing) {
      for (const [field, expected] of [
        ["project_key", plan.projectKey],
        ["tier", plan.tier],
        ["owner_ref", plan.ownerRef],
      ]) {
        if (String(existing[field]) !== String(expected)) {
          throw new Error(`memory source ${field} is immutable`);
        }
      }
      if (existing.status === "DELETED") throw new Error("deleted memory sources cannot be reactivated");
      const { rows: currentRows } = await client.query(
        `SELECT ingestion_hash FROM memory_source_versions
         WHERE source_id = $1 AND source_version = $2`,
        [plan.sourceId, existing.current_version]
      );
      if (currentRows[0] && currentRows[0].ingestion_hash === plan.ingestionHash) {
        return {
          sourceId: plan.sourceId,
          sourceVersion: Number(existing.current_version),
          sourceContentHash: plan.sourceContentHash,
          ingestionHash: plan.ingestionHash,
          chunks: plan.chunks.length,
          idempotent: true,
          promptInjectionDetected: plan.injection.detected,
        };
      }
    }

    const sourceVersion = existing ? Number(existing.current_version) + 1 : 1;
    if (existing) {
      await client.query(
        `UPDATE memory_source_versions SET status = 'SUPERSEDED', superseded_at = CURRENT_TIMESTAMP
         WHERE source_id = $1 AND source_version = $2 AND status = 'ACTIVE'`,
        [plan.sourceId, existing.current_version]
      );
      await client.query(
        `UPDATE memory_items SET status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP
         WHERE source_id = $1 AND source_version = $2 AND status = 'ACTIVE'`,
        [plan.sourceId, existing.current_version]
      );
      await insertMemoryEvent(client, {
        sourceId: plan.sourceId,
        sourceVersion: Number(existing.current_version),
        eventType: "SOURCE_SUPERSEDED",
        actorRef: plan.ownerRef,
        payload: { replacedByVersion: sourceVersion, previousContentHash: existing.current_content_hash },
      });
    }

    await client.query(
      `INSERT INTO memory_sources(
         id, project_key, task_id, tier, owner_ref, security_classification,
         retention_days, expires_at, current_version, current_content_hash,
         status, conflict_key, conflict_state, metadata_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,'CLEAR',$12::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         task_id = EXCLUDED.task_id,
         security_classification = EXCLUDED.security_classification,
         retention_days = EXCLUDED.retention_days,
         expires_at = EXCLUDED.expires_at,
         current_version = EXCLUDED.current_version,
         current_content_hash = EXCLUDED.current_content_hash,
         conflict_key = EXCLUDED.conflict_key,
         conflict_state = 'CLEAR',
         metadata_json = EXCLUDED.metadata_json,
         updated_at = CURRENT_TIMESTAMP`,
      [
        plan.sourceId,
        plan.projectKey,
        plan.taskId,
        plan.tier,
        plan.ownerRef,
        plan.classification,
        plan.retentionDays,
        plan.expiresAt,
        sourceVersion,
        plan.sourceContentHash,
        plan.conflictKey,
        JSON.stringify(plan.metadata),
      ]
    );
    await client.query(
      `INSERT INTO memory_source_versions(
         source_id, source_version, content_hash, ingestion_hash, content_text,
         prompt_injection_detected, prompt_injection_rule_ids, metadata_json, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [
        plan.sourceId,
        sourceVersion,
        plan.sourceContentHash,
        plan.ingestionHash,
        plan.content,
        plan.injection.detected,
        JSON.stringify(plan.injection.ruleIds),
        JSON.stringify(plan.metadata),
        plan.ownerRef,
      ]
    );

    await client.query("DELETE FROM memory_source_acl WHERE source_id = $1", [plan.sourceId]);
    for (const role of plan.allowedRoles) {
      await client.query(
        "INSERT INTO memory_source_acl(source_id, role, granted_by) VALUES ($1,$2,$3)",
        [plan.sourceId, role, plan.ownerRef]
      );
    }

    await client.query("DELETE FROM memory_provenance_edges WHERE derived_source_id = $1", [plan.sourceId]);
    for (const edge of plan.provenance) {
      const { rows: provenanceRows } = await client.query(
        `SELECT 1 FROM memory_source_versions
         WHERE source_id = $1 AND source_version = $2`,
        [edge.sourceId, edge.sourceVersion]
      );
      if (!provenanceRows[0]) throw new Error(`provenance source version does not exist: ${edge.sourceId}@${edge.sourceVersion}`);
      if (edge.itemId) {
        const { rows: itemRows } = await client.query(
          `SELECT 1 FROM memory_items
           WHERE id = $1 AND source_id = $2 AND source_version = $3`,
          [edge.itemId, edge.sourceId, edge.sourceVersion]
        );
        if (!itemRows[0]) throw new Error(`provenance item does not match its source version: ${edge.itemId}`);
      }
      await client.query(
        `INSERT INTO memory_provenance_edges(
           derived_source_id, source_id, source_version, source_item_id
         ) VALUES ($1,$2,$3,$4)`,
        [plan.sourceId, edge.sourceId, edge.sourceVersion, edge.itemId]
      );
    }

    await writeChunks(client, plan, sourceVersion, 1);
    await insertMemoryEvent(client, {
      sourceId: plan.sourceId,
      sourceVersion,
      eventType: "SOURCE_INGESTED",
      actorRef: plan.ownerRef,
      payload: {
        tier: plan.tier,
        classification: plan.classification,
        contentHash: plan.sourceContentHash,
        ingestionHash: plan.ingestionHash,
        chunkCount: plan.chunks.length,
        allowedRoles: plan.allowedRoles,
      },
    });
    if (plan.injection.detected) {
      await insertMemoryEvent(client, {
        sourceId: plan.sourceId,
        sourceVersion,
        eventType: "PROMPT_INJECTION_DETECTED",
        actorRef: plan.ownerRef,
        payload: { contentHash: plan.sourceContentHash, ruleIds: plan.injection.ruleIds, handling: "DATA_ONLY" },
      });
    }

    if (existing && existing.conflict_key && existing.conflict_key !== plan.conflictKey) {
      await reconcileConflictGroup(client, {
        projectKey: plan.projectKey,
        conflictKey: existing.conflict_key,
        actorRef: plan.ownerRef,
        focusSourceId: plan.sourceId,
      });
    }
    const conflictResult = await reconcileConflictGroup(client, {
      projectKey: plan.projectKey,
      conflictKey: plan.conflictKey,
      actorRef: plan.ownerRef,
      focusSourceId: plan.sourceId,
    });

    return {
      sourceId: plan.sourceId,
      sourceVersion,
      sourceContentHash: plan.sourceContentHash,
      ingestionHash: plan.ingestionHash,
      chunks: plan.chunks.length,
      idempotent: false,
      promptInjectionDetected: plan.injection.detected,
      conflictDetected: conflictResult.conflict,
    };
  });
}

async function deleteMemorySource({ sourceId, actorRef, indexOnly = false, reason }, { db = dbDefault } = {}) {
  const normalizedSourceId = normalizedIdentifier("sourceId", sourceId, 160);
  const normalizedActor = normalizedIdentifier("actorRef", actorRef, 160);
  const normalizedReason = String(reason || "").trim();
  if (normalizedReason.length < 8 || normalizedReason.length > 500) throw new Error("deletion reason must be 8-500 characters");
  return withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('phase18-memory-mutation'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phase18-source:${normalizedSourceId}`]);
    const { rows } = await client.query("SELECT * FROM memory_sources WHERE id = $1 FOR UPDATE", [normalizedSourceId]);
    const source = rows[0];
    if (!source) throw new Error("memory source does not exist");
    if (indexOnly) {
      const result = await client.query(
        `UPDATE memory_items
         SET status = 'DELETED', content_text = NULL, embedding_json = '[]'::jsonb, deleted_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE source_id = $1 AND status <> 'DELETED'`,
        [normalizedSourceId]
      );
      await insertMemoryEvent(client, {
        sourceId: normalizedSourceId,
        sourceVersion: Number(source.current_version),
        eventType: "INDEX_DELETED",
        actorRef: normalizedActor,
        payload: { reason: normalizedReason, deletedItemCount: result.rowCount },
      });
      return { sourceId: normalizedSourceId, scope: "INDEX_ONLY", affectedSources: 1, affectedItems: result.rowCount };
    }

    const { rows: affectedRows } = await client.query(
      `WITH RECURSIVE affected(id) AS (
         SELECT $1::text
         UNION
         SELECT edge.derived_source_id
         FROM memory_provenance_edges edge
         JOIN affected parent ON parent.id = edge.source_id
       )
       SELECT id FROM affected ORDER BY id`,
      [normalizedSourceId]
    );
    const affectedIds = affectedRows.map((row) => row.id);
    const { rows: conflictGroups } = await client.query(
      `SELECT DISTINCT project_key, conflict_key
       FROM memory_sources WHERE id = ANY($1) AND conflict_key IS NOT NULL`,
      [affectedIds]
    );
    const versionResult = await client.query(
      `UPDATE memory_source_versions
       SET status = 'DELETED', content_text = NULL, deleted_at = CURRENT_TIMESTAMP
       WHERE source_id = ANY($1) AND status <> 'DELETED'`,
      [affectedIds]
    );
    const itemResult = await client.query(
      `UPDATE memory_items
       SET status = 'DELETED', content_text = NULL, embedding_json = '[]'::jsonb,
           deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE source_id = ANY($1) AND status <> 'DELETED'`,
      [affectedIds]
    );
    await client.query(
      `UPDATE memory_sources
       SET status = 'DELETED', deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1) AND status <> 'DELETED'`,
      [affectedIds]
    );
    for (const affectedSourceId of affectedIds) {
      await insertMemoryEvent(client, {
        sourceId: affectedSourceId,
        sourceVersion: affectedSourceId === normalizedSourceId ? Number(source.current_version) : null,
        eventType: affectedSourceId === normalizedSourceId ? "SOURCE_DELETED" : "DERIVED_SOURCE_DELETED",
        actorRef: normalizedActor,
        payload: { reason: normalizedReason, rootSourceId: normalizedSourceId },
      });
    }
    for (const group of conflictGroups) {
      await reconcileConflictGroup(client, {
        projectKey: group.project_key,
        conflictKey: group.conflict_key,
        actorRef: normalizedActor,
        focusSourceId: normalizedSourceId,
      });
    }
    return {
      sourceId: normalizedSourceId,
      scope: "SOURCE_AND_DERIVED",
      affectedSources: affectedIds.length,
      affectedVersions: versionResult.rowCount,
      affectedItems: itemResult.rowCount,
    };
  });
}

async function rebuildMemoryIndex({ sourceId, actorRef }, {
  db = dbDefault,
  maxTokens = 512,
  overlapTokens = 48,
} = {}) {
  const normalizedSourceId = normalizedIdentifier("sourceId", sourceId, 160);
  const normalizedActor = normalizedIdentifier("actorRef", actorRef, 160);
  return withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('phase18-memory-mutation'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phase18-source:${normalizedSourceId}`]);
    const { rows } = await client.query(
      `SELECT s.*, v.content_text, v.prompt_injection_detected, v.prompt_injection_rule_ids
       FROM memory_sources s
       JOIN memory_source_versions v
         ON v.source_id = s.id AND v.source_version = s.current_version
       WHERE s.id = $1 AND s.status = 'ACTIVE' AND v.status = 'ACTIVE'
       FOR UPDATE OF s, v`,
      [normalizedSourceId]
    );
    const source = rows[0];
    if (!source || !source.content_text) throw new Error("active source content is unavailable for index rebuild");
    const chunks = chunkContent(source.content_text, { maxTokens, overlapTokens });
    await client.query(
      `UPDATE memory_items
       SET status = 'DELETED', content_text = NULL, embedding_json = '[]'::jsonb,
           deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE source_id = $1 AND source_version = $2 AND status <> 'DELETED'`,
      [source.id, source.current_version]
    );
    const { rows: revisionRows } = await client.query(
      `UPDATE memory_source_versions
       SET index_revision = index_revision + 1
       WHERE source_id = $1 AND source_version = $2 AND status = 'ACTIVE'
       RETURNING index_revision`,
      [source.id, source.current_version]
    );
    if (!revisionRows[0]) throw new Error("source version changed during index rebuild");
    const plan = {
      sourceId: source.id,
      tier: source.tier,
      chunks: chunks.map((chunk) => ({
        ...chunk,
        promptInjectionDetected: source.prompt_injection_detected,
        promptInjectionRuleIds: source.prompt_injection_rule_ids || [],
      })),
    };
    await writeChunks(client, plan, Number(source.current_version), Number(revisionRows[0].index_revision));
    await insertMemoryEvent(client, {
      sourceId: source.id,
      sourceVersion: Number(source.current_version),
      eventType: "INDEX_REBUILT",
      actorRef: normalizedActor,
      payload: {
        contentHash: source.current_content_hash,
        chunkCount: chunks.length,
        indexRevision: Number(revisionRows[0].index_revision),
      },
    });
    return {
      sourceId: source.id,
      sourceVersion: Number(source.current_version),
      indexRevision: Number(revisionRows[0].index_revision),
      chunks: chunks.length,
    };
  });
}

async function purgeExpiredMemory({ actorRef, limit = 100, now = new Date() }, { db = dbDefault } = {}) {
  const normalizedActor = normalizedIdentifier("actorRef", actorRef, 160);
  const boundedLimit = Number(limit);
  if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 1_000) throw new Error("purge limit must be 1-1000");
  const { rows } = await db.query(
    `SELECT id FROM memory_sources
     WHERE status = 'ACTIVE' AND expires_at <= $1
     ORDER BY expires_at, id LIMIT $2`,
    [now.toISOString(), boundedLimit]
  );
  const results = [];
  for (const row of rows) {
    results.push(await deleteMemorySource({
      sourceId: row.id,
      actorRef: normalizedActor,
      reason: "retention period expired",
    }, { db }));
  }
  return { purgedSources: results.length, results };
}

async function memoryInventory({ db = dbDefault } = {}) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_sources,
       COUNT(*) FILTER (WHERE status = 'DELETED')::int AS deleted_sources,
       COUNT(*) FILTER (WHERE conflict_state = 'CONFLICT' AND status = 'ACTIVE')::int AS conflicting_sources,
       COUNT(*) FILTER (WHERE expires_at <= CURRENT_TIMESTAMP AND status = 'ACTIVE')::int AS expired_sources
     FROM memory_sources`
  );
  const { rows: itemRows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_items,
            COALESCE(SUM(token_count) FILTER (WHERE status = 'ACTIVE'), 0)::bigint AS active_tokens
     FROM memory_items`
  );
  return { ...(rows[0] || {}), ...(itemRows[0] || {}) };
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  buildIngestionPlan,
  deleteMemorySource,
  ingestMemorySource,
  memoryInventory,
  normalizedProvenance,
  normalizedRoles,
  purgeExpiredMemory,
  rebuildMemoryIndex,
};
