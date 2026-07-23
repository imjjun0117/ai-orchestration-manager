-- Phase 18: tiered memory, ACL-first retrieval, content-addressed context manifests.

ALTER TABLE tasks ADD COLUMN memory_project_key TEXT;

UPDATE tasks
SET memory_project_key = CASE
  WHEN NULLIF(BTRIM(channel_id), '') IS NOT NULL THEN 'discord-channel:' || channel_id
  ELSE 'task:' || id
END
WHERE memory_project_key IS NULL;

ALTER TABLE tasks ALTER COLUMN memory_project_key SET NOT NULL;
ALTER TABLE tasks ADD CONSTRAINT ck_task_memory_project_key
  CHECK (
    LENGTH(memory_project_key) BETWEEN 1 AND 200
    AND memory_project_key ~ '^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]*$'
    AND memory_project_key !~ '(^|/)\.\.(/|$)'
  );

CREATE OR REPLACE FUNCTION phase18_assign_task_project_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(BTRIM(NEW.memory_project_key), '') IS NULL THEN
    NEW.memory_project_key := CASE
      WHEN NULLIF(BTRIM(NEW.channel_id), '') IS NOT NULL THEN 'discord-channel:' || NEW.channel_id
      ELSE 'task:' || NEW.id
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_phase18_assign_task_project_key
BEFORE INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION phase18_assign_task_project_key();

CREATE TABLE memory_sources (
  id TEXT PRIMARY KEY CHECK (
    LENGTH(id) BETWEEN 1 AND 160
    AND id ~ '^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]*$'
    AND id !~ '(^|/)\.\.(/|$)'
  ),
  project_key TEXT NOT NULL CHECK (
    LENGTH(project_key) BETWEEN 1 AND 200
    AND project_key ~ '^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]*$'
    AND project_key !~ '(^|/)\.\.(/|$)'
  ),
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE RESTRICT,
  tier TEXT NOT NULL CHECK (tier IN ('LONG', 'EPISODIC', 'SHORT')),
  owner_ref TEXT NOT NULL CHECK (LENGTH(owner_ref) BETWEEN 1 AND 160),
  security_classification TEXT NOT NULL CHECK (
    security_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
  ),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  expires_at TIMESTAMPTZ NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  current_content_hash TEXT NOT NULL CHECK (current_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')),
  conflict_key TEXT CHECK (conflict_key IS NULL OR LENGTH(conflict_key) BETWEEN 1 AND 160),
  conflict_state TEXT NOT NULL DEFAULT 'CLEAR' CHECK (conflict_state IN ('CLEAR', 'CONFLICT')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'DELETED' AND deleted_at IS NOT NULL) OR status = 'ACTIVE')
);

CREATE INDEX ix_memory_sources_scope
  ON memory_sources(project_key, status, tier, conflict_state, expires_at);
CREATE INDEX ix_memory_sources_task ON memory_sources(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX ix_memory_sources_conflict
  ON memory_sources(project_key, conflict_key) WHERE conflict_key IS NOT NULL AND status = 'ACTIVE';

CREATE TABLE memory_source_versions (
  source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE RESTRICT,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  ingestion_hash TEXT NOT NULL CHECK (ingestion_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_text TEXT,
  index_revision INTEGER NOT NULL DEFAULT 1 CHECK (index_revision > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'DELETED')),
  prompt_injection_detected BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_injection_rule_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(prompt_injection_rule_ids) = 'array'),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  created_by TEXT NOT NULL,
  superseded_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_id, source_version),
  CHECK (status = 'DELETED' OR content_text IS NOT NULL),
  CHECK ((status = 'DELETED' AND deleted_at IS NOT NULL) OR status <> 'DELETED'),
  CHECK ((status = 'SUPERSEDED' AND superseded_at IS NOT NULL) OR status <> 'SUPERSEDED')
);

CREATE UNIQUE INDEX uq_memory_source_active_version
  ON memory_source_versions(source_id) WHERE status = 'ACTIVE';

