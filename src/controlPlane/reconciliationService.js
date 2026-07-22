const dbDefault = require("../db");

const ITEM_TYPES = new Set(["ROLE_JOB", "OUTBOX_EVENT"]);
const DECISIONS = new Set(["RETRY", "DEAD_LETTER"]);

function database(db) { return db || dbDefault; }

function normalize(value) {
  return String(value || "").trim().toUpperCase().replaceAll("-", "_");
}

function validateRequest({ requestId, itemType, itemId, decision, expectedRevision, reason, evidenceRef }) {
  const normalized = {
    requestId: String(requestId || "").trim(),
    itemType: normalize(itemType),
    itemId: String(itemId || "").trim(),
    decision: normalize(decision),
    expectedRevision: String(expectedRevision ?? "").trim(),
    reason: String(reason || "").trim(),
    evidenceRef: String(evidenceRef || "").trim(),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized.requestId)) throw new Error("request id must be 8-128 safe characters");
  if (!ITEM_TYPES.has(normalized.itemType)) throw new Error("item type must be ROLE_JOB or OUTBOX_EVENT");
  if (!normalized.itemId || normalized.itemId.length > 200) throw new Error("item id is required and must be at most 200 characters");
  if (!DECISIONS.has(normalized.decision)) throw new Error("decision must be RETRY or DEAD_LETTER");
  if (!/^\d+$/.test(normalized.expectedRevision)) throw new Error("expected revision must be a non-negative integer");
  if (normalized.reason.length < 16 || normalized.reason.length > 2000) throw new Error("reason must contain 16 to 2000 characters");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,511}$/.test(normalized.evidenceRef)) throw new Error("evidence ref must be a safe reference without whitespace");
  return normalized;
}

async function list({ db } = {}) {
  const { rows } = await database(db).query(
    `SELECT * FROM (
       SELECT 'ROLE_JOB'::text AS item_type, job.id AS item_id, job.status,
              job.reconciliation_revision, job.target_role, job.job_type AS item_kind,
              job.safe_to_retry, job.attempt_count, job.max_attempts,
              job.last_error_code, job.updated_at, NULL::text AS publication_status
       FROM role_jobs job
       WHERE job.status IN ('NEEDS_RECONCILIATION', 'DEAD_LETTER')
         AND NOT EXISTS (
           SELECT 1 FROM phase17_reconciliation_actions action
           WHERE action.item_type = 'ROLE_JOB' AND action.item_id = job.id
             AND action.after_status = job.status
             AND action.after_revision = job.reconciliation_revision
         )
       UNION ALL
       SELECT 'OUTBOX_EVENT'::text AS item_type, event.id AS item_id, event.status,
              event.reconciliation_revision, event.target_role, event.event_type AS item_kind,
              NULL::boolean AS safe_to_retry, event.attempt_count, event.max_attempts,
              event.last_error_code, event.updated_at, publication.status AS publication_status
       FROM outbox_events event
       LEFT JOIN discord_publications publication ON publication.outbox_event_id = event.id
       WHERE event.status IN ('NEEDS_RECONCILIATION', 'DEAD_LETTER')
         AND NOT EXISTS (
           SELECT 1 FROM phase17_reconciliation_actions action
           WHERE action.item_type = 'OUTBOX_EVENT' AND action.item_id = event.id
             AND action.after_status = event.status
             AND action.after_revision = event.reconciliation_revision
         )
     ) unresolved
     ORDER BY updated_at, item_type, item_id`
  );
  return rows;
}

async function resolve(request, { db } = {}) {
  const input = validateRequest(request);
  const { rows } = await database(db).query(
    "SELECT * FROM reconcile_phase17_item($1,$2,$3,$4,$5::bigint,$6,$7)",
    [input.requestId, input.itemType, input.itemId, input.decision, input.expectedRevision, input.reason, input.evidenceRef]
  );
  if (!rows[0]) throw new Error("reconciliation action was not returned");
  return rows[0];
}

module.exports = { DECISIONS, ITEM_TYPES, list, resolve, validateRequest };
