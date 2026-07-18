const logger = require("../../services/logger");
const messageService = require("./messageService");
const taskService = require("./taskService");

const THREAD_AUTO_ARCHIVE_MINUTES = 1440;

function sanitizeThreadName(task) {
  const rawTitle = String(task.title || task.original_request || "task")
    .replace(/\s+/g, " ")
    .trim();
  const title = rawTitle.length > 60 ? `${rawTitle.slice(0, 57)}...` : rawTitle;
  return `${task.id} ${title}`.slice(0, 100);
}

async function createTaskThread(message, task) {
  if (!message || !task || task.discord_thread_id) {
    return task;
  }

  try {
    let thread = null;
    const options = {
      name: sanitizeThreadName(task),
      autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
      reason: `AI Manager task log thread for ${task.id}`,
    };

    if (typeof message.startThread === "function") {
      thread = await message.startThread(options);
    } else if (message.channel && message.channel.threads && typeof message.channel.threads.create === "function") {
      thread = await message.channel.threads.create(options);
    }

    if (!thread || !thread.id) {
      logger.info(`[TaskLog] thread 생성 미지원 채널, fallback 사용: ${task.id}`);
      return task;
    }

    const updatedTask = await taskService.updateTask(task.id, { discord_thread_id: thread.id });
    try {
      await thread.send(`🧵 Task log thread opened for \`${task.id}\`.`);
    } catch (err) {
      logger.error(`[TaskLog] thread 안내 메시지 전송 실패, thread 라우팅 유지: ${task.id}`, err);
    }
    logger.info(`[TaskLog] thread 생성 완료: ${task.id} -> ${thread.id}`);
    return updatedTask || { ...task, discord_thread_id: thread.id };
  } catch (err) {
    logger.error(`[TaskLog] thread 생성 실패, fallback 사용: ${task.id}`, err);
    return task;
  }
}

async function resolveLogChannel(task, client, fallbackChannel) {
  if (task && task.discord_thread_id && client && client.channels && typeof client.channels.fetch === "function") {
    try {
      const channel = await client.channels.fetch(task.discord_thread_id);
      if (channel) {
        const writable = await ensureThreadWritable(channel, task.id);
        if (!writable) {
          return fallbackChannel || null;
        }
        return channel;
      }
    } catch (err) {
      logger.error(`[TaskLog] thread fetch 실패, fallback 사용: ${task.id}`, err);
    }
  }
  return fallbackChannel || null;
}

async function ensureThreadWritable(channel, taskId) {
  if (!channel || channel.archived !== true) {
    return true;
  }

  try {
    if (typeof channel.setArchived === "function") {
      await channel.setArchived(false, `AI Manager task log unarchive for ${taskId}`);
      logger.info(`[TaskLog] archived thread 보관 해제 완료: ${taskId} -> ${channel.id}`);
      return true;
    }
    if (typeof channel.edit === "function") {
      await channel.edit({ archived: false, reason: `AI Manager task log unarchive for ${taskId}` });
      logger.info(`[TaskLog] archived thread 보관 해제 완료: ${taskId} -> ${channel.id}`);
      return true;
    }
  } catch (err) {
    logger.error(`[TaskLog] archived thread 보관 해제 실패, fallback 사용: ${taskId}`, err);
    return false;
  }

  logger.error(`[TaskLog] archived thread 보관 해제 API 없음, fallback 사용: ${taskId}`);
  return false;
}

function formatThreadMessage({ role, authorName, content }) {
  const label = authorName || role || "unknown";
  return `**[${role || "message"}] ${label}**\n${content || ""}`;
}

async function sendToChannel(channel, text) {
  if (!channel || typeof channel.send !== "function") {
    return;
  }

  const value = String(text || "");
  if (value.length <= 1900) {
    await channel.send(value);
    return;
  }

  let remaining = value;
  while (remaining.length > 0) {
    await channel.send(remaining.slice(0, 1900));
    remaining = remaining.slice(1900);
  }
}

async function appendTaskMessage(task, {
  discordMessageId = null,
  channelId = null,
  authorId = null,
  authorName = null,
  role,
  content,
  client = null,
  fallbackChannel = null,
  sendToDiscord = true,
}) {
  const targetChannel = await resolveLogChannel(task, client, fallbackChannel);
  const saved = await messageService.addMessage({
    taskId: task.id,
    discordMessageId,
    channelId: channelId || (targetChannel ? targetChannel.id : null),
    authorId,
    authorName,
    role,
    content,
  });

  if (sendToDiscord) {
    try {
      await sendToChannel(targetChannel, formatThreadMessage({ role, authorName, content }));
    } catch (err) {
      logger.error(`[TaskLog] Discord log 전송 실패: ${task.id}`, err);
    }
  }

  return saved;
}

function formatTaskLog(messages) {
  if (!messages || messages.length === 0) {
    return "(저장된 task 대화 로그 없음)";
  }

  return messages.map((msg) => {
    const createdAt = msg.created_at instanceof Date ? msg.created_at.toISOString() : String(msg.created_at);
    const role = msg.role || "message";
    const author = msg.author_name || "unknown";
    return `[${createdAt}] [${role}] ${author}\n${msg.content}`;
  }).join("\n\n---\n\n");
}

module.exports = {
  createTaskThread,
  appendTaskMessage,
  formatTaskLog,
  _internal: {
    sanitizeThreadName,
    ensureThreadWritable,
    formatThreadMessage,
    sendToChannel,
  },
};
