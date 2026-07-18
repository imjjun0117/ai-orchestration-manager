const db = require("../db");

function todayDatePart() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * TASK-YYYYMMDD-NNNN 형식의 task_id를 생성합니다.
 * 같은 날짜에 생성된 task 개수를 세어 다음 순번을 매긴다.
 */
async function generateTaskId() {
  const datePart = todayDatePart();
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS count FROM tasks WHERE id LIKE $1",
    [`TASK-${datePart}-%`]
  );
  const nextSeq = rows[0].count + 1;
  const seqPart = String(nextSeq).padStart(4, "0");
  return `TASK-${datePart}-${seqPart}`;
}

module.exports = {
  generateTaskId,
};
