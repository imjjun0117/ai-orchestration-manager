const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * SQL 쿼리를 실행합니다.
 * @param {string} text SQL 쿼리문
 * @param {Array} params 바인딩 파라미터
 */
async function query(text, params) {
  return pool.query(text, params);
}

module.exports = {
  query,
  pool,
};
