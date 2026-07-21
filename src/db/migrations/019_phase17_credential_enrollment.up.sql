CREATE OR REPLACE FUNCTION store_phase17_channel_credential(
  p_instance_id TEXT,
  p_channel_type TEXT,
  p_encrypted_token TEXT,
  p_nonce TEXT,
  p_auth_tag TEXT,
  p_key_version INTEGER,
  p_token_fingerprint TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE(bot_instance_id TEXT, channel_type TEXT, status TEXT, key_version INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_channel_type <> 'discord' THEN
    RAISE EXCEPTION 'Phase 17 runtime enrollment supports Discord only' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_encrypted_token, '') = '' OR COALESCE(p_nonce, '') = '' OR COALESCE(p_auth_tag, '') = '' THEN
    RAISE EXCEPTION 'encrypted credential fields are required' USING ERRCODE = '22023';
  END IF;
  IF p_key_version IS NULL OR p_key_version <= 0 THEN
    RAISE EXCEPTION 'credential key version must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'credential fingerprint is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'credential metadata must be an object' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bot_instances
    WHERE instance_id = p_instance_id AND db_principal = SESSION_USER
      AND phase17_instance_authorized(p_instance_id)
  ) THEN
    RAISE EXCEPTION 'credential enrollment requires a principal-bound instance' USING ERRCODE = '42501';
  END IF;

  INSERT INTO channel_credentials(
    channel_type, bot_instance_id, encrypted_token, nonce, auth_tag, key_version, status, metadata_json
  ) VALUES (
    p_channel_type, p_instance_id, p_encrypted_token, p_nonce, p_auth_tag, p_key_version, 'ACTIVE',
    p_metadata || jsonb_build_object(
      'source', 'phase17-runtime-enrollment',
      'tokenFingerprint', p_token_fingerprint,
      'enrolledByPrincipal', SESSION_USER
    )
  )
  ON CONFLICT ON CONSTRAINT channel_credentials_channel_type_bot_instance_id_key DO UPDATE SET
    encrypted_token = EXCLUDED.encrypted_token,
    nonce = EXCLUDED.nonce,
    auth_tag = EXCLUDED.auth_tag,
    key_version = EXCLUDED.key_version,
    status = 'ACTIVE',
    metadata_json = EXCLUDED.metadata_json,
    updated_at = CURRENT_TIMESTAMP;

  RETURN QUERY
  SELECT c.bot_instance_id, c.channel_type, c.status, c.key_version
  FROM channel_credentials c
  WHERE c.bot_instance_id = p_instance_id AND c.channel_type = p_channel_type;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_phase17_channel_credential(
  p_instance_id TEXT,
  p_channel_type TEXT DEFAULT 'discord',
  p_reason TEXT DEFAULT 'runtime credential rejected'
)
RETURNS TABLE(bot_instance_id TEXT, channel_type TEXT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bot_instances
    WHERE instance_id = p_instance_id AND db_principal = SESSION_USER
      AND phase17_instance_authorized(p_instance_id)
  ) THEN
    RAISE EXCEPTION 'credential revocation requires a principal-bound instance' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  UPDATE channel_credentials c
  SET status = 'REVOKED',
      metadata_json = c.metadata_json || jsonb_build_object('revocationReason', LEFT(COALESCE(p_reason, 'runtime credential rejected'), 256)),
      updated_at = CURRENT_TIMESTAMP
  WHERE c.bot_instance_id = p_instance_id AND c.channel_type = p_channel_type AND c.status = 'ACTIVE'
  RETURNING c.bot_instance_id, c.channel_type, c.status;
END;
$$;

REVOKE ALL ON FUNCTION store_phase17_channel_credential(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_phase17_channel_credential(TEXT, TEXT, TEXT) FROM PUBLIC;

DO $$
DECLARE binding RECORD;
BEGIN
  FOR binding IN
    SELECT db_principal FROM bot_role_principals WHERE enabled
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = binding.db_principal) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION store_phase17_channel_credential(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB) TO %I',
        binding.db_principal
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION revoke_phase17_channel_credential(TEXT, TEXT, TEXT) TO %I',
        binding.db_principal
      );
    END IF;
  END LOOP;
END;
$$;