CREATE TABLE memory_source_acl (
  source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('planner', 'coder', 'reviewer', 'qa', 'summarizer')),
  can_retrieve BOOLEAN NOT NULL DEFAULT TRUE CHECK (can_retrieve),
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_id, role)
);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY CHECK (LENGTH(id) BETWEEN 1 AND 240),
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  index_revision INTEGER NOT NULL CHECK (index_revision > 0),
  tier TEXT NOT NULL CHECK (tier IN ('LONG', 'EPISODIC', 'SHORT')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_text TEXT,
  embedding_json JSONB NOT NULL CHECK (jsonb_typeof(embedding_json) = 'array'),
  token_count INTEGER NOT NULL CHECK (token_count > 0 AND token_count <= 4096),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'DELETED')),
  prompt_injection_detected BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_injection_rule_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(prompt_injection_rule_ids) = 'array'),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(content_text, ''))) STORED,
  FOREIGN KEY(source_id, source_version)
    REFERENCES memory_source_versions(source_id, source_version) ON DELETE RESTRICT,
  UNIQUE(source_id, source_version, index_revision, ordinal),
  CHECK (status = 'DELETED' OR content_text IS NOT NULL),
  CHECK ((status = 'DELETED' AND deleted_at IS NOT NULL) OR status <> 'DELETED')
);

CREATE INDEX ix_memory_items_lookup
  ON memory_items(source_id, source_version, index_revision, status, ordinal);
CREATE INDEX ix_memory_items_search ON memory_items USING GIN(search_vector);

CREATE TABLE memory_provenance_edges (
  id BIGSERIAL PRIMARY KEY,
  derived_source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  source_item_id TEXT REFERENCES memory_items(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(source_id, source_version)
    REFERENCES memory_source_versions(source_id, source_version) ON DELETE RESTRICT,
  CHECK (derived_source_id <> source_id)
);

CREATE UNIQUE INDEX uq_memory_provenance_edge
  ON memory_provenance_edges(derived_source_id, source_id, source_version, COALESCE(source_item_id, ''));
CREATE INDEX ix_memory_provenance_source
  ON memory_provenance_edges(source_id, source_version);

CREATE TABLE memory_context_manifests (
  id TEXT PRIMARY KEY CHECK (LENGTH(id) BETWEEN 1 AND 160),
  task_id VARCHAR(50) NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  role_job_id TEXT NOT NULL REFERENCES role_jobs(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('planner', 'coder', 'reviewer', 'qa', 'summarizer')),
  project_key TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'enforced')),
  status TEXT NOT NULL CHECK (status IN ('SHADOW', 'APPLIED', 'FALLBACK')),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  context_package_hash TEXT NOT NULL CHECK (context_package_hash ~ '^sha256:[0-9a-f]{64}$'),
  legacy_context_hash TEXT NOT NULL CHECK (legacy_context_hash ~ '^sha256:[0-9a-f]{64}$'),
  token_budget INTEGER NOT NULL CHECK (token_budget BETWEEN 256 AND 32000),
  token_count INTEGER NOT NULL CHECK (token_count >= 0 AND token_count <= token_budget),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0 AND candidate_count <= 100),
  selected_item_count INTEGER NOT NULL CHECK (selected_item_count >= 0 AND selected_item_count <= 30),
  retrieval_latency_ms INTEGER NOT NULL CHECK (retrieval_latency_ms >= 0 AND retrieval_latency_ms <= 30000),
  manifest_json JSONB NOT NULL CHECK (jsonb_typeof(manifest_json) = 'object'),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_json) = 'object'),
  fallback_code TEXT,
  created_by_instance_id TEXT NOT NULL REFERENCES bot_instances(instance_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, role_job_id, role, manifest_hash)
);

CREATE INDEX ix_memory_context_task ON memory_context_manifests(task_id, created_at DESC);
CREATE INDEX ix_memory_context_hash ON memory_context_manifests(manifest_hash);

