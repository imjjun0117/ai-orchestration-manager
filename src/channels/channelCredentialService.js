const crypto = require("crypto");
const { query, pool } = require("../db");

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function masterKey() {
  const raw = String(process.env.CHANNEL_TOKEN_MASTER_KEY || "").trim();
  if (!raw) throw new Error("CHANNEL_TOKEN_MASTER_KEY is required");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) throw new Error("CHANNEL_TOKEN_MASTER_KEY must decode to 32 bytes");
  return key;
}

function encryptToken(token) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decryptToken(row) {
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey(), Buffer.from(row.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_token, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function storeToken({ channelType, botInstanceId, token, metadata = {} }, { db = { query } } = {}) {
  if (!channelType || !botInstanceId || !token) throw new Error("channelType, botInstanceId, and token are required");
  const encrypted = encryptToken(token);
  const result = await db.query(
    `INSERT INTO channel_credentials(
       channel_type, bot_instance_id, encrypted_token, nonce, auth_tag, key_version, metadata_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (channel_type, bot_instance_id) DO UPDATE SET
       encrypted_token = EXCLUDED.encrypted_token,
       nonce = EXCLUDED.nonce,
       auth_tag = EXCLUDED.auth_tag,
       key_version = EXCLUDED.key_version,
       metadata_json = EXCLUDED.metadata_json,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id, channel_type, bot_instance_id, key_version, metadata_json`,
    [channelType, botInstanceId, encrypted.ciphertext.toString("base64"), encrypted.iv.toString("base64"), encrypted.authTag.toString("base64"), 1, JSON.stringify(metadata)]
  );
  return result.rows[0];
}

async function getToken({ channelType, botInstanceId }, { db = { query } } = {}) {
  const result = await db.query(
    `SELECT encrypted_token, nonce, auth_tag FROM channel_credentials
     WHERE channel_type = $1 AND bot_instance_id = $2 AND status = 'ACTIVE'`,
    [channelType, botInstanceId]
  );
  return result.rows[0] ? decryptToken(result.rows[0]) : null;
}

module.exports = {
  decryptToken,
  encryptToken,
  getToken,
  pool,
  storeToken,
};
