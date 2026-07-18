const taskService = require("./taskService");
const taskLogService = require("./taskLogService");
const channelService = require("../discord/channelService");

// Phase 2: 실제 Agent 호출 없이 mock 메시지로 war-room 대화 흐름만 구현한다.
// 실제 Planner/Coder/Reviewer/QA 연결은 이후 Phase(5~9)에서 대체된다.
const MOCK_AGENT_STEPS = [
  {
    role: "manager",
    status: "PLANNING",
    content: (task) =>
      `${task.id} 생성했습니다. Planner가 요구사항을 분석합니다.\n` +
      (task.selected_skill_id
        ? `선택된 Skill: **${task.selected_skill_id}** (위험도: ${task.risk_level})`
        : `선택된 Skill: 없음 (generic 처리, 위험도: ${task.risk_level})`),
  },
  {
    role: "planner",
    status: "PLANNED",
    content: (task) =>
      `요구사항 분석 결과 (mock):\n` +
      `1. 요청 내용: ${task.original_request}\n` +
      `2. 예상 작업 범위: 분석 중 (실제 Planner 미연결)\n` +
      `3. 위험도: low`,
  },
  {
    role: "coder",
    status: "CODED",
    content: () =>
      `수정 후보 파일 (mock):\n` +
      `- 실제 Coder 미연결. Phase 5(Codex Adapter)에서 실동작 예정.`,
  },
  {
    role: "reviewer",
    status: "REVIEWED",
    content: () =>
      `리뷰 의견 (mock):\n` +
      `- 실제 코드 변경이 없어 리뷰할 diff가 없습니다. Phase 6에서 실동작 예정.`,
  },
  {
    role: "qa",
    status: "QA_DONE",
    content: () =>
      `테스트 케이스 (mock):\n` +
      `- 실제 QA 실행 전 단계입니다. Phase 9에서 실동작 예정.`,
  },
];

/**
 * Task 생성 직후 war-room에 Manager/Planner/Coder/Reviewer/QA 순서로
 * mock 메시지를 대화처럼 출력하고, 각 단계를 messages 테이블에 기록하며
 * task 상태를 갱신한다.
 * @param {object} task taskService.createTask()가 반환한 Task 레코드
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").TextBasedChannel} fallbackChannel 명령이 입력된 채널
 */
async function runMockPipeline(task, client, fallbackChannel) {
  const warRoomChannel = await channelService.getWarRoomChannel(client, fallbackChannel);

  for (const step of MOCK_AGENT_STEPS) {
    const content = step.content(task);

    await taskLogService.appendTaskMessage(task, {
      taskId: task.id,
      discordMessageId: null,
      channelId: warRoomChannel.id,
      authorId: null,
      authorName: step.role,
      role: step.role,
      content,
      client,
      fallbackChannel: warRoomChannel,
    });

    await taskService.updateStatus(task.id, step.status, step.role);
  }
}

module.exports = {
  runMockPipeline,
};