CREATE TABLE memory_shadow_reports (
  id BIGSERIAL PRIMARY KEY,
  context_manifest_id TEXT NOT NULL UNIQUE REFERENCES memory_context_manifests(id) ON DELETE RESTRICT,
  task_id VARCHAR(50) NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  legacy_context_hash TEXT NOT NULL CHECK (legacy_context_hash ~ '^sha256:[0-9a-f]{64}$'),
  tiered_context_hash TEXT NOT NULL CHECK (tiered_context_hash ~ '^sha256:[0-9a-f]{64}$'),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  selected_item_count INTEGER NOT NULL CHECK (selected_item_count >= 0),
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  injection_item_count INTEGER NOT NULL CHECK (injection_item_count >= 0),
  stale_event_count INTEGER NOT NULL CHECK (stale_event_count >= 0),
  conflict_event_count INTEGER NOT NULL CHECK (conflict_event_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE memory_events (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT REFERENCES memory_sources(id) ON DELETE RESTRICT,
  source_version INTEGER,
  item_id TEXT REFERENCES memory_items(id) ON DELETE RESTRICT,
  task_id VARCHAR(50) REFERENCES tasks(id) ON DELETE RESTRICT,
  role_job_id TEXT REFERENCES role_jobs(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_payload) = 'object'),
  actor_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ix_memory_events_source ON memory_events(source_id, id);
CREATE INDEX ix_memory_events_task ON memory_events(task_id, id) WHERE task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION phase18_guard_source_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory sources are retained as tombstones' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_key IS DISTINCT FROM NEW.project_key
     OR OLD.tier IS DISTINCT FROM NEW.tier
     OR OLD.owner_ref IS DISTINCT FROM NEW.owner_ref
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'memory source identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'DELETED' AND NEW.status <> 'DELETED' THEN
    RAISE EXCEPTION 'deleted memory source cannot be reactivated' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_phase18_guard_source_mutation
BEFORE UPDATE OR DELETE ON memory_sources
FOR EACH ROW EXECUTE FUNCTION phase18_guard_source_mutation();

CREATE OR REPLACE FUNCTION phase18_guard_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory versions are immutable history' USING ERRCODE = '55000';
  END IF;
  IF OLD.source_id IS DISTINCT FROM NEW.source_id
     OR OLD.source_version IS DISTINCT FROM NEW.source_version
     OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
     OR OLD.ingestion_hash IS DISTINCT FROM NEW.ingestion_hash
     OR OLD.prompt_injection_detected IS DISTINCT FROM NEW.prompt_injection_detected
     OR OLD.prompt_injection_rule_ids IS DISTINCT FROM NEW.prompt_injection_rule_ids
     OR OLD.metadata_json IS DISTINCT FROM NEW.metadata_json
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'memory version identity and evidence are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.index_revision < OLD.index_revision THEN
    RAISE EXCEPTION 'memory index revision cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'DELETED' AND NEW.status <> 'DELETED' THEN
    RAISE EXCEPTION 'deleted memory version cannot be restored' USING ERRCODE = '55000';
  END IF;
  IF OLD.content_text IS DISTINCT FROM NEW.content_text
     AND NOT (OLD.content_text IS NOT NULL AND NEW.content_text IS NULL AND NEW.status = 'DELETED') THEN
    RAISE EXCEPTION 'memory source content can only be erased during deletion' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_phase18_guard_version_mutation
BEFORE UPDATE OR DELETE ON memory_source_versions
FOR EACH ROW EXECUTE FUNCTION phase18_guard_version_mutation();

CREATE OR REPLACE FUNCTION phase18_guard_item_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory items are retained as index tombstones' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.source_id IS DISTINCT FROM NEW.source_id
     OR OLD.source_version IS DISTINCT FROM NEW.source_version
     OR OLD.index_revision IS DISTINCT FROM NEW.index_revision
     OR OLD.tier IS DISTINCT FROM NEW.tier
     OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
     OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
     OR OLD.token_count IS DISTINCT FROM NEW.token_count
     OR OLD.prompt_injection_detected IS DISTINCT FROM NEW.prompt_injection_detected
     OR OLD.prompt_injection_rule_ids IS DISTINCT FROM NEW.prompt_injection_rule_ids
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'memory item identity and evidence are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'DELETED' AND NEW.status <> 'DELETED' THEN
    RAISE EXCEPTION 'deleted memory item cannot be restored' USING ERRCODE = '55000';
  END IF;
  IF OLD.content_text IS DISTINCT FROM NEW.content_text
     AND NOT (OLD.content_text IS NOT NULL AND NEW.content_text IS NULL AND NEW.status = 'DELETED') THEN
    RAISE EXCEPTION 'memory item content can only be erased during deletion' USING ERRCODE = '55000';
  END IF;
  IF OLD.embedding_json IS DISTINCT FROM NEW.embedding_json
     AND NOT (NEW.embedding_json = '[]'::jsonb AND NEW.status = 'DELETED') THEN
    RAISE EXCEPTION 'memory item embedding can only be erased during deletion' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_phase18_guard_item_mutation
BEFORE UPDATE OR DELETE ON memory_items
FOR EACH ROW EXECUTE FUNCTION phase18_guard_item_mutation();

CREATE OR REPLACE FUNCTION phase18_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_phase18_context_manifest_append_only
BEFORE UPDATE OR DELETE ON memory_context_manifests
FOR EACH ROW EXECUTE FUNCTION phase18_append_only();
CREATE TRIGGER trg_phase18_shadow_report_append_only
BEFORE UPDATE OR DELETE ON memory_shadow_reports
FOR EACH ROW EXECUTE FUNCTION phase18_append_only();
CREATE TRIGGER trg_phase18_memory_event_append_only
BEFORE UPDATE OR DELETE ON memory_events
FOR EACH ROW EXECUTE FUNCTION phase18_append_only();

CREATE OR REPLACE FUNCTION phase18_claim_authorized(
  p_instance_id TEXT,
  p_task_id TEXT,
  p_role_job_id TEXT,
  p_role TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bot_instances i
    JOIN bot_role_principals principal
      ON principal.db_principal = i.db_principal
     AND principal.bot_role = i.bot_role
     AND principal.enabled
    JOIN role_jobs job
      ON job.id = p_role_job_id
     AND job.task_id = p_task_id
     AND job.target_role = p_role
     AND job.claimed_by_instance_id = i.instance_id
     AND job.status = 'RUNNING'
     AND job.claim_token IS NOT NULL
     AND job.lease_expires_at > CURRENT_TIMESTAMP
    WHERE i.instance_id = p_instance_id
      AND i.bot_role = p_role
      AND i.db_principal = SESSION_USER
      AND i.status IN ('ONLINE', 'BUSY', 'DEGRADED')
      AND phase17_instance_authorized(p_instance_id, p_role)
  )
$$;

CREATE OR REPLACE FUNCTION retrieve_phase18_memory_candidates(
  p_instance_id TEXT,
  p_task_id TEXT,
  p_role_job_id TEXT,
  p_role TEXT,
  p_query TEXT,
  p_candidate_limit INTEGER
)
RETURNS TABLE(
  item_id TEXT,
  source_id TEXT,
  source_version INTEGER,
  index_revision INTEGER,
  ordinal INTEGER,
  tier TEXT,
  security_classification TEXT,
  content_hash TEXT,
  content_text TEXT,
  embedding_json JSONB,
  token_count INTEGER,
  prompt_injection_detected BOOLEAN,
  lexical_score REAL,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_role NOT IN ('planner', 'coder', 'reviewer', 'qa', 'summarizer')
     OR p_candidate_limit NOT BETWEEN 1 AND 100
     OR LENGTH(COALESCE(p_query, '')) > 4000 THEN
    RAISE EXCEPTION 'invalid Phase 18 retrieval request' USING ERRCODE = '22023';
  END IF;
  IF NOT phase18_claim_authorized(p_instance_id, p_task_id, p_role_job_id, p_role) THEN
    RAISE EXCEPTION 'memory retrieval requires the active role claim' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT
      item.id,
      source.id,
      item.source_version,
      item.index_revision,
      item.ordinal,
      item.tier,
      source.security_classification,
      item.content_hash,
      item.content_text,
      item.embedding_json,
      item.token_count,
      item.prompt_injection_detected,
      ts_rank_cd(item.search_vector, plainto_tsquery('simple', COALESCE(p_query, '')))::REAL,
      item.created_at
    FROM tasks task
    JOIN memory_sources source
      ON source.project_key = task.memory_project_key
     AND (source.task_id IS NULL OR source.task_id = task.id)
    JOIN memory_source_acl acl
      ON acl.source_id = source.id AND acl.role = p_role AND acl.can_retrieve
    JOIN memory_source_versions version
      ON version.source_id = source.id
     AND version.source_version = source.current_version
     AND version.status = 'ACTIVE'
    JOIN memory_items item
      ON item.source_id = source.id
     AND item.source_version = version.source_version
     AND item.index_revision = version.index_revision
     AND item.status = 'ACTIVE'
    WHERE task.id = p_task_id
      AND source.status = 'ACTIVE'
      AND source.conflict_state = 'CLEAR'
      AND source.expires_at > CURRENT_TIMESTAMP
      AND item.content_text IS NOT NULL
    ORDER BY
      ts_rank_cd(item.search_vector, plainto_tsquery('simple', COALESCE(p_query, ''))) DESC,
      CASE item.tier WHEN 'SHORT' THEN 1 WHEN 'EPISODIC' THEN 2 ELSE 3 END,
      item.created_at DESC,
      item.id
    LIMIT p_candidate_limit;
END;
$$;

CREATE OR REPLACE FUNCTION inspect_phase18_memory_evidence(
  p_instance_id TEXT,
  p_task_id TEXT,
  p_role_job_id TEXT,
  p_role TEXT,
  p_event_limit INTEGER DEFAULT 100
)
RETURNS TABLE(
  event_id BIGINT,
  source_id TEXT,
  source_version INTEGER,
  event_type TEXT,
  evidence JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_event_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'memory evidence limit must be 1-100' USING ERRCODE = '22023';
  END IF;
  IF NOT phase18_claim_authorized(p_instance_id, p_task_id, p_role_job_id, p_role) THEN
    RAISE EXCEPTION 'memory evidence requires the active role claim' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT event.id, event.source_id, event.source_version, event.event_type,
           event.event_payload, event.created_at
    FROM tasks task
    JOIN memory_sources source
      ON source.project_key = task.memory_project_key
     AND (source.task_id IS NULL OR source.task_id = task.id)
    JOIN memory_source_acl acl
      ON acl.source_id = source.id AND acl.role = p_role AND acl.can_retrieve
    JOIN memory_events event ON event.source_id = source.id
    WHERE task.id = p_task_id
      AND event.event_type IN (
        'SOURCE_SUPERSEDED', 'SOURCE_CONFLICT_DETECTED', 'PROMPT_INJECTION_DETECTED',
        'SOURCE_CONFLICT_RESOLVED', 'SOURCE_DELETED', 'DERIVED_SOURCE_DELETED',
        'INDEX_DELETED', 'INDEX_REBUILT'
      )
    ORDER BY event.id DESC
    LIMIT p_event_limit;
END;
$$;

CREATE OR REPLACE FUNCTION record_phase18_context_manifest(
  p_instance_id TEXT,
  p_task_id TEXT,
  p_role_job_id TEXT,
  p_role TEXT,
  p_manifest_id TEXT,
  p_project_key TEXT,
  p_policy_version TEXT,
  p_mode TEXT,
  p_status TEXT,
  p_manifest_hash TEXT,
  p_context_package_hash TEXT,
  p_legacy_context_hash TEXT,
  p_token_budget INTEGER,
  p_token_count INTEGER,
  p_candidate_count INTEGER,
  p_selected_item_count INTEGER,
  p_retrieval_latency_ms INTEGER,
  p_manifest_json JSONB,
  p_manifest_canonical TEXT,
  p_evidence_json JSONB,
  p_fallback_code TEXT DEFAULT NULL
)
RETURNS memory_context_manifests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  result_row memory_context_manifests%ROWTYPE;
  injection_count INTEGER;
  stale_count INTEGER;
  conflict_count INTEGER;
BEGIN
  IF NOT phase18_claim_authorized(p_instance_id, p_task_id, p_role_job_id, p_role) THEN
    RAISE EXCEPTION 'context manifest requires the active role claim' USING ERRCODE = '42501';
  END IF;
  IF p_mode NOT IN ('shadow', 'enforced')
     OR p_status NOT IN ('SHADOW', 'APPLIED', 'FALLBACK')
     OR p_manifest_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_context_package_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_legacy_context_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_token_budget NOT BETWEEN 256 AND 32000
     OR p_token_count NOT BETWEEN 0 AND p_token_budget
     OR p_candidate_count NOT BETWEEN 0 AND 100
     OR p_selected_item_count NOT BETWEEN 0 AND 30
     OR p_retrieval_latency_ms NOT BETWEEN 0 AND 30000
     OR jsonb_typeof(p_manifest_json) <> 'object'
     OR jsonb_typeof(p_evidence_json) <> 'object'
     OR octet_length(p_manifest_json::text) > 262144
     OR octet_length(COALESCE(p_manifest_canonical, '')) > 262144
     OR octet_length(p_evidence_json::text) > 262144 THEN
    RAISE EXCEPTION 'invalid Phase 18 context manifest' USING ERRCODE = '22023';
  END IF;
  IF p_manifest_canonical IS NULL
     OR p_manifest_canonical::jsonb <> p_manifest_json
     OR p_manifest_hash <> 'sha256:' || encode(sha256(convert_to(p_manifest_canonical, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'context manifest canonical hash mismatch' USING ERRCODE = '22023';
  END IF;
  IF p_manifest_json->>'schemaVersion' <> '1'
     OR p_manifest_json->>'policyVersion' <> p_policy_version
     OR p_manifest_json->>'taskId' <> p_task_id
     OR p_manifest_json->>'roleJobId' <> p_role_job_id
     OR p_manifest_json->>'role' <> p_role
     OR p_manifest_json->>'projectKey' <> p_project_key
     OR p_manifest_json->>'mode' <> p_mode
     OR p_manifest_json->>'status' <> p_status
     OR (p_manifest_json->>'tokenBudget')::integer <> p_token_budget
     OR (p_manifest_json->>'tokenCount')::integer <> p_token_count
     OR (p_manifest_json->>'candidateCount')::integer <> p_candidate_count THEN
    RAISE EXCEPTION 'context manifest binding does not match the active claim' USING ERRCODE = '42501';
  END IF;
  IF (p_mode = 'shadow' AND p_status NOT IN ('SHADOW', 'FALLBACK'))
     OR (p_mode = 'enforced' AND p_status NOT IN ('APPLIED', 'FALLBACK'))
     OR (p_status = 'FALLBACK' AND (p_selected_item_count <> 0 OR p_fallback_code IS NULL))
     OR (p_status <> 'FALLBACK' AND (p_selected_item_count = 0 OR p_fallback_code IS NOT NULL)) THEN
    RAISE EXCEPTION 'context manifest status is inconsistent with its mode' USING ERRCODE = '22023';
  END IF;
  IF p_manifest_json::text ~* '"(content|text|prompt|originalRequest)"[[:space:]]*:'
     OR p_evidence_json::text ~* '"(content|text|prompt|originalRequest)"[[:space:]]*:' THEN
    RAISE EXCEPTION 'context manifest metadata cannot persist retrieved content' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_manifest_json->'entries', 'null'::jsonb)) <> 'array'
     OR jsonb_array_length(p_manifest_json->'entries') <> p_selected_item_count
     OR COALESCE((
       SELECT SUM((entry->>'tokenCount')::integer)
       FROM jsonb_array_elements(p_manifest_json->'entries') entry
     ), 0) <> p_token_count THEN
    RAISE EXCEPTION 'context manifest counts do not match its entries' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tasks WHERE id = p_task_id AND memory_project_key = p_project_key
  ) THEN
    RAISE EXCEPTION 'context project binding changed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_manifest_json->'entries') entry
    CROSS JOIN tasks task
    WHERE entry->>'tier' = 'SHORT'
      AND task.id = p_task_id
      AND (
        entry->>'sourceId' <> 'task-short:' || p_task_id
        OR entry->>'itemId' <> 'task-short:' || p_task_id || ':v' || task.row_version
        OR (entry->>'sourceVersion')::integer <> task.row_version
        OR (entry->>'indexRevision')::integer <> 1
        OR entry->>'classification' <> 'INTERNAL'
        OR entry->>'contentHash' !~ '^sha256:[0-9a-f]{64}$'
        OR (entry->>'tokenCount')::integer < 1
      )
  ) OR (
    SELECT COUNT(*) FROM jsonb_array_elements(p_manifest_json->'entries') entry
    WHERE entry->>'tier' = 'SHORT'
  ) > 1 THEN
    RAISE EXCEPTION 'short memory entry is not bound to the active task' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_manifest_json->'entries') entry
    WHERE entry->>'tier' <> 'SHORT'
      AND NOT EXISTS (
        SELECT 1
        FROM memory_items item
        JOIN memory_sources source ON source.id = item.source_id
        JOIN memory_source_versions version
          ON version.source_id = item.source_id
         AND version.source_version = item.source_version
         AND version.index_revision = item.index_revision
        JOIN memory_source_acl acl
          ON acl.source_id = source.id AND acl.role = p_role AND acl.can_retrieve
        WHERE item.id = entry->>'itemId'
          AND source.id = entry->>'sourceId'
          AND item.source_version = (entry->>'sourceVersion')::integer
          AND item.index_revision = (entry->>'indexRevision')::integer
          AND item.tier = entry->>'tier'
          AND source.security_classification = entry->>'classification'
          AND item.content_hash = entry->>'contentHash'
          AND item.token_count = (entry->>'tokenCount')::integer
          AND item.prompt_injection_detected = (entry->>'promptInjectionDetected')::boolean
          AND source.project_key = p_project_key
          AND (source.task_id IS NULL OR source.task_id = p_task_id)
          AND source.status = 'ACTIVE'
          AND source.conflict_state = 'CLEAR'
          AND source.expires_at > CURRENT_TIMESTAMP
          AND version.status = 'ACTIVE'
          AND item.status = 'ACTIVE'
      )
  ) THEN
    RAISE EXCEPTION 'context manifest contains a stale or unauthorized memory item' USING ERRCODE = '42501';
  END IF;

  INSERT INTO memory_context_manifests(
    id, task_id, role_job_id, role, project_key, policy_version, mode, status,
    manifest_hash, context_package_hash, legacy_context_hash, token_budget, token_count,
    candidate_count, selected_item_count, retrieval_latency_ms, manifest_json,
    evidence_json, fallback_code, created_by_instance_id
  ) VALUES (
    p_manifest_id, p_task_id, p_role_job_id, p_role, p_project_key, p_policy_version,
    p_mode, p_status, p_manifest_hash, p_context_package_hash, p_legacy_context_hash,
    p_token_budget, p_token_count, p_candidate_count, p_selected_item_count,
    p_retrieval_latency_ms, p_manifest_json, p_evidence_json, p_fallback_code, p_instance_id
  )
  RETURNING * INTO result_row;

  INSERT INTO memory_events(
    task_id, role_job_id, event_type, event_payload, actor_ref
  ) VALUES (
    p_task_id, p_role_job_id, 'CONTEXT_MANIFEST_RECORDED',
    jsonb_build_object(
      'manifestId', p_manifest_id,
      'manifestHash', p_manifest_hash,
      'contextPackageHash', p_context_package_hash,
      'mode', p_mode,
      'status', p_status,
      'selectedItemCount', p_selected_item_count,
      'tokenCount', p_token_count
    ),
    p_instance_id
  );

  IF p_mode = 'shadow' THEN
    injection_count := COALESCE((p_evidence_json->>'injectionItemCount')::integer, 0);
    stale_count := COALESCE((p_evidence_json->>'staleEventCount')::integer, 0);
    conflict_count := COALESCE((p_evidence_json->>'conflictEventCount')::integer, 0);
    INSERT INTO memory_shadow_reports(
      context_manifest_id, task_id, role, legacy_context_hash, tiered_context_hash,
      candidate_count, selected_item_count, token_count, injection_item_count,
      stale_event_count, conflict_event_count
    ) VALUES (
      p_manifest_id, p_task_id, p_role, p_legacy_context_hash, p_context_package_hash,
      p_candidate_count, p_selected_item_count, p_token_count, injection_count,
      stale_count, conflict_count
    );
  END IF;
  RETURN result_row;
END;
$$;

CREATE OR REPLACE FUNCTION replay_phase18_context_manifest(p_manifest_id TEXT)
RETURNS TABLE(manifest_hash TEXT, manifest_json JSONB, source_items_available BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manifest_row memory_context_manifests%ROWTYPE;
BEGIN
  SELECT * INTO manifest_row FROM memory_context_manifests WHERE id = p_manifest_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'context manifest does not exist' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
    SELECT manifest_row.manifest_hash,
           manifest_row.manifest_json,
           NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(manifest_row.manifest_json->'entries', '[]'::jsonb)) entry
             LEFT JOIN memory_items item ON item.id = entry->>'itemId'
             WHERE entry->>'tier' <> 'SHORT'
               AND (item.id IS NULL OR item.content_text IS NULL OR item.status <> 'ACTIVE')
           );
