const dbDefault = require("../db");

async function recover({ managerInstanceId }, { db = dbDefault } = {}) {
  const { rows } = await db.query("SELECT * FROM recover_phase17_control_plane($1)", [managerInstanceId]);
  return rows[0];
}

module.exports = { recover };
