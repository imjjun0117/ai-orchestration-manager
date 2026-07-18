const db = require("../db");

/**
 * bot_settings 테이블에서 key에 해당하는 값을 조회한다. 없으면 null.
 * @param {string} key
 */
async function getSetting(key) {
  const { rows } = await db.query("SELECT value FROM bot_settings WHERE key = $1", [key]);
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * bot_settings 테이블에 key/value를 upsert한다.
 * @param {string} key
 * @param {string} value
 */
async function setSetting(key, value) {
  await db.query(
    `INSERT INTO bot_settings (key, value, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

module.exports = {
  getSetting,
  setSetting,
};