END;
$$;

REVOKE ALL ON TABLE
  memory_sources, memory_source_versions, memory_source_acl, memory_items,
  memory_provenance_edges, memory_context_manifests, memory_shadow_reports, memory_events
FROM PUBLIC;
REVOKE ALL ON SEQUENCE
  memory_provenance_edges_id_seq, memory_shadow_reports_id_seq, memory_events_id_seq
FROM PUBLIC;

REVOKE ALL ON FUNCTION phase18_assign_task_project_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase18_guard_source_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase18_guard_version_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase18_guard_item_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase18_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION phase18_claim_authorized(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION retrieve_phase18_memory_candidates(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION inspect_phase18_memory_evidence(TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_phase18_context_manifest(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,
  INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,JSONB,TEXT,JSONB,TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION replay_phase18_context_manifest(TEXT) FROM PUBLIC;

DO $$
DECLARE principal_row RECORD;
BEGIN
  FOR principal_row IN
    SELECT p.db_principal
    FROM bot_role_principals p
    JOIN pg_roles r ON r.rolname = p.db_principal
    WHERE p.enabled AND p.bot_role IN ('planner', 'coder', 'reviewer', 'qa', 'summarizer')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION retrieve_phase18_memory_candidates(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) TO %I',
      principal_row.db_principal
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION inspect_phase18_memory_evidence(TEXT,TEXT,TEXT,TEXT,INTEGER) TO %I',
      principal_row.db_principal
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION record_phase18_context_manifest(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,JSONB,TEXT,JSONB,TEXT) TO %I',
      principal_row.db_principal
    );
  END LOOP;
END;
$$;
