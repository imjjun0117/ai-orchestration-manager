const db = require("../db");

/**
 * 새 승인 대기 항목을 연다. task가 PENDING_*_APPROVAL 상태로 전이할 때마다 호출한다.
 * 같은 task_id + action으로 이미 PENDING인 항목이 있으면 새로 만들지 않는다
 * (동시 실행으로 같은 catch 블록/전이 로직이 중복 호출돼도 PENDING이 중복 생성되지 않도록).
 *
 * `INSERT ... WHERE NOT EXISTS`만으로는 진짜 동시 요청(둘 다 커밋 전에 같은 스냅샷으로
 * NOT EXISTS를 평가) 하에서 중복 삽입을 완전히 막지 못한다 - 실제로 10개 동시 호출 테스트에서
 * 중복이 발생하는 것을 확인했다. 그래서 DB에 partial unique index
 * (approvals(task_id, action) WHERE status='PENDING', schema.sql 참고)를 걸어두고
 * ON CONFLICT DO NOTHING으로 위임한다 - 이러면 DB 자체가 유일성을 보장하므로 애플리케이션
 * 레벨의 race와 무관하게 항상 정확히 하나만 삽입된다.
 * 이미 PENDING이 있어서 삽입하지 않은 경우 null을 반환한다.
 * @param {string} taskId
 * @param {string} action 예: "plan_approval", "codex_approval", "gemini_approval", "commit_approval"
 * @param {string} requestedBy 승인을 요청한 주체 (에이전트 이름 등)
 */
async function openApproval(taskId, action, requestedBy) {
  const { rows } = await db.query(
    `INSERT INTO approvals (task_id, action, status, requested_by)
     VALUES ($1, $2, 'PENDING', $3)
     ON CONFLICT (task_id, action) WHERE (status = 'PENDING') DO NOTHING
     RETURNING *`,
    [taskId, action, requestedBy]
  );
  return rows[0] || null;
}

/**
 * task의 가장 최근 PENDING 승인 항목을 조회한다. (읽기 전용, 승인/반려 처리는 resolveLatest 사용)
 * @param {string} taskId
 */
async function getLatestPendingApproval(taskId) {
  const { rows } = await db.query(
    `SELECT * FROM approvals WHERE task_id = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
    [taskId]
  );
  return rows[0] || null;
}

/**
 * task의 가장 최근 PENDING 승인 항목을 원자적으로 승인/반려 처리한다.
 *
 * "조회 후 UPDATE" 2단계가 아니라 단일 UPDATE문으로 처리한다: WHERE 절 안의 서브쿼리로
 * 가장 최근 PENDING 행을 고르고, UPDATE 자체의 조건에도 `status = 'PENDING'`을 그대로
 * 남겨둔다. PostgreSQL은 UPDATE 대상 행에 대해 자동으로 행 잠금을 걸기 때문에, 두 요청이
 * 동시에 들어와도 한쪽이 커밋될 때까지 다른 쪽은 대기했다가, 커밋 후 재검사한 조건
 * (status = 'PENDING')이 더 이상 참이 아니므로 자연스럽게 0행을 갱신하고 끝난다.
 * 즉 동시에 두 번 호출해도 정확히 한쪽만 성공하고, 나머지는 null을 반환한다.
 *
 * 대기 중인 승인 항목이 없거나 이미 다른 요청이 먼저 처리한 경우 null을 반환한다.
 * 호출부(bot.js)는 반드시 반환값이 null인지 확인하고, null이면 다음 에이전트 실행으로
 * 진행하지 말고 즉시 반환해야 한다.
 * @param {string} taskId
 * @param {object} params
 * @param {boolean} params.approved true면 APPROVED, false면 REJECTED
 * @param {string} params.resolvedBy 승인/반려한 사용자
 * @param {string} [params.reason] 반려 사유
 */
async function resolveLatest(taskId, { approved, resolvedBy, reason = null }) {
  const { rows } = await db.query(
    `UPDATE approvals
     SET status = $2, approved_by = $3, reason = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = (
       SELECT id FROM approvals
       WHERE task_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC
       LIMIT 1
     )
     AND status = 'PENDING'
     RETURNING *`,
    [taskId, approved ? "APPROVED" : "REJECTED", resolvedBy, reason]
  );
  return rows[0] || null;
}

/**
 * task의 특정 action에 해당하는 PENDING 승인 항목만 원자적으로 승인/반려 처리한다.
 * 자동 파이프라인의 final_approval처럼, 같은 task에 다른 pending approval이 생길 수 있는
 * 흐름에서는 "가장 최근"보다 명시적인 action 조건이 안전하다.
 * @param {string} taskId
 * @param {string} action
 * @param {object} params
 * @param {boolean} params.approved
 * @param {string} params.resolvedBy
 * @param {string} [params.reason]
 */
async function resolvePendingAction(taskId, action, { approved, resolvedBy, reason = null }) {
  const { rows } = await db.query(
    `UPDATE approvals
     SET status = $3, approved_by = $4, reason = $5, updated_at = CURRENT_TIMESTAMP
     WHERE task_id = $1
       AND action = $2
       AND status = 'PENDING'
     RETURNING *`,
    [taskId, action, approved ? "APPROVED" : "REJECTED", resolvedBy, reason]
  );
  return rows[0] || null;
}

module.exports = {
  openApproval,
  getLatestPendingApproval,
  resolveLatest,
  resolvePendingAction,
};
