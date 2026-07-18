const taskService = require("../core/taskService");
const taskLogService = require("../core/taskLogService");
const manager = require("../core/manager");
const skillMatcher = require("../skills/skillMatcher");
const skillRegistry = require("../skills/skillRegistry");

/**
 * !dbtask 명령 처리: Skill 매칭 -> Task 생성 -> 원본 요청 메시지 저장 -> war-room mock 파이프라인 실행.
 * @param {import("discord.js").Message} message
 * @param {string} requestText
 */
async function handleDbTask(message, requestText) {
  const matchedSkill = await skillMatcher.matchSkill(requestText);

  let task = await taskService.createTask({
    title: requestText,
    originalRequest: requestText,
    createdBy: message.author.username,
    channelId: message.channel.id,
    selectedSkillId: matchedSkill ? matchedSkill.id : null,
    riskLevel: matchedSkill ? matchedSkill.risk_level : null,
  });
  task = await taskLogService.createTaskThread(message, task);

  await taskLogService.appendTaskMessage(task, {
    taskId: task.id,
    discordMessageId: message.id,
    channelId: message.channel.id,
    authorId: message.author.id,
    authorName: message.author.username,
    role: "user",
    content: requestText,
    client: message.client,
    fallbackChannel: message.channel,
  });

  await manager.runMockPipeline(task, message.client, message.channel);

  return task;
}

/**
 * !dbstatus 명령 처리: task_id로 Task 조회.
 * @param {string} taskId
 */
async function handleDbStatus(taskId) {
  return taskService.getTask(taskId);
}

/**
 * !skill-sync 명령 처리: /skills 폴더를 스캔해 DB와 동기화.
 */
async function handleSkillSync() {
  return skillRegistry.syncSkills();
}

/**
 * !skills 명령 처리: skills 테이블 전체 목록 조회.
 */
async function handleListSkills() {
  return skillRegistry.listSkills();
}

module.exports = {
  handleDbTask,
  handleDbStatus,
  handleSkillSync,
  handleListSkills,
};
