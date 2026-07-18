const crypto = require("crypto");
const defaultDb = require("../db");

function deliveryId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function resolveDb(db) {
  const candidate = db || defaultDb;
  if (!candidate || typeof candidate.query !== "function") {
    throw new TypeError("a database client with query(text, params) is required");
  }
  return candidate;
}

async function queryOne(db, text, params) {
  const { rows } = await resolveDb(db).query(text, params);
  return rows[0] || null;
}

async function withTransaction(fn, { db = defaultDb, isolationLevel = "SERIALIZABLE" } = {}) {
  if (!["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"].includes(isolationLevel)) {
    throw new Error(`unsupported transaction isolation level: ${isolationLevel}`);
  }
  const pool = db.pool || db;
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("transaction requires a pg Pool-compatible object");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  deliveryId,
  queryOne,
  resolveDb,
  withTransaction,
};
