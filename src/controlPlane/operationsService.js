const instanceService = require("./instanceService");
const { ROLE_DEFINITIONS } = require("./roleConfig");

const ROLE_LABELS = Object.freeze({
  manager: "매니저",
  planner: "PM(기획)",
  coder: "개발자",
  reviewer: "리뷰어",
  qa: "QA",
  summarizer: "요약 담당",
});
const STATUS_LABELS = Object.freeze({
  ONLINE: "온라인",
  OFFLINE: "오프라인",
  BUSY: "작업 중",
  DEGRADED: "성능 저하",
  STALE: "응답 없음",
});

function roleLabel(role) { return ROLE_LABELS[role] || role; }
function statusLabel(status) { return STATUS_LABELS[status] || status; }

function age(timestamp) {
  if (!timestamp) return "기록 없음";
  return `${Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000))}초 전`;
}

async function team({ db }) {
  const rows = await instanceService.team({ db });
  return rows.map((row) => (
    `${roleLabel(row.bot_role)} (${row.bot_role}) · 인스턴스=${row.instance_id} · 엔진=${row.agent_engine} · 상태=${statusLabel(row.status)} · 현재 작업=${row.current_job_id || "대기"}`
  )).join("\n");
}

async function health({ db }) {
  const rows = await instanceService.team({ db });
  return rows.map((row) => [
    `${roleLabel(row.bot_role)} (${row.bot_role}/${row.instance_id}): ${statusLabel(row.status)}`,
    `DB=${row.db_health} 대기 작업=${row.role_backlog} 마지막 신호=${age(row.last_heartbeat_at)}`,
    `실행기=${JSON.stringify(row.cli_health_json || {})} 작업공간=${JSON.stringify(row.workspace_health_json || {})}`,
  ].join(" ")).join("\n");
}

function roles() {
  return Object.entries(ROLE_DEFINITIONS).map(([role, value]) => (
    `${roleLabel(role)} (${role}) → 실행 엔진=${value.engine}`
  )).join("\n");
}

async function instance(selector, { db }) {
  const rows = await instanceService.getInstance(selector, { db });
  if (rows.length === 0) return `인스턴스를 찾을 수 없습니다: ${selector}`;
  return rows.map((row) => (
    `${roleLabel(row.bot_role)} (${row.bot_role}/${row.instance_id}) ${statusLabel(row.status)} · PID=비공개 · 가동 시간=${age(row.started_at)} · 현재 작업=${row.current_job_id || "대기"}`
  )).join("\n");
}

module.exports = { ROLE_LABELS, STATUS_LABELS, age, health, instance, roles, team };
