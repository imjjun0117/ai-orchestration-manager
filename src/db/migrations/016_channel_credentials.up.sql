CREATE TABLE IF NOT EXISTS channel_credentials (
  id BIGSERIAL PRIMARY KEY,
  channel_type TEXT NOT NULL,
  bot_instance_id TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (channel_type, bot_instance_id)
);

REVOKE ALL ON channel_credentials FROM PUBLIC;
