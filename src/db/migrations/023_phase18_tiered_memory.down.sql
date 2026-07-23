DO $$
DECLARE principal_row RECORD;
BEGIN
  FOR principal_row IN
    SELECT p.db_principal
    FROM bot_role_principals p
    JOIN pg_roles r ON r.rolname = p.db_principal
    WHERE p.enabled
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION retrieve_phase18_memory_candidates(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) FROM %I',
      principal_row.db_principal
    );
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION inspect_phase18_memory_evidence(TEXT,TEXT,TEXT,TEXT,INTEGER) FROM %I',
      principal_row.db_principal
    );
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION record_phase18_context_manifest(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,JSONB,TEXT,JSONB,TEXT) FROM %I',
      principal_row.db_principal
    );
  END LOOP;
END;
$$;

DROP FUNCTION replay_phase18_context_manifest(TEXT);
DROP FUNCTION record_phase18_context_manifest(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,
  INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,JSONB,TEXT,JSONB,TEXT
);
DROP FUNCTION inspect_phase18_memory_evidence(TEXT,TEXT,TEXT,TEXT,INTEGER);
DROP FUNCTION retrieve_phase18_memory_candidates(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER);
DROP FUNCTION phase18_claim_authorized(TEXT,TEXT,TEXT,TEXT);

DROP TRIGGER trg_phase18_memory_event_append_only ON memory_events;
DROP TRIGGER trg_phase18_shadow_report_append_only ON memory_shadow_reports;
DROP TRIGGER trg_phase18_context_manifest_append_only ON memory_context_manifests;
DROP TRIGGER trg_phase18_guard_item_mutation ON memory_items;
DROP TRIGGER trg_phase18_guard_version_mutation ON memory_source_versions;
DROP TRIGGER trg_phase18_guard_source_mutation ON memory_sources;
DROP FUNCTION phase18_append_only();
DROP FUNCTION phase18_guard_item_mutation();
DROP FUNCTION phase18_guard_version_mutation();
DROP FUNCTION phase18_guard_source_mutation();

DROP TABLE memory_events;
DROP TABLE memory_shadow_reports;
DROP TABLE memory_context_manifests;
DROP TABLE memory_provenance_edges;
DROP TABLE memory_items;
DROP TABLE memory_source_acl;
DROP TABLE memory_source_versions;
DROP TABLE memory_sources;

DROP TRIGGER trg_phase18_assign_task_project_key ON tasks;
DROP FUNCTION phase18_assign_task_project_key();
ALTER TABLE tasks DROP COLUMN memory_project_key;
