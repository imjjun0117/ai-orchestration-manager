const envFilePath = process.env.ENV_FILE || ".env";
require("dotenv").config({ path: envFilePath, override: Boolean(process.env.ENV_FILE) });
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const logger = require("./services/logger");
const { runCommand } = require("./services/shell");
const git = require("./services/git");
const commandHandler = require("./src/discord/commandHandler");
const taskService = require("./src/core/taskService");
const messageService = require("./src/core/messageService");
const approvalService = require("./src/core/approvalService");
const settingsService = require("./src/core/settingsService");
const contextBuilder = require("./src/core/contextBuilder");
const taskLogService = require("./src/core/taskLogService");
const pmOrchestrator = require("./src/core/pmOrchestrator");
const coderAgent = require("./src/agents/coderAgent");
const worker = require("./src/queue/worker");
const skillMatcher = require("./src/skills/skillMatcher");
const skillDiscovery = require("./src/skills/skillDiscovery");
const qaAgent = require("./src/agents/qaAgent");
const skillRegistry = require("./src/skills/skillRegistry");
const agentResultService = require("./src/core/agentResultService");
const roleResolver = require("./src/core/roleResolver");
const processService = require("./src/core/processService");
const workspaceLockService = require("./src/core/workspaceLockService");
const hostIdentity = require("./src/core/hostIdentity");
const { askClaude } = require("./agents/claude");
const { askCodex } = require("./agents/codex");
const { askGemini } = require("./agents/gemini");
const { askGemma } = require("./agents/gemma");

function sanitizeInstanceId(value) {
  return String(value || "default").trim().replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "default";
}

function normalizeCommandPrefix(value) {
  const trimmed = String(value || "!").trim();
  return trimmed || "!";
}

const BOT_INSTANCE_ID = sanitizeInstanceId(process.env.BOT_INSTANCE_ID);
const HOST_INSTANCE_ID = hostIdentity.getHostId();
const COMMAND_PREFIX = normalizeCommandPrefix(process.env.COMMAND_PREFIX);

function normalizeIncomingContent(rawContent) {
  const trimmed = String(rawContent || "").trim();
  if (COMMAND_PREFIX === "!") {
    return trimmed;
  }
  if (trimmed !== COMMAND_PREFIX && !trimmed.startsWith(`${COMMAND_PREFIX} `)) {
    return null;
  }
  const rest = trimmed.slice(COMMAND_PREFIX.length).trimStart();
  if (!rest) {
    return "!";
  }
  return rest.startsWith("!") ? rest : `!${rest}`;
}

function formatCommandExample(command) {
  if (COMMAND_PREFIX === "!") {
    return command;
  }
  return `${COMMAND_PREFIX} ${command.replace(/^!/, "")}`;
}

// 에이전트들이 실제로 코드를 읽고/쓰는 대상 프로젝트 디렉토리의 기본값.
// !project 명령으로 다른 디렉토리를 지정하지 않았을 때 사용된다.
const DEFAULT_WORKSPACE_DIR = path.resolve(process.env.WORKSPACE_DIR || path.join(os.homedir(), "ai-manager-test"));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// 파일 저장 경로 설정
const defaultMemoryDirPath = BOT_INSTANCE_ID === "default"
  ? path.join(__dirname, "logs/agent_memory")
  : path.join(__dirname, "logs/agent_memory", BOT_INSTANCE_ID);
const memoryDirPath = process.env.AGENT_MEMORY_DIR || defaultMemoryDirPath;

if (!fs.existsSync(memoryDirPath)) {
  fs.mkdirSync(memoryDirPath, { recursive: true });
}

// Gemini <-> Codex 피드백 루프 최대 반복 횟수
const MAX_REVISION_ROUNDS = 3;

// !project로 지정한 작업 대상 프로젝트 디렉토리. bot_settings 테이블(workspace_dir 키)에 영속되며,
// 매 호출마다 DB를 조회하지 않도록 여기 캐시해 둔다 (기동 시 로드, !project에서 갱신).
let currentWorkspaceDir = DEFAULT_WORKSPACE_DIR;

// 현재 워크스페이스 디렉토리를 반환
function getWorkspaceDir() {
  return currentWorkspaceDir;
}

// 디렉토리가 없으면 생성하고, git 저장소가 아니면 초기화한다.
async function ensureDirReady(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`디렉토리 생성: ${dir}`);
  }
  const gitDirPath = path.join(dir, ".git");
  if (!fs.existsSync(gitDirPath)) {
    await runCommand("git", ["init"], { cwd: dir, trusted: true });
    logger.info(`git 저장소 초기화 완료: ${dir}`);
  }
}

// 개별 에이전트 1회성 대화 기억 저장/로드 헬퍼
function getAgentMemoryPath(agentName) {
  return path.join(memoryDirPath, `${agentName}_history.json`);
}

function loadAgentMemory(agentName) {
  try {
    const memPath = getAgentMemoryPath(agentName);
    if (fs.existsSync(memPath)) {
      return JSON.parse(fs.readFileSync(memPath, "utf8"));
    }
  } catch (err) {
    logger.error(`${agentName} 메모리 로드 실패`, err);
  }
  return [];
}

function saveAgentMemory(agentName, memory) {
  try {
    const memPath = getAgentMemoryPath(agentName);
    // 최근 15개 대화쌍(대화 기록 30개)만 기억 유지
    const slicedMemory = memory.slice(-30);
    fs.writeFileSync(memPath, JSON.stringify(slicedMemory, null, 2), "utf8");
  } catch (err) {
    logger.error(`${agentName} 메모리 저장 실패`, err);
  }
}

// 대화 기록을 텍스트 폼으로 포맷팅해 주는 헬퍼 함수 (!claude/!codex/!gemini/!gemma 일회성 명령용)
function formatChatContext(historyList) {
  if (!historyList || historyList.length === 0) {
    return "(이전 대화 내역 없음)";
  }
  return historyList
    .map(msg => `[${msg.sender}]: ${msg.content}`)
    .join("\n");
}

// worker.enqueue()의 onQueued 콜백 공통 구현. 앞서 처리돼야 할 작업이 있으면(0보다 크면)
// 채널에 대기 안내를 보낸다 (Phase 4: 여러 사용자의 요청이 겹쳐도 워크스페이스 경합 없이
// 하나씩 순서대로 처리된다는 걸 사용자가 알 수 있도록).
function notifyIfQueued(channel, waitingAhead) {
  if (waitingAhead > 0) {
    const sent = channel.send(`⏳ 현재 다른 에이전트 작업이 ${waitingAhead}개 진행/대기 중이라 순서를 기다립니다...`);
    if (sent && typeof sent.catch === "function") {
      sent.catch((err) => logger.error("대기 안내 전송 실패", err));
    }
  }
}

function notifyIfWatchdog(channel, { label, elapsedMs }) {
  if (channel && typeof channel.send === "function") {
    const sent = channel.send(`⚠️ 작업이 오래 실행 중입니다: ${label} (${Math.round(elapsedMs / 1000)}초 경과)`);
    if (sent && typeof sent.catch === "function") {
      sent.catch((err) => logger.error("watchdog 안내 전송 실패", err));
    }
  }
}

function formatWorkspaceLock(lock) {
  if (!lock) {
    return "알 수 없는 lock";
  }
  const expiresAt = lock.expires_at ? new Date(lock.expires_at).toISOString() : "unknown";
  return `owner=${lock.owner_host_id || "unknown-host"}/${lock.owner_instance_id}:${lock.owner_pid}, task=${lock.task_id || "-"}, label=${lock.command_label || "-"}, expires=${expiresAt}`;
}

async function notifyWorkspaceLockBusy(message, lock) {
  await message.reply(
    "⚠️ 다른 봇 인스턴스가 현재 workspace lock을 보유 중이라 이 작업을 시작하지 않았습니다.\n" +
    `\`${formatWorkspaceLock(lock)}\`\n` +
    "작업이 끝난 뒤 다시 시도하거나, 해당 인스턴스의 로그를 확인해 주세요."
  );
}

async function runWithWorkspaceLock(message, { label, taskId = null, workspaceDir = getWorkspaceDir() }, fn) {
  try {
    return await workspaceLockService.withWorkspaceLock(
      {
        workspaceDir,
        ownerHostId: HOST_INSTANCE_ID,
        ownerInstanceId: BOT_INSTANCE_ID,
        ownerPid: process.pid,
        taskId,
        commandLabel: label,
      },
      fn
    );
  } catch (err) {
    if (workspaceLockService.isLockBusyError(err)) {
      await notifyWorkspaceLockBusy(message, err.lock);
      return null;
    }
    throw err;
  }
}

const ROLE_COMMANDS = Object.freeze({
  "!pm": "pm",
  "!planner": "pm",
  "!coder": "coder",
  "!reviewer": "reviewer",
  "!qa": "qa",
  "!summarizer": "summarizer",
});

const ROLE_LABELS = Object.freeze({
  pm: "PM",
  coder: "Coder",
  reviewer: "Reviewer",
  qa: "QA",
  summarizer: "Summarizer",
});

const DEFERRED_PAUSE_STATUSES = new Set(["PM_PLANNING", "AUTONOMOUS_EXECUTION"]);
const AUTO_RESUME_STATUSES = new Set(["RECEIVED", "PM_PLANNING", "AUTONOMOUS_EXECUTION"]);

function parseRoleCommand(content) {
  for (const [command, role] of Object.entries(ROLE_COMMANDS)) {
    if (content === command) {
      return { command, role, prompt: "" };
    }
    if (content.startsWith(`${command} `)) {
      return { command, role, prompt: content.substring(command.length).trim() };
    }
  }
  return null;
}

function formatRoleBindings(bindings) {
  const lines = bindings.map(binding => {
    const status = binding.valid ? "OK" : "INVALID";
    const agent = binding.agentName || "(미설정)";
    return `- ${binding.role}: ${agent} (${binding.requiredCapability}, ${status})`;
  });
  return `🎭 **Role Bindings**\n${lines.join("\n")}`;
}

function truncateForStatus(value, maxLength = 300) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text || "알 수 없는 오류";
  }
  return `${text.slice(0, maxLength)}...`;
}

function buildHelpGuide() {
  const prefixInfo = COMMAND_PREFIX === "!"
    ? ""
    : `🤖 **Instance:** \`${BOT_INSTANCE_ID}\` / **Prefix:** \`${COMMAND_PREFIX}\`\n` +
      `이 인스턴스에는 예를 들어 \`${formatCommandExample("!ping")}\` 형식으로 명령합니다.\n\n`;
  const feedbackGuide = COMMAND_PREFIX === "!"
    ? "진행 중인 task가 있는 채널에서 `!`로 시작하지 않는 일반 메시지를 보내면, 추가 지시/피드백으로 대화 맥락에 저장됩니다.\n\n"
    : `멀티봇 prefix 모드에서는 prefix가 없는 일반 메시지를 무시합니다. 이 인스턴스에 명령하려면 \`${COMMAND_PREFIX}\` prefix를 사용하세요.\n\n`;
  return (
    "📖 **AI Manager 사용 가이드**\n\n" +
    prefixInfo +
    "**기본 흐름**\n" +
    "1. `!project /path/to/project` 로 작업 대상 프로젝트를 지정합니다.\n" +
    "2. `!task 원하는 작업 내용` 으로 Claude가 계획을 작성하게 합니다.\n" +
    "3. 각 단계에서 `!approve` 로 다음 단계 진행, `!reject` 로 취소/롤백합니다.\n" +
    "4. Gemini가 수정을 제안했지만 그대로 진행하고 싶으면 `!skip` 을 사용합니다.\n\n" +
    "**승인 파이프라인 명령**\n" +
    "`!task 작업 내용` - Claude Manager가 요구사항을 분석하고 계획을 만듭니다.\n" +
    "`!autotask 작업 내용` - PM 자동 루프가 계획, 구현, 리뷰, QA, 최종 요약까지 연속 진행합니다.\n" +
    "`!approve` - 현재 대기 중인 승인 단계를 진행합니다. 계획 승인, Codex 구현 승인, Gemini 리뷰 승인, 최종 커밋 승인에 모두 사용합니다.\n" +
    "`!reject` - 현재 대기 중인 작업을 반려합니다. 코드 변경 단계 이후에는 git 변경사항 롤백을 시도합니다.\n" +
    "`!skip` - Gemini가 revise를 요구한 상태에서 재수정을 건너뛰고 QA/최종 요약 단계로 진행합니다.\n" +
    "`!end` - 진행 중인 task를 현재 안전 체크포인트에서 일시중지합니다.\n" +
    "`!resume TASK-ID` - PAUSED task를 저장된 상태에서 재개합니다.\n" +
    "`!kill TASK-ID` - 현재 실행 중인 CLI 프로세스를 종료하고 사람 판단 상태로 전환합니다.\n" +
    "`!status` - 현재 채널의 진행 중인 task 상태, 라운드, 다음 approve 동작을 확인합니다.\n\n" +
    "**프로젝트/검증 명령**\n" +
    "`!instance` - 현재 응답한 봇 인스턴스 ID, prefix, PID, workspace를 확인합니다.\n" +
    "`!lock` - 현재 workspace DB 전역 락 보유 상태를 확인합니다.\n" +
    "`!project` - 현재 작업 대상 프로젝트 경로를 표시합니다.\n" +
    "`!project /path/to/project` - 작업 대상 프로젝트를 변경합니다. 진행 중인 task가 있으면 변경할 수 없습니다.\n" +
    "`!git status` - 작업 대상 프로젝트의 git status를 확인합니다.\n" +
    "`!git diff` - 현재 변경 diff를 확인합니다. 신규 파일도 포함해 보여줍니다.\n" +
    "`!test` - Claude/Codex/Gemini/Gemma CLI 설치 상태를 진단합니다.\n" +
    "`!log` 또는 `!app-log` - 최근 봇 로그 20줄을 확인합니다.\n" +
    "`!log TASK-ID` - 해당 task의 DB 대화 로그 전체를 확인합니다.\n\n" +
    "**스킬 명령**\n" +
    "`!skill-sync` - `skills/` 디렉토리의 skill.json을 DB와 동기화합니다.\n" +
    "`!skills` - 등록된 skill 목록과 활성 상태, 위험도를 확인합니다.\n" +
    "`!approve-skill SKILL-ID` - AI가 제안한 새 skill 생성을 승인합니다.\n" +
    "`!reject-skill SKILL-ID` - AI가 제안한 새 skill 생성을 반려합니다.\n\n" +
    "**단발 에이전트 명령**\n" +
    "`!run-codex TASK-ID` - 기존 task를 기준으로 Codex Adapter를 단발 실행하고 결과를 agent_results에 저장합니다. 진행 중인 승인 파이프라인이 있으면 차단됩니다.\n" +
    "`!roles` - pm/coder/reviewer/qa/summarizer 역할이 어떤 CLI 에이전트에 연결되어 있는지 확인합니다.\n" +
    "`!set-role ROLE AGENT` - 역할에 연결할 에이전트를 변경합니다. 예: `!set-role reviewer gemini`\n" +
    "`!pm 질문` 또는 `!planner 질문` - PM 역할 에이전트로 계획/분석을 실행합니다.\n" +
    "`!coder 질문` - Coder 역할 에이전트로 코드 작업을 실행합니다.\n" +
    "`!reviewer 질문` - Reviewer 역할 에이전트로 리뷰를 실행합니다.\n" +
    "`!qa 질문` - QA 역할 에이전트로 검증을 실행합니다.\n" +
    "`!summarizer 질문` - Summarizer 역할 에이전트로 요약을 실행합니다.\n" +
    "`!claude`, `!codex`, `!gemini`, `!gemma` - 기존 CLI 직접 호출 호환 명령입니다.\n\n" +
    "**DB 데모/조회 명령**\n" +
    "`!dbtask 작업 내용` - mock war-room 파이프라인으로 DB task를 생성하고 QA_DONE까지 진행합니다.\n" +
    "`!dbstatus TASK-ID` - DB task 상세 상태를 조회합니다.\n\n" +
    "**일반 메시지 처리**\n" +
    feedbackGuide +
    "**주의사항**\n" +
    "- 에이전트 작업은 큐를 통해 한 번에 하나씩 실행됩니다. 앞 작업이 있으면 대기 안내가 표시됩니다.\n" +
    "- `!approve`는 현재 상태에 따라 하는 일이 달라집니다. 헷갈리면 먼저 `!status`를 확인하세요.\n" +
    "- QA 단계에서 `package.json` 또는 `pom.xml`을 감지하면 테스트를 자동 실행합니다. 테스트 러너가 없거나 보안 정책상 막히면 QA는 건너뜁니다.\n" +
    `- 현재 작업 대상 프로젝트: \`${getWorkspaceDir()}\``
  );
}

// !claude/!codex/!gemini 같은 일회성(승인 절차 없는) 대화 명령 실행 전, 대상
// 워크스페이스의 git 상태 스냅샷을 찍어둔다. (승인되지 않은 커밋/변경 감지용)
async function captureGitSnapshot(cwd) {
  const hash = await git.getHeadHash(cwd);
  let status = "";
  try {
    status = await git.getStatus(cwd);
  } catch (err) {
    // git 저장소가 아니거나 조회 실패 시 무시
  }
  return { hash, status };
}

// 일회성 명령 실행 후 스냅샷과 비교하여, 승인 파이프라인(!approve)을 거치지 않고
// 커밋이 생기거나 작업 트리가 변경됐다면 채널에 경고를 남긴다.
// (Gemini가 dev/cms 리포지토리를 스스로 커밋/푸시했던 사고 재발 방지)
async function warnIfUnapprovedGitChange(message, cwd, agentLabel, before) {
  try {
    const afterHash = await git.getHeadHash(cwd);
    const afterStatus = await git.getStatus(cwd);
    const commitHappened = Boolean(before.hash && afterHash && before.hash !== afterHash);
    const treeChanged = afterStatus.trim() !== (before.status || "").trim();

    if (commitHappened || treeChanged) {
      let warning = `🚨 **경고: \`!approve\` 승인 절차 없이 ${agentLabel} 실행 중 Git 상태가 변경되었습니다.**\n`;
      if (commitHappened) {
        warning += `- 새 커밋 감지: \`${before.hash?.slice(0, 7)}\` → \`${afterHash?.slice(0, 7)}\`\n`;
      }
      if (treeChanged) {
        warning += `- 작업 트리 변경 감지. \`!git status\` / \`!git diff\`로 확인해 주세요.\n`;
      }
      warning += `필요 시 \`!reject\`로 롤백하거나 직접 확인 후 조치해 주세요.`;
      await message.channel.send(warning);
      logger.error(`[Git Safety] ${agentLabel} 일회성 호출 중 미승인 git 변경 감지 (cwd: ${cwd})`);
    }
  } catch (err) {
    logger.error("Git 안전성 점검 실패", err);
  }
}

// 긴 메시지를 안전하게 쪼개서 보내거나 파일로 첨부하는 헬퍼 함수
async function sendLongMessage(message, content, replyTo = true) {
  if (!content || content.trim() === "") {
    return replyTo ? message.reply("응답 내용이 비어 있습니다.") : message.channel.send("응답 내용이 비어 있습니다.");
  }

  if (content.length <= 2000) {
    return replyTo ? message.reply(content) : message.channel.send(content);
  }

  if (content.length > 4000) {
    const buffer = Buffer.from(content, "utf-8");
    const attachment = new AttachmentBuilder(buffer, { name: "response.txt" });
    const payload = {
      content: "⚠️ 응답이 너무 길어 파일로 첨부합니다.",
      files: [attachment],
    };
    return replyTo ? message.reply(payload) : message.channel.send(payload);
  }

  const chunks = [];
  let remaining = content;
  while (remaining.length > 0) {
    chunks.push(remaining.substring(0, 1900));
    remaining = remaining.substring(1900);
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && replyTo) {
      await message.reply(chunks[i]);
    } else {
      await message.channel.send(chunks[i]);
    }
  }
}

async function analyzeForSkillProposalAfterCommit(message, task) {
  try {
    const proposal = await skillDiscovery.analyzeForSkillProposal(task, getWorkspaceDir());
    if (proposal.suitable) {
      await agentResultService.saveResult({
        taskId: task.id,
        agentName: "manager",
        resultType: "skill_proposal",
        content: JSON.stringify(proposal),
        modelName: "claude",
      });
      await approvalService.openApproval(task.id, "skill_creation", "manager");

      const commandList = proposal.allowedCommands.map((c) => `\`${c}\``).join(", ") || "(없음)";
      const blockedList = proposal.blockedCommands.map((c) => `\`${c}\``).join(", ") || "(없음)";
      const report =
        `🧠 **[Skill 자동 발견]** 이번 작업이 재사용 가치가 있다고 판단되어 새 Skill을 제안합니다.\n\n` +
        `**ID:** \`${proposal.skillId}\`\n` +
        `**이름:** ${proposal.name}\n` +
        `**설명:** ${proposal.description}\n` +
        `**트리거 키워드:** ${proposal.triggers.join(", ") || "(없음)"}\n` +
        `**위험도:** ${proposal.riskLevel}\n` +
        `**허용 명령어:** ${commandList}\n` +
        `**차단 명령어:** ${blockedList}\n\n` +
        `**Prompt 초안:**\n\`\`\`text\n${proposal.promptMd}\n\`\`\`\n` +
        `**Checklist 초안:**\n\`\`\`text\n${proposal.checklistMd}\n\`\`\`\n\n` +
        `👉 등록하려면 \`!approve-skill ${proposal.skillId}\`, 등록하지 않으려면 \`!reject-skill ${proposal.skillId}\` 를 입력하세요.`;
      await sendLongMessage(message, report, false);
    }
  } catch (err) {
    logger.error("스킬 자동 발견 분석 실패 (커밋 자체는 정상 완료됨)", err);
  }
}

async function appendTaskCommandLog(task, message, content) {
  return taskLogService.appendTaskMessage(task, {
    discordMessageId: message.id,
    channelId: message.channel.id,
    authorId: message.author.id,
    authorName: message.author.username,
    role: "user",
    content,
    client,
    fallbackChannel: message.channel,
  });
}

async function appendTaskSystemLog(task, message, content) {
  return taskLogService.appendTaskMessage(task, {
    discordMessageId: null,
    authorId: null,
    authorName: "AI Manager",
    role: "system",
    content,
    client,
    fallbackChannel: message.channel,
  });
}

function nextActionTextForStatus(status) {
  if (AUTO_RESUME_STATUSES.has(status)) {
    return "자동 루프를 worker 큐에 다시 등록합니다.";
  }
  if (status === "PENDING_FINAL_APPROVAL") {
    return "`!approve`로 커밋하거나 `!reject`로 롤백할 수 있습니다.";
  }
  if (status === "PM_ESCALATION") {
    return "task thread에 사람 지시를 남긴 뒤 후속 작업을 진행하세요.";
  }
  if (String(status || "").startsWith("PENDING_")) {
    return "기존 승인형 파이프라인 상태입니다. `!approve` 또는 `!reject`로 이어갈 수 있습니다.";
  }
  return "상태를 확인한 뒤 후속 명령을 입력하세요.";
}

async function buildResumeReport(task, previousPausedTask) {
  const messages = await messageService.getTaskMessages(task.id);
  const results = await agentResultService.getResultsForTask(task.id);
  const latestByType = new Map();
  for (const result of results) {
    latestByType.set(result.result_type || "unknown", result);
  }
  const latestSummary = ["plan", "code_diff", "review", "qa_report", "summary"]
    .filter((type) => latestByType.has(type))
    .map((type) => `- ${type}: ${latestByType.get(type).agent_name}`)
    .join("\n") || "- 저장된 agent_results 없음";

  return (
    `▶️ **${task.id} 재개됨**\n` +
    `이전 상태: \`${previousPausedTask.paused_from_status || "unknown"}\`\n` +
    `현재 상태: \`${task.status}\`\n` +
    `현재 담당: ${task.current_agent || "(없음)"}\n` +
    `누적 대화: ${messages.length}개\n` +
    `최근 결과:\n${latestSummary}\n\n` +
    nextActionTextForStatus(task.status)
  );
}

async function approveFinalApprovalTask(message, task) {
  const resolvedFinal = await approvalService.resolvePendingAction(task.id, "final_approval", {
    approved: true,
    resolvedBy: message.author.username,
  });
  if (!resolvedFinal) {
    await message.reply("⚠️ 이미 처리된 최종 승인입니다. (다른 요청이 먼저 처리했습니다)");
    return;
  }

  await appendTaskCommandLog(task, message, "!approve (자동 파이프라인 최종 승인, Git commit 요청)");

  const statusMsg = await message.reply("🔄 자동 파이프라인 최종 승인: Git Commit 진행 중...");
  try {
    const commitMsg = `feat: ${task.title}`;
    const gitResult = await git.addAndCommit(commitMsg, getWorkspaceDir());
    const doneTask = await taskService.updateTask(task.id, {
      status: "DONE",
      current_agent: null,
      next_action: null,
    });
    await appendTaskSystemLog(doneTask || task, message, `최종 승인 완료. Git commit이 생성되었습니다.\n\n${gitResult}`);
    await statusMsg.edit(`✅ **자동 파이프라인 Git Commit 완료!**\n\`\`\`text\n${gitResult}\n\`\`\``);
    await analyzeForSkillProposalAfterCommit(message, doneTask || task);
  } catch (err) {
    logger.error("자동 파이프라인 Git Commit 에러", err);
    await appendTaskSystemLog(task, message, `최종 승인 중 Git commit 실패: ${err.message}`);
    await statusMsg.edit(`❌ Git Commit 실패: ${err.message}`);
  }
}

async function rejectFinalApprovalTask(message, task) {
  const resolvedFinal = await approvalService.resolvePendingAction(task.id, "final_approval", {
    approved: false,
    resolvedBy: message.author.username,
    reason: "자동 파이프라인 최종 반려",
  });
  if (!resolvedFinal) {
    await message.reply("⚠️ 이미 처리된 최종 승인입니다. (다른 요청이 먼저 처리했습니다)");
    return;
  }

  await appendTaskCommandLog(task, message, "!reject (자동 파이프라인 최종 반려, Git rollback 요청)");

  const statusMsg = await message.reply("🔄 자동 파이프라인 최종 반려: 코드 변경사항 롤백 중...");
  try {
    await git.discardChanges(getWorkspaceDir());
    const rejectedTask = await taskService.updateTask(task.id, {
      status: "REJECTED",
      current_agent: null,
      next_action: null,
    });
    await appendTaskSystemLog(rejectedTask || task, message, "최종 반려 완료. 워크스페이스 변경사항을 롤백했습니다.");
    await statusMsg.edit("❌ 자동 파이프라인 결과가 반려되어 모든 코드 변경사항이 롤백되었습니다. 작업 세션이 초기화되었습니다.");
  } catch (err) {
    logger.error("자동 파이프라인 Git 롤백 실패 (승인은 이미 처리됨)", err);
    const failedTask = await taskService.updateTask(task.id, { status: "ROLLBACK_FAILED" });
    await appendTaskSystemLog(failedTask || task, message, `최종 반려 승인 처리는 완료됐지만 코드 롤백에 실패했습니다: ${err.message}`);
    await statusMsg.edit(
      `❌ 승인 처리는 완료됐지만 코드 롤백에 실패했습니다: ${err.message}\n` +
      `⚠️ 워크스페이스에 반려되지 않은 변경사항이 남아있을 수 있습니다. \`!git status\`로 직접 확인해 주세요.`
    );
  }
}

async function runRoleCommand(message, role, prompt) {
  const roleLabel = ROLE_LABELS[role] || role;
  const memoryKey = `role-${role}`;
  const memory = loadAgentMemory(memoryKey);
  memory.push({ role: "user", sender: message.author.username, content: prompt });
  const contextText = formatChatContext(memory);

  await worker.enqueue(
    async () => runWithWorkspaceLock(message, { label: `role:${role}` }, async () => {
      let binding;
      try {
        binding = await roleResolver.resolveAgent(role);
      } catch (err) {
        await message.reply(`❌ ${roleLabel} 역할을 실행할 수 없습니다: ${err.message}`);
        return;
      }

      const agentLabel = `${roleLabel} (${binding.agentName})`;
      const statusMsg = await message.reply(`🔄 **[${agentLabel}]** 실행 중...`);

      try {
        let gitBefore = null;
        if (binding.adapter.capabilities.canExec) {
          gitBefore = await captureGitSnapshot(getWorkspaceDir());
        }

        const result = await binding.adapter.invoke(contextText, {
          workspaceDir: getWorkspaceDir(),
          role,
        });

        if (gitBefore) {
          await warnIfUnapprovedGitChange(message, getWorkspaceDir(), agentLabel, gitBefore);
        }

        if (result.exitCode === 0) {
          memory.push({ role: "assistant", sender: agentLabel, content: result.text });
          saveAgentMemory(memoryKey, memory);

          await statusMsg.delete();
          await sendLongMessage(message, result.text);
          return;
        }

        const errorText = result.raw?.stderr || result.raw?.errorMessage || result.raw?.stdout || result.text;
        await statusMsg.edit(
          `❌ **[${agentLabel}]** 실행 실패 (${result.durationMs}ms): ${truncateForStatus(errorText)}`
        );
      } catch (err) {
        logger.error(`!${role} 역할 명령 실행 오류`, err);
        await statusMsg.edit(`❌ **[${agentLabel}]** 실행 실패: ${truncateForStatus(err.message)}`);
      }
    }),
    {
      onQueued: (n) => notifyIfQueued(message.channel, n),
      label: `role:${role}`,
      onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
    }
  );
}

// Gemini 리뷰 승인 이후 Gemma 최종 요약을 생성하고 커밋 승인 대기 상태로 전환하는 헬퍼 함수.
// 주의: 이 함수는 자체적으로 worker.enqueue()를 호출하지 않는다. 호출부(!approve의 finalize
// 분기, !skip)가 이미 각자 자신만의 worker.enqueue() 클로저 "안에서" 이 함수를 호출하는
// 구조이기 때문이다 - 큐 job 안에서 또 enqueue()를 호출하면, 바깥 job이 안쪽 job의 완료를
// 기다리는 동안 워커의 처리 루프(isRunning 플래그로 한 번에 하나만 돎)는 안쪽 job을 절대
// 꺼내 실행하지 못해 영구히 멈춘다(교착 상태). 그래서 이 함수를 부르는 곳은 반드시 이미 큐
// job 실행 중인 컨텍스트여야 한다.
// skippedRevision: !skip으로 Gemini의 수정 요청을 건너뛰고 도달한 경우 true
async function finalizeAfterReview(message, task, skippedRevision) {
  const gemmaMsg = await message.reply("🔄 **[Gemma]** 최종 변경사항을 요약하고 있습니다...");
  let gemmaResponse = "";
  let diff = "";
  try {
    diff = await git.getDiff(getWorkspaceDir());
    gemmaResponse = await askGemma(`최종 Git Diff를 한글로 한 줄 요약해줘:\n\n\`\`\`diff\n${diff}\n\`\`\``, { cwd: getWorkspaceDir(), taskId: task.id });
    await messageService.addMessage({
      taskId: task.id,
      discordMessageId: null,
      channelId: message.channel.id,
      authorId: null,
      authorName: "Gemma4 (Summarizer)",
      role: "assistant",
      content: gemmaResponse,
    });
    await gemmaMsg.edit("✅ **[Gemma]** 최종 요약 완료.");
  } catch (err) {
    logger.error("Gemma 최종 요약 에러", err);
    await gemmaMsg.edit(`⚠️ Gemma 요약 실패: ${err.message}. 요약 없이 다음 단계로 진행합니다.`);
  }

  await taskService.updateTask(task.id, { status: "PENDING_COMMIT_APPROVAL" });
  await approvalService.openApproval(task.id, "commit_approval", "gemma");

  const refreshedTask = await taskService.getTask(task.id);

  let report = "### 🛠️ 멀티 에이전트 협업 완료 보고서\n\n";
  report += `**📄 최종 요약:** ${gemmaResponse || "(요약 실패)"}\n\n`;
  report += `총 ${refreshedTask.round}회의 Gemini↔Codex 피드백 라운드를 거쳤습니다.`;
  if (skippedRevision) {
    report += " (마지막 Gemini 피드백은 `!skip`으로 건너뛰었습니다.)";
  }
  report += "\n\n이 결과물이 만족스러우면 `!approve` 를 입력하여 최종 커밋을 진행하시고, 되돌리려면 `!reject` 를 입력하십시오.";

  await sendLongMessage(message, report, false);
  await message.channel.send("📋 **최종 반영된 코드 변경점 (Git Diff):**");
  await sendLongMessage(message, `\`\`\`diff\n${diff}\n\`\`\``, false);
}

// Gemini 리뷰 피드백이든 QA(테스트) 실패 피드백이든, "Codex가 그 피드백을 반영해 코드를
// 재수정하고 PENDING_CODEX_APPROVAL로 돌아간다"는 동일한 절차를 공유한다. Phase 7 이전에는
// Gemini 리뷰 재수정 분기에만 이 로직이 있었는데, QA 실패 시에도 같은 재수정 루프를
// 그대로 재사용하기 위해 공통 함수로 뽑았다 (동작 자체는 기존 revise 분기와 동일하다).
// @param {object} task
// @param {object} params
// @param {number} params.newRound 이번이 몇 번째 재수정 라운드인지 (task.round + 1)
// @param {string} params.instruction Codex에게 줄 구체적 지시문
// @param {string} params.progressLabel 진행 메시지에 노출할 라벨 (예: "Gemini의 피드백", "QA 실패 피드백")
// @param {object} params.failureRollback Codex 호출 자체가 실패했을 때(기술적 오류) 되돌릴 상태
// @param {string} params.failureRollback.status
// @param {string|null} params.failureRollback.nextAction
// @param {string} params.failureRollback.approvalAction
// @param {string} params.failureRollback.approvalRequestedBy
// @param {string} params.failureRollback.label 사용자에게 보여줄 되돌림 상태 설명
async function runCodexRevisionRound(message, task, { newRound, instruction, progressLabel, failureRollback }) {
  await taskService.updateTask(task.id, { round: newRound });

  const reviseMsg = await message.reply(`🔄 **[Codex]** ${progressLabel}(Round ${newRound})을 반영하여 코드를 재수정하고 있습니다...`);
  try {
    const revisionPrompt = await contextBuilder.buildCoderContext(task, { instruction, cwd: getWorkspaceDir() });
    const revisionResponse = await askCodex(revisionPrompt, { cwd: getWorkspaceDir(), taskId: task.id });

    await messageService.addMessage({
      taskId: task.id,
      discordMessageId: null,
      channelId: message.channel.id,
      authorId: null,
      authorName: `Codex (Developer - ${newRound}차 수정)`,
      role: "assistant",
      content: revisionResponse,
    });

    const diff = await git.getDiff(getWorkspaceDir());
    await agentResultService.saveResult({
      taskId: task.id,
      agentName: "coder",
      resultType: "code_diff",
      content: revisionResponse,
      modelName: "codex",
    });

    await taskService.updateTask(task.id, { status: "PENDING_CODEX_APPROVAL" });
    await approvalService.openApproval(task.id, "codex_approval", "codex");

    await reviseMsg.edit(`✅ **[Codex]** ${newRound}차 수정 완료. 아래 응답과 Diff를 확인해주세요.`);
    await sendLongMessage(message, revisionResponse, false);
    await message.channel.send(`📋 **Git Diff (${newRound}차 수정 반영):**`);
    await sendLongMessage(message, `\`\`\`diff\n${diff}\n\`\`\``, false);
    await message.channel.send("👉 Gemini 재검토로 진행하려면 `!approve`, 취소 및 롤백하려면 `!reject` 를 입력하세요.");
  } catch (err) {
    logger.error("Codex 재수정 에러", err);
    await reviseMsg.edit(`❌ Codex 재수정 실패: ${err.message}\n${failureRollback.label} 상태로 되돌립니다. 다시 \`!approve\` 를 시도해주세요.`);
    await taskService.updateTask(task.id, {
      round: task.round,
      status: failureRollback.status,
      next_action: failureRollback.nextAction,
    });
    await approvalService.openApproval(task.id, failureRollback.approvalAction, failureRollback.approvalRequestedBy);
  }
}

// Phase 7: QA(테스트) 게이트. Gemini 리뷰가 "finalize"로 판정한 뒤(또는 !skip으로 Gemini
// 재수정 요청을 건너뛴 뒤) 곧바로 Gemma 최종 요약으로 가는 대신, 먼저 워크스페이스에서
// 자동 감지한 테스트를 실행한다. 테스트가 실패하면 Gemma 요약으로 넘어가지 않고
// runCodexRevisionRound로 Codex 재수정을 트리거해 실패 로그를 피드백으로 전달한다.
// 테스트가 통과(또는 건너뜀)하면 기존과 동일하게 finalizeAfterReview로 진행한다.
async function runQaGatedFinalize(message, task, skippedRevision) {
  const qaMsg = await message.reply("🔄 **[QA]** 테스트를 자동 실행하고 있습니다...");
  const qaResult = await qaAgent.runQaAgent(task, { cwd: getWorkspaceDir() });

  await messageService.addMessage({
    taskId: task.id,
    discordMessageId: null,
    channelId: message.channel.id,
    authorId: null,
    authorName: "QA",
    role: "assistant",
    content: qaResult.output,
  });

  if (!qaResult.passed) {
    await qaMsg.edit("❌ **[QA]** 테스트가 실패했습니다. Codex에게 수정 피드백을 전달합니다...");
    await runCodexRevisionRound(message, task, {
      newRound: task.round + 1,
      instruction:
        `아래는 자동 테스트(QA) 실행 결과다. 실패 원인을 분석하고 코드를 수정해 테스트가 통과하도록 해줘.\n\n${qaResult.output}`,
      progressLabel: "QA 테스트 실패",
      failureRollback: {
        status: "PENDING_GEMINI_APPROVAL",
        nextAction: "finalize",
        approvalAction: "gemini_approval",
        approvalRequestedBy: "gemini",
        label: "Gemini 리뷰 승인(최종 확정)",
      },
    });
    return;
  }

  await qaMsg.edit(
    qaResult.skipped
      ? "⏭️ **[QA]** 테스트를 실행하지 않고 건너뛰었습니다."
      : "✅ **[QA]** 테스트를 통과했습니다."
  );
  await finalizeAfterReview(message, task, skippedRevision);
}

client.once("ready", async () => {
	  try {
    const savedWorkspaceDir = await settingsService.getSetting("workspace_dir");
    if (savedWorkspaceDir) {
      currentWorkspaceDir = path.resolve(savedWorkspaceDir);
    }
	  } catch (err) {
    logger.error("workspace_dir 설정 로드 실패 (기본값 사용)", err);
  }
  await ensureDirReady(getWorkspaceDir());
  process.title = `ai-manager:${BOT_INSTANCE_ID}`;
  logger.info(
    `AI Manager Bot Online: ${client.user.tag} ` +
    `(host=${HOST_INSTANCE_ID}, instance=${BOT_INSTANCE_ID}, prefix=${COMMAND_PREFIX}, env=${envFilePath}, workspace=${getWorkspaceDir()}, pid=${process.pid})`
  );
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = normalizeIncomingContent(message.content);
  if (content === null) {
    return;
  }

  // 0. help / !help - 사용 가이드
  if (content === "help" || content === "!help" || content === "도움말" || content === "!도움말") {
    logger.info(`help command received from ${message.author.tag}`);
    await sendLongMessage(message, buildHelpGuide());
    return;
  }

  // 1. !ping
  if (content === "!ping") {
    logger.info(`ping command received from ${message.author.tag}`);
    await message.reply("pong");
    return;
  }

  if (content === "!instance") {
    logger.info(`instance command received from ${message.author.tag}`);
    await message.reply(
      `🤖 **AI Manager Instance**\n` +
      `- instance: \`${BOT_INSTANCE_ID}\`\n` +
      `- host: \`${HOST_INSTANCE_ID}\`\n` +
      `- bot: \`${client.user.tag}\`\n` +
      `- prefix: \`${COMMAND_PREFIX}\`\n` +
      `- pid: \`${process.pid}\`\n` +
      `- workspace: \`${getWorkspaceDir()}\``
    );
    return;
  }

  if (content === "!lock") {
    logger.info(`lock command received from ${message.author.tag}`);
    const lock = await workspaceLockService.getLock(getWorkspaceDir());
    if (!lock) {
      await message.reply(`🔓 현재 workspace lock이 없습니다.\nworkspace: \`${getWorkspaceDir()}\``);
      return;
    }
    const active = lock.expires_at && new Date(lock.expires_at).getTime() > Date.now();
    await message.reply(
      `${active ? "🔒" : "⌛"} **Workspace Lock ${active ? "ACTIVE" : "EXPIRED"}**\n` +
      `workspace: \`${getWorkspaceDir()}\`\n` +
      `\`${formatWorkspaceLock(lock)}\``
    );
    return;
  }

  // 2. !status (이 채널에 진행 중인 레거시 파이프라인 태스크 상태 조회, DB 기반)
  if (content === "!status") {
    logger.info(`status command received from ${message.author.tag}`);
    const task = await taskService.getActiveTaskForChannel(message.channel.id);
    if (!task) {
      await message.reply("ℹ️ 이 채널에 진행 중인 태스크가 없습니다. `!task 작업 내용`으로 새 작업을 시작할 수 있습니다.");
      return;
    }

    const taskMessages = await messageService.getTaskMessages(task.id);
    let statusMsg = `ℹ️ **현재 태스크(${task.id}) 상태:** \`${task.status}\`\n`;
    statusMsg += `작업 주제: "${task.title}"\n`;
    statusMsg += `누적 대화 내역 수: ${taskMessages.length}개\n`;
    statusMsg += `Gemini↔Codex 피드백 라운드: ${task.round}/${MAX_REVISION_ROUNDS}\n`;
    if (task.status === "PENDING_GEMINI_APPROVAL") {
      statusMsg += `다음 \`!approve\` 시 동작: ${task.next_action === "revise" ? "Codex 재수정 요청" : "최종 요약 및 커밋 승인 단계로 이동"}\n`;
    } else if (task.status === "PENDING_FINAL_APPROVAL") {
      statusMsg += "자동 파이프라인이 완료되어 최종 승인 대기 중입니다. `!approve`로 커밋하거나 `!reject`로 롤백할 수 있습니다.\n";
    } else if (task.status === "PM_ESCALATION") {
      statusMsg += "PM 자동 루프가 사람 판단을 요청한 상태입니다. task thread와 `!log TASK-ID`를 확인하세요.\n";
    }
    await message.reply(statusMsg);
    return;
  }

  // 2.05 !end - 진행 중인 task를 일시중지한다. 실행 중인 CLI는 즉시 죽이지 않고
  // PM 자동 루프의 다음 안전 체크포인트에서 PAUSED로 전환한다.
  if (content === "!end") {
    logger.info(`end command received from ${message.author.tag}`);
    const task = await taskService.getActiveTaskForChannel(message.channel.id);
    if (!task) {
      await message.reply("⚠️ 이 채널에 일시중지할 수 있는 진행 중인 태스크가 없습니다.");
      return;
    }

    await appendTaskCommandLog(task, message, "!end (task 일시중지 요청)");

    if (DEFERRED_PAUSE_STATUSES.has(task.status)) {
      const updated = await taskService.requestPause(task.id);
      await appendTaskSystemLog(updated || task, message, "일시중지 요청을 받았습니다. 현재 단계가 끝나는 다음 안전 체크포인트에서 PAUSED로 전환합니다.");
      await message.reply(`⏸️ **${task.id}** 일시중지를 요청했습니다. 현재 단계가 끝나면 PAUSED로 전환됩니다.\n재개: \`!resume ${task.id}\``);
      return;
    }

    const paused = await taskService.pauseTask(task.id, task.status);
    await appendTaskSystemLog(paused || task, message, `즉시 일시중지했습니다. 이전 상태: ${task.status}`);
    await message.reply(`⏸️ **${task.id}** 일시중지 완료. 재개: \`!resume ${task.id}\``);
    return;
  }

  // 2.06 !resume TASK-ID - PAUSED task를 저장된 상태로 복원한다.
  if (content === "!resume" || content.startsWith("!resume ")) {
    const taskId = content.substring("!resume".length).trim();
    if (!taskId) {
      await message.reply("사용법: `!resume TASK-ID`");
      return;
    }
    logger.info(`resume command received: ${taskId}`);

    const pausedTask = await taskService.getTask(taskId);
    if (!pausedTask) {
      await message.reply(`❌ \`${taskId}\` 에 해당하는 Task를 찾을 수 없습니다.`);
      return;
    }
    if (pausedTask.status !== "PAUSED") {
      await message.reply(`⚠️ \`${taskId}\` 는 PAUSED 상태가 아닙니다. 현재 상태: \`${pausedTask.status}\``);
      return;
    }

	    await worker.enqueue(
	      () => runWithWorkspaceLock(message, { label: `resume:${taskId}`, taskId }, async () => {
	        const otherOccupiedTask = await taskService.getAnyOccupiedTask({ excludeTaskId: taskId });
	        if (otherOccupiedTask) {
	          await message.reply(`⚠️ 다른 진행 중이거나 일시중지된 태스크가 있어 재개할 수 없습니다: **${otherOccupiedTask.id}** (상태: ${otherOccupiedTask.status})`);
	          return;
	        }
	
	        const resumedTask = await taskService.resumeTask(taskId);
	        if (!resumedTask) {
	          await message.reply("⚠️ 재개할 수 없습니다. 일시중지 상태가 이미 변경되었을 수 있습니다.");
	          return;
	        }
	
	        await appendTaskCommandLog(resumedTask, message, `!resume ${taskId} (task 재개)`);
	        await appendTaskSystemLog(resumedTask, message, `task를 재개했습니다. 복원 상태: ${resumedTask.status}`);
	        await sendLongMessage(message, await buildResumeReport(resumedTask, pausedTask));
	
	        if (AUTO_RESUME_STATUSES.has(resumedTask.status)) {
	          await pmOrchestrator.runAutoLoop(resumedTask, {
	            client,
	            fallbackChannel: message.channel,
	            cwd: getWorkspaceDir(),
	            maxRevisionRounds: MAX_REVISION_ROUNDS,
	          });
	        }
	      }),
	      {
	        onQueued: (n) => notifyIfQueued(message.channel, n),
	        label: `resume:${taskId}`,
	        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
	      }
	    );
	    return;
	  }

  // 2.07 !kill TASK-ID - 현재 실행 중인 CLI 프로세스를 종료하고 PM_ESCALATION으로 전환한다.
  if (content === "!kill" || content.startsWith("!kill ")) {
    const taskId = content.substring("!kill".length).trim();
    if (!taskId) {
      await message.reply("사용법: `!kill TASK-ID`");
      return;
    }
    logger.info(`kill command received: ${taskId}`);

    const task = await taskService.getTask(taskId);
    if (!task) {
      await message.reply(`❌ \`${taskId}\` 에 해당하는 Task를 찾을 수 없습니다.`);
      return;
    }
    if (!task.current_pid) {
      await message.reply(`ℹ️ \`${taskId}\` 에 기록된 실행 중 PID가 없습니다.`);
      return;
    }
    if (task.current_host_id && task.current_host_id !== HOST_INSTANCE_ID) {
      await message.reply(
        `⚠️ \`${taskId}\` 의 실행 프로세스는 다른 host에서 시작되었습니다.\n` +
        `현재 host: \`${HOST_INSTANCE_ID}\`, process host: \`${task.current_host_id}\`\n` +
        "원격 host 프로세스는 이 인스턴스에서 직접 종료할 수 없습니다."
      );
      return;
    }

    await appendTaskCommandLog(task, message, `!kill ${taskId} (PID ${task.current_pid}, PGID ${task.current_pgid || "-"} 종료 요청)`);

    try {
      const result = await processService.killProcessTree({
        pid: task.current_pid,
        pgid: task.current_pgid,
      });
      if (result.alreadyExited) {
        const cleaned = await taskService.updateTask(task.id, {
          current_pid: null,
          current_pgid: null,
          current_host_id: null,
          current_owner_instance_id: null,
        });
        await appendTaskSystemLog(cleaned || task, message, `PID ${result.pid}${result.pgid ? ` / PGID ${result.pgid}` : ""}는 이미 종료되어 stale process 정보를 정리했습니다.`);
        await message.reply(`ℹ️ PID ${result.pid}${result.pgid ? ` / PGID ${result.pgid}` : ""}는 이미 종료되어 \`${task.id}\`의 process 정보를 정리했습니다.`);
        return;
      }

      const escalated = await taskService.updateTask(task.id, {
        status: "PM_ESCALATION",
        current_agent: "pm",
        current_pid: null,
        current_pgid: null,
        current_host_id: null,
        current_owner_instance_id: null,
        next_action: "killed",
      });
      await appendTaskSystemLog(
        escalated || task,
        message,
        `PID ${result.pid}${result.pgid ? ` / PGID ${result.pgid}` : ""} 종료 요청 완료. ${result.usedProcessGroup ? "process group에 " : ""}SIGTERM${result.sigkillSent ? " 후 SIGKILL" : ""}을 전송했고 PM_ESCALATION으로 전환했습니다.`
      );
      await message.reply(`🛑 **${task.id}** PID ${result.pid}${result.pgid ? ` / PGID ${result.pgid}` : ""} 종료 요청 완료. 상태를 \`PM_ESCALATION\`으로 전환했습니다.`);
    } catch (err) {
      logger.error("!kill 실행 실패", err);
      await appendTaskSystemLog(task, message, `PID ${task.current_pid}${task.current_pgid ? ` / PGID ${task.current_pgid}` : ""} 종료 실패: ${err.message}`);
      await message.reply(`❌ PID 종료 실패: ${err.message}`);
    }
    return;
  }

  // 2.1 !dbstatus TASK-ID (Phase 1: PostgreSQL 기반 Task 조회, !dbtask 데모 파이프라인 전용)
  if (content.startsWith("!dbstatus")) {
    const taskId = content.substring("!dbstatus".length).trim();
    if (!taskId) {
      await message.reply("사용법: `!dbstatus TASK-ID`");
      return;
    }
    logger.info(`dbstatus command received: ${taskId}`);
    try {
      const task = await commandHandler.handleDbStatus(taskId);
      if (!task) {
        await message.reply(`❌ \`${taskId}\` 에 해당하는 Task를 찾을 수 없습니다.`);
        return;
      }
      await message.reply(
        `📋 **${task.id}**\n` +
        `상태: ${task.status}\n` +
        `요청: ${task.original_request}\n` +
        `선택된 Skill: ${task.selected_skill_id || "없음 (generic)"} (위험도: ${task.risk_level})\n` +
        `생성자: ${task.created_by}\n` +
        `생성일: ${task.created_at}`
      );
    } catch (err) {
      logger.error("!dbstatus 실행 오류", err);
      await message.reply(`❌ DB 조회 실패: ${err.message}`);
    }
    return;
  }

  // 2.2 !skill-sync (Phase 3: /skills 폴더 스캔 후 DB 동기화)
  if (content === "!skill-sync") {
    logger.info(`skill-sync command received from ${message.author.tag}`);
    try {
      const skills = await commandHandler.handleSkillSync();
      const list = skills.map((s) => `- ${s.id} (${s.name})`).join("\n") || "(스캔된 skill 없음)";
      await message.reply(`✅ Skill 동기화 완료 (${skills.length}개)\n${list}`);
    } catch (err) {
      logger.error("!skill-sync 실행 오류", err);
      await message.reply(`❌ Skill 동기화 실패: ${err.message}`);
    }
    return;
  }

  // 2.3 !skills (Phase 3: skills 테이블 목록 조회)
  if (content === "!skills") {
    logger.info(`skills command received from ${message.author.tag}`);
    try {
      const skills = await commandHandler.handleListSkills();
      if (skills.length === 0) {
        await message.reply("등록된 Skill이 없습니다. `!skill-sync`를 먼저 실행해 주세요.");
        return;
      }
      const list = skills
        .map((s) => `${s.id} / ${s.enabled ? "enabled" : "disabled"} / ${s.risk_level}`)
        .join("\n");
      await message.reply(`📋 **등록된 Skill 목록**\n\`\`\`text\n${list}\n\`\`\``);
    } catch (err) {
      logger.error("!skills 실행 오류", err);
      await message.reply(`❌ Skill 목록 조회 실패: ${err.message}`);
    }
    return;
  }

  // 2.4 !roles / !set-role (Phase 4: 역할 기반 CLI 라우팅)
  if (content === "!roles") {
    logger.info(`roles command received from ${message.author.tag}`);
    try {
      const bindings = await roleResolver.listRoleBindings();
      await message.reply(formatRoleBindings(bindings));
    } catch (err) {
      logger.error("!roles 실행 오류", err);
      await message.reply(`❌ 역할 목록 조회 실패: ${err.message}`);
    }
    return;
  }

  if (content.startsWith("!set-role")) {
    const parts = content.split(/\s+/).filter(Boolean);
    if (parts.length !== 3) {
      await message.reply(
        `사용법: \`!set-role ROLE AGENT\`\n` +
        `ROLE: ${roleResolver.VALID_ROLES.join(", ")}\n` +
        `AGENT: ${roleResolver.VALID_AGENTS.join(", ")}`
      );
      return;
    }

    const [, role, agentName] = parts;
    logger.info(`set-role command received: ${role} -> ${agentName}`);
    try {
      const binding = await roleResolver.setRoleBinding(role, agentName, message.author.username);
      await message.reply(
        `✅ 역할 바인딩 변경 완료: \`${binding.role}\` -> \`${binding.agentName}\` ` +
        `(${binding.requiredCapability})`
      );
    } catch (err) {
      logger.error("!set-role 실행 오류", err);
      await message.reply(`❌ 역할 바인딩 변경 실패: ${err.message}`);
    }
    return;
  }

  // 2.5 !project [경로] - 에이전트들이 실제로 코드를 읽고/쓰는 대상 프로젝트 디렉토리 조회/변경
  if (content === "!project" || content.startsWith("!project ")) {
    logger.info(`project command received from ${message.author.tag}`);

    if (content === "!project") {
      await message.reply(`📁 **현재 작업 대상 프로젝트 디렉토리:**\n\`${getWorkspaceDir()}\``);
      return;
    }

    const occupiedTask = await taskService.getAnyOccupiedTask();
    if (occupiedTask) {
      await message.reply(`⚠️ 진행 중이거나 일시중지된 태스크가 있어 프로젝트 경로를 변경할 수 없습니다: **${occupiedTask.id}** (상태: ${occupiedTask.status})`);
      return;
    }

    let newDir = content.substring("!project ".length).trim();
    if (newDir.startsWith("~")) {
      newDir = path.join(os.homedir(), newDir.slice(1));
    }
    newDir = path.resolve(newDir);

	    try {
	      await runWithWorkspaceLock(message, { label: "!project" }, async () => {
	        const occupiedDuringLock = await taskService.getAnyOccupiedTask();
	        if (occupiedDuringLock) {
	          await message.reply(`⚠️ 진행 중이거나 일시중지된 태스크가 있어 프로젝트 경로를 변경할 수 없습니다: **${occupiedDuringLock.id}** (상태: ${occupiedDuringLock.status})`);
	          return;
	        }
	        await ensureDirReady(newDir);
	        currentWorkspaceDir = newDir;
	        await settingsService.setSetting("workspace_dir", newDir);
	        logger.info(`워크스페이스 디렉토리 변경: ${newDir}`);
	        await message.reply(`✅ 작업 대상 프로젝트 디렉토리가 변경되었습니다:\n\`${newDir}\``);
	      });
	    } catch (err) {
      logger.error("!project 디렉토리 변경 실패", err);
      await message.reply(`❌ 디렉토리 변경/초기화 실패: ${err.message}`);
    }
    return;
  }

  // 3. !test
  if (content === "!test") {
    logger.info(`test command received from ${message.author.tag}`);
    const statusMsg = await message.reply("🔄 로컬 CLI 환경 진단 중...");

    const clis = [
      { name: "Claude Code", bin: "claude", versionArgs: ["-v"] },
      { name: "Codex CLI", bin: "codex", versionArgs: ["--version"] },
      { name: "Antigravity(agy)", bin: "agy", versionArgs: ["--version"] },
      { name: "Ollama/Gemma4", bin: "ollama", versionArgs: ["--version"] }
    ];

    let report = "### 🛠️ 로컬 AI 에이전트 CLI 상태 보고서\n\n";
    report += "| 에이전트 이름 | 설치 경로 | 버전 정보 | 상태 |\n";
    report += "| :--- | :--- | :--- | :---: |\n";

    // 시스템 CLI 설치 여부 진단이라 특정 프로젝트와 무관하므로 봇 자신의 디렉토리를 cwd로 사용한다.
    const diagCwd = __dirname;

    for (const cli of clis) {
      let path = "N/A";
      let version = "N/A";
      let status = "❌ 미설치";

      try {
        const pathRes = await runCommand("which", [cli.bin], { cwd: diagCwd, trusted: true });
        path = pathRes.stdout;

        const verRes = await runCommand(cli.bin, cli.versionArgs, { cwd: diagCwd, trusted: true });
        version = verRes.stdout.split("\n")[0] || verRes.stderr.split("\n")[0];
        status = "✅ 정상";
      } catch (err) {
        logger.error(`${cli.name} 진단 실패`, err);
      }

      report += `| **${cli.name}** | \`${path}\` | \`${version}\` | ${status} |\n`;
    }

    await statusMsg.edit(report);
    return;
  }

  // 4. !autotask [작업 요청] (Phase 6: PM 자동 루프 파이프라인)
  if (content.startsWith("!autotask ")) {
    const occupiedTask = await taskService.getAnyOccupiedTask();
    if (occupiedTask) {
      const occupiedInThisChannel = await taskService.getOccupiedTaskForChannel(message.channel.id);
      if (occupiedInThisChannel) {
        await message.reply(`⚠️ 이미 진행 중이거나 일시중지된 태스크가 있습니다: **${occupiedInThisChannel.id}** (상태: ${occupiedInThisChannel.status})`);
      } else {
        await message.reply(`⚠️ 다른 채널에 진행 중이거나 일시중지된 태스크가 있어 새 자동 태스크를 시작할 수 없습니다: **${occupiedTask.id}** (상태: ${occupiedTask.status})`);
      }
      return;
    }

    const requestText = content.substring("!autotask ".length).trim();
    if (!requestText) {
      await message.reply("사용법: `!autotask 작업 내용`");
      return;
    }

    logger.info(`autotask command received: ${requestText}`);
	    const statusMsg = await message.reply("🔄 PM 자동 루프 태스크를 생성하고 있습니다...");
	
	    try {
	      await worker.enqueue(
	        () => runWithWorkspaceLock(message, { label: "!autotask" }, async () => {
	          const occupiedDuringLock = await taskService.getAnyOccupiedTask();
	          if (occupiedDuringLock) {
	            await statusMsg.edit(`⚠️ 진행 중이거나 일시중지된 태스크가 있어 새 자동 태스크를 시작하지 않았습니다: **${occupiedDuringLock.id}** (상태: ${occupiedDuringLock.status})`);
	            return;
	          }
	
	          const matchedSkill = await skillMatcher.matchSkill(requestText);
	          let task = await taskService.createTask({
	            title: requestText,
	            originalRequest: requestText,
	            createdBy: message.author.username,
	            channelId: message.channel.id,
	            selectedSkillId: matchedSkill ? matchedSkill.id : null,
	            riskLevel: matchedSkill ? matchedSkill.risk_level : null,
	          });
	          task = await taskService.updateTask(task.id, { status: "RECEIVED", current_agent: "pm" });
	          task = await taskLogService.createTaskThread(message, task);
	
	          await taskLogService.appendTaskMessage(task, {
	            discordMessageId: message.id,
	            channelId: message.channel.id,
	            authorId: message.author.id,
	            authorName: message.author.username,
	            role: "user",
	            content: requestText,
	            client,
	            fallbackChannel: message.channel,
	          });
	
	          await statusMsg.edit(
	            `✅ 자동 태스크 생성됨: **${task.id}**\n` +
	            `상태: ${task.status}\n` +
	            (matchedSkill
	              ? `선택된 Skill: **${matchedSkill.id}** (위험도: ${matchedSkill.risk_level})\n`
	              : "선택된 Skill: 없음\n") +
	            "`!log " + task.id + "` 로 진행 로그를 확인할 수 있습니다."
	          );
	
	          await pmOrchestrator.runAutoLoop(task, {
	            client,
	            fallbackChannel: message.channel,
	            cwd: getWorkspaceDir(),
	            maxRevisionRounds: MAX_REVISION_ROUNDS,
	          });
	        }),
	        {
	          onQueued: (n) => notifyIfQueued(message.channel, n),
	          label: "!autotask",
	          onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
	        }
	      );
    } catch (err) {
      logger.error("!autotask 실행 오류", err);
      await statusMsg.edit(`❌ 자동 태스크 실행 실패: ${err.message}`);
    }
    return;
  }

  // 4.1 !task [작업 요청] (Claude Manager 계획 수립, DB 기반 레거시 파이프라인)
  if (content.startsWith("!task ")) {
    const occupiedTask = await taskService.getAnyOccupiedTask();
    if (occupiedTask) {
      const occupiedInThisChannel = await taskService.getOccupiedTaskForChannel(message.channel.id);
      const stateHint = occupiedInThisChannel
        ? `**${occupiedInThisChannel.id}** \`${occupiedInThisChannel.status}\` 상태`
        : `다른 채널의 **${occupiedTask.id}** \`${occupiedTask.status}\` 상태`;
      await message.reply(`⚠️ 현재 진행 중이거나 일시중지된 태스크가 있습니다. (${stateHint}) 완료/재개 후 마감하거나 \`!reject\`를 통해 먼저 취소해 주세요.`);
      return;
    }

    const taskPrompt = content.substring(6).trim();
    logger.info(`task command received: ${taskPrompt}`);

	    const statusMsg = await message.reply("🔄 Claude AI Manager가 요구사항 분석 및 실행 계획을 작성하고 있습니다...");
	
	    try {
	      const created = await worker.enqueue(
	        () => runWithWorkspaceLock(message, { label: "!task planning" }, async () => {
	          const occupiedDuringLock = await taskService.getAnyOccupiedTask();
	          if (occupiedDuringLock) {
	            const occupiedInThisChannel = await taskService.getOccupiedTaskForChannel(message.channel.id);
	            const stateHint = occupiedInThisChannel
	              ? `**${occupiedInThisChannel.id}** \`${occupiedInThisChannel.status}\` 상태`
	              : `다른 채널의 **${occupiedDuringLock.id}** \`${occupiedDuringLock.status}\` 상태`;
	            await statusMsg.edit(`⚠️ 현재 진행 중이거나 일시중지된 태스크가 있습니다. (${stateHint}) 완료/재개 후 마감하거나 \`!reject\`를 통해 먼저 취소해 주세요.`);
	            return null;
	          }
	
	          const promptPath = path.join(__dirname, "prompts/manager.md");
	          let systemPrompt = "";
	          if (fs.existsSync(promptPath)) {
	            systemPrompt = fs.readFileSync(promptPath, "utf8");
	          }
	
	          const fullPrompt = contextBuilder.buildPlannerContext({ taskPrompt, systemPrompt });
	          const plan = await askClaude(fullPrompt, { cwd: getWorkspaceDir() });
	          const matchedSkill = await skillMatcher.matchSkill(taskPrompt);
	
	          let task = await taskService.createLegacyTask({
	            taskPrompt,
	            createdBy: message.author.username,
	            channelId: message.channel.id,
	            plan,
	            selectedSkillId: matchedSkill ? matchedSkill.id : null,
	            riskLevel: matchedSkill ? matchedSkill.risk_level : null,
	          });
	          task = await taskLogService.createTaskThread(message, task);
	          return { task, plan, matchedSkill };
	        }),
	        {
	          onQueued: (n) => notifyIfQueued(message.channel, n),
	          label: "!task planning",
	          onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
	        }
	      );
	      if (!created) {
	        return;
	      }
	      const { task, plan, matchedSkill } = created;

      // Phase 6: messages(대화 트랜스크립트)뿐 아니라 agent_results(결과 종류별 구조화 저장소)에도
      // 남긴다. 제어 흐름은 그대로 두고 기록만 추가하는 것 - plannerAgent.js가 하는 것과 동일한
      // 저장 형태를 여기서도 맞춘다.
      await agentResultService.saveResult({
        taskId: task.id,
        agentName: "planner",
        resultType: "plan",
        content: plan,
        modelName: "claude",
      });

      await taskLogService.appendTaskMessage(task, {
        taskId: task.id,
        discordMessageId: message.id,
        channelId: message.channel.id,
        authorId: message.author.id,
        authorName: message.author.username,
        role: "user",
        content: taskPrompt,
        client,
        fallbackChannel: message.channel,
      });
      await taskLogService.appendTaskMessage(task, {
        taskId: task.id,
        discordMessageId: null,
        channelId: message.channel.id,
        authorId: null,
        authorName: "Claude (PM)",
        role: "pm",
        content: plan,
        client,
        fallbackChannel: message.channel,
      });
      await approvalService.openApproval(task.id, "plan_approval", "claude");

      await statusMsg.delete();
      await sendLongMessage(message, plan);
      await message.channel.send(
        matchedSkill
          ? `🧩 선택된 Skill: **${matchedSkill.id}** (위험도: ${matchedSkill.risk_level}) - 이후 Codex/Gemini 프롬프트에 이 skill의 가이드라인이 함께 전달됩니다.`
          : "🧩 매칭되는 Skill 없음 (generic 처리)"
      );
    } catch (err) {
      logger.error("!task 에러 발생", err);
      await statusMsg.edit(`❌ Claude 분석 실패: ${err.message}`);
    }
    return;
  }

  // 4.5 !dbtask [작업 요청] (Phase 1: PostgreSQL 기반 Task 생성, mock war-room 데모 파이프라인)
  if (content.startsWith("!dbtask ")) {
    const requestText = content.substring("!dbtask ".length).trim();
    if (!requestText) {
      await message.reply("사용법: `!dbtask 작업 내용`");
      return;
    }
    logger.info(`dbtask command received: ${requestText}`);
    try {
      const task = await commandHandler.handleDbTask(message, requestText);
      await message.reply(
        `✅ Task 생성됨: **${task.id}**\n` +
        `상태: ${task.status}\n` +
        `\`!dbstatus ${task.id}\` 로 조회할 수 있습니다.`
      );
    } catch (err) {
      logger.error("!dbtask 실행 오류", err);
      await message.reply(`❌ Task 생성 실패: ${err.message}`);
    }
    return;
  }

  // 5. !approve (단계별 승인 체크포인트를 거치는 멀티 에이전트 협업 파이프라인, DB 상태 머신 기반)
  if (content === "!approve") {
    // task 조회조차 DB 왕복(await)이라, 이걸 먼저 하고 나서 enqueue()를 부르면 그 사이에
    // (동기 준비만 하는) 다른 명령이 먼저 큐 슬롯을 선점할 수 있다 - 실측 재현 결과 5ms
    // 남짓의 DB 왕복 시간 동안 !gemma가 역전하는 사례를 직접 확인했다. 그래서 task
    // 조회/분기 판단 자체를 통째로 큐 job 안으로 옮겨, !approve가 어떤 await도 거치지
    // 않고 곧바로 enqueue()를 호출하도록 한다("승인할 게 없다"는 응답도 큐가 밀려 있으면
    // 늦게 나올 수 있다는 트레이드오프가 있지만, 승인 순서 보장이 더 중요하다고 판단했다).
	    await worker.enqueue(
	      async () => runWithWorkspaceLock(message, { label: "!approve" }, async () => {
	        const task = await taskService.getActiveTaskForChannel(message.channel.id);
        if (!task) {
          await message.reply("⚠️ 이 채널에 승인할 수 있는 대기 중인 태스크가 없습니다.");
          return;
        }
        logger.info(`approve command received in state: ${task.status}`);

        // --- 1) 계획 승인 -> Codex 1차 구현 ---
        if (task.status === "PENDING_PLAN_APPROVAL") {
          const resolved = await approvalService.resolveLatest(task.id, { approved: true, resolvedBy: message.author.username });
          if (!resolved) {
            await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
            return;
          }
          await messageService.addMessage({
            taskId: task.id,
            discordMessageId: message.id,
            channelId: message.channel.id,
            authorId: message.author.id,
            authorName: message.author.username,
            role: "user",
            content: "!approve (계획 승인, Codex 구현 요청)",
          });
          await taskService.updateTask(task.id, { round: 0, next_action: null });

          const codexMsg = await message.reply("🔄 **[Codex]** 승인된 계획을 바탕으로 1차 코드를 구현하고 있습니다...");
          try {
            const codexPrompt = await contextBuilder.buildCoderContext(task, {
              instruction: "위 대화 내역의 요구사항과 피드백을 충족하는 코드 구현을 완료해줘.",
              cwd: getWorkspaceDir(),
            });
            const codexResponse = await askCodex(codexPrompt, { cwd: getWorkspaceDir(), taskId: task.id });

            await messageService.addMessage({
              taskId: task.id,
              discordMessageId: null,
              channelId: message.channel.id,
              authorId: null,
              authorName: "Codex (Developer)",
              role: "assistant",
              content: codexResponse,
            });

            const diff = await git.getDiff(getWorkspaceDir());
            if (!diff || diff.trim() === "") {
              await codexMsg.edit("⚠️ Codex가 코드를 변경하지 않아 협업을 종료합니다.");
              await taskService.updateTask(task.id, { status: "CANCELLED" });
              return;
            }

            // Phase 6: coderAgent.js와 동일한 저장 형태 (agentName/resultType/modelName)로
            // agent_results에도 기록한다. 제어 흐름/상태전이는 그대로 둔다.
            await agentResultService.saveResult({
              taskId: task.id,
              agentName: "coder",
              resultType: "code_diff",
              content: codexResponse,
              modelName: "codex",
            });

            await taskService.updateTask(task.id, { status: "PENDING_CODEX_APPROVAL" });
            await approvalService.openApproval(task.id, "codex_approval", "codex");

            await codexMsg.edit("✅ **[Codex]** 1차 구현 완료. 아래 응답과 Diff를 확인해주세요.");
            await sendLongMessage(message, codexResponse, false);
            await message.channel.send("📋 **Git Diff:**");
            await sendLongMessage(message, `\`\`\`diff\n${diff}\n\`\`\``, false);
            await message.channel.send("👉 Gemini 리뷰로 진행하려면 `!approve`, 취소 및 롤백하려면 `!reject` 를 입력하세요.");
          } catch (err) {
            logger.error("Codex 1차 구현 에러", err);
            await codexMsg.edit(`❌ Codex 구현 실패: ${err.message}\n계획 승인 상태로 되돌립니다. 다시 \`!approve\` 를 시도해주세요.`);
            await taskService.updateTask(task.id, { status: "PENDING_PLAN_APPROVAL" });
            await approvalService.openApproval(task.id, "plan_approval", "claude");
          }
          return;
        }

        // --- 2) Codex 구현 승인 -> Gemini 리뷰 ---
        if (task.status === "PENDING_CODEX_APPROVAL") {
          const resolved = await approvalService.resolveLatest(task.id, { approved: true, resolvedBy: message.author.username });
          if (!resolved) {
            await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
            return;
          }
          await messageService.addMessage({
            taskId: task.id,
            discordMessageId: message.id,
            channelId: message.channel.id,
            authorId: message.author.id,
            authorName: message.author.username,
            role: "user",
            content: "!approve (Codex 구현 승인, Gemini 리뷰 요청)",
          });

          const geminiMsg = await message.reply("🔄 **[Gemini]** 코드 리뷰를 수행하고 있습니다...");
          try {
            const diff = await git.getDiff(getWorkspaceDir());
            const geminiPrompt = await contextBuilder.buildReviewerContext(task, {
              diff,
              instruction:
                '사용자 목적에 비추어 설계 결함, 로직 오류, 보안 취약점이 없는지 리뷰해줘. 수정이 필요하다면 구체적인 개선 지침을 남기고, 문제가 없다면 명확히 "문제 없음"이라고 밝혀줘.',
              cwd: getWorkspaceDir(),
            });
            const geminiResponse = await askGemini(geminiPrompt, { cwd: getWorkspaceDir(), taskId: task.id });

            await messageService.addMessage({
              taskId: task.id,
              discordMessageId: null,
              channelId: message.channel.id,
              authorId: null,
              authorName: `Gemini (Reviewer - Round ${task.round + 1})`,
              role: "assistant",
              content: geminiResponse,
            });

            const needsRevision = (
              geminiResponse.includes("취약") ||
              geminiResponse.includes("결함") ||
              geminiResponse.includes("개선") ||
              geminiResponse.includes("수정") ||
              geminiResponse.includes("버그")
            ) && !geminiResponse.includes("문제 없음");

            const roundsExhausted = task.round >= MAX_REVISION_ROUNDS;
            const nextAction = (needsRevision && !roundsExhausted) ? "revise" : "finalize";

            // Phase 6: reviewerAgent.js와 동일한 저장 형태로 agent_results에도 기록한다.
            await agentResultService.saveResult({
              taskId: task.id,
              agentName: "reviewer",
              resultType: "review",
              content: geminiResponse,
              modelName: "gemini",
            });

            await taskService.updateTask(task.id, { status: "PENDING_GEMINI_APPROVAL", next_action: nextAction });
            await approvalService.openApproval(task.id, "gemini_approval", "gemini");

            await geminiMsg.edit(`✅ **[Gemini]** 리뷰 완료 (Round ${task.round + 1}/${MAX_REVISION_ROUNDS}). 아래 리뷰 내용을 확인해주세요.`);
            await sendLongMessage(message, geminiResponse, false);

            if (nextAction === "revise") {
              await message.channel.send("⚠️ Gemini가 수정이 필요하다고 판단했습니다. 이 피드백을 Codex에게 반영시키려면 `!approve`, 취소 및 롤백하려면 `!reject` 를 입력하세요.");
            } else {
              if (needsRevision && roundsExhausted) {
                await message.channel.send(`ℹ️ 최대 리뷰 라운드(${MAX_REVISION_ROUNDS}회)에 도달하여 더 이상 반복하지 않습니다.`);
              }
              await message.channel.send("👉 최종 요약 및 커밋 승인 단계로 진행하려면 `!approve`, 취소 및 롤백하려면 `!reject` 를 입력하세요.");
            }
          } catch (err) {
            logger.error("Gemini 리뷰 에러", err);
            await geminiMsg.edit(`❌ Gemini 리뷰 실패: ${err.message}\nCodex 구현 승인 상태로 되돌립니다. 다시 \`!approve\` 를 시도해주세요.`);
            await taskService.updateTask(task.id, { status: "PENDING_CODEX_APPROVAL" });
            await approvalService.openApproval(task.id, "codex_approval", "codex");
          }
          return;
        }

        // --- 3) Gemini 리뷰 승인 -> (필요시) Codex 재수정, 또는 최종 요약 ---
        if (task.status === "PENDING_GEMINI_APPROVAL") {
          if (task.next_action === "revise") {
            const resolved = await approvalService.resolveLatest(task.id, { approved: true, resolvedBy: message.author.username });
            if (!resolved) {
              await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
              return;
            }
            await messageService.addMessage({
              taskId: task.id,
              discordMessageId: message.id,
              channelId: message.channel.id,
              authorId: message.author.id,
              authorName: message.author.username,
              role: "user",
              content: `!approve (Gemini 피드백 반영 지시, Round ${task.round + 1})`,
            });

            await runCodexRevisionRound(message, task, {
              newRound: task.round + 1,
              instruction: "위 대화에서 Gemini(Reviewer)가 남긴 최신 리뷰 피드백을 적극 반영하여 코드를 재수정하고 완성해줘.",
              progressLabel: "Gemini의 피드백",
              failureRollback: {
                status: "PENDING_GEMINI_APPROVAL",
                nextAction: "revise",
                approvalAction: "gemini_approval",
                approvalRequestedBy: "gemini",
	                label: "Gemini 리뷰 승인",
	              },
            });
            return;
          }

          // finalize: QA(테스트) 게이트를 거쳐 통과해야만 Gemma 최종 요약 -> 커밋 승인 대기로
          // 진행한다 (Phase 7). runQaGatedFinalize/finalizeAfterReview 둘 다 자체적으로
          // enqueue하지 않으므로(교착 방지) 이미 이 큐 job 안이므로 그대로 호출한다.
          const resolvedFinalize = await approvalService.resolveLatest(task.id, { approved: true, resolvedBy: message.author.username });
          if (!resolvedFinalize) {
            await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
            return;
          }
          await messageService.addMessage({
            taskId: task.id,
            discordMessageId: message.id,
            channelId: message.channel.id,
            authorId: message.author.id,
            authorName: message.author.username,
            role: "user",
            content: "!approve (최종 요약 및 커밋 준비 요청)",
          });

          await runQaGatedFinalize(message, task, false);
          return;
        }

        // --- 4) 자동 파이프라인 최종 승인 -> Git commit ---
        if (task.status === "PENDING_FINAL_APPROVAL") {
          await approveFinalApprovalTask(message, task);
          return;
        }

        // --- 5) 레거시 최종 커밋 승인 ---
        if (task.status === "PENDING_COMMIT_APPROVAL") {
          const resolvedCommit = await approvalService.resolveLatest(task.id, { approved: true, resolvedBy: message.author.username });
          if (!resolvedCommit) {
            await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
            return;
          }
          const statusMsg = await message.reply("🔄 Git Commit 진행 중...");
          try {
            const commitMsg = `feat: ${task.title}`;
            const gitResult = await git.addAndCommit(commitMsg, getWorkspaceDir());
            await taskService.updateTask(task.id, { status: "DONE" });
            await statusMsg.edit(`✅ **Git Commit 완료!**\n\`\`\`text\n${gitResult}\n\`\`\``);
          } catch (err) {
            logger.error("Git Commit 에러", err);
            await statusMsg.edit(`❌ Git Commit 실패: ${err.message}`);
            return;
          }

          // Phase 5: AI 기반 스킬 자동 축적. 커밋 성공 직후 Manager LLM(Claude)이 이번
          // 작업이 재사용 가치 있는 패턴인지 분석한다. 실패해도 완료된 커밋 자체에는
          // 영향을 주지 않는다.
          await analyzeForSkillProposalAfterCommit(message, task);
          return;
        }

        await message.reply("⚠️ 현재 승인할 수 있는 대기 중인 태스크가 없습니다.");
      }),
      {
        onQueued: (n) => notifyIfQueued(message.channel, n),
        label: "!approve",
        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
      }
    );
    return;
  }

  // 6. !skip (Gemini가 수정을 요청한 상태에서 반영 없이 바로 최종 단계로 진행)
  if (content === "!skip") {
    // !approve와 동일한 이유(task 조회조차 await라 그 사이에 다른 명령이 큐 슬롯을
    // 선점할 수 있음)로, task 조회/분기 판단 자체를 큐 job 안으로 옮긴다.
    // finalizeAfterReview는 자체적으로 enqueue하지 않으므로 여기서 감싼다.
	    await worker.enqueue(
	      async () => runWithWorkspaceLock(message, { label: "!skip" }, async () => {
	        const task = await taskService.getActiveTaskForChannel(message.channel.id);
        logger.info(`skip command received in state: ${task ? task.status : "NONE"}`);

        if (!(task && task.status === "PENDING_GEMINI_APPROVAL" && task.next_action === "revise")) {
          await message.reply("⚠️ 지금은 건너뛸 수 있는 Gemini 수정 요청이 없습니다. (`!skip`은 Gemini가 수정을 제안했을 때만 사용할 수 있습니다)");
          return;
        }

        await messageService.addMessage({
          taskId: task.id,
          discordMessageId: message.id,
          channelId: message.channel.id,
          authorId: message.author.id,
          authorName: message.author.username,
          role: "user",
          content: "!skip (Gemini 피드백 반영 없이 최종 단계로 진행)",
        });
        const resolvedSkip = await approvalService.resolveLatest(task.id, { approved: true, resolvedBy: message.author.username });
        if (!resolvedSkip) {
          await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
          return;
        }
        await taskService.updateTask(task.id, { next_action: "finalize" });

        await message.reply("⏭️ Gemini의 수정 요청을 건너뛰고 최종 요약 및 커밋 승인 단계로 진행합니다...");
        await runQaGatedFinalize(message, task, true);
      }),
      {
        onQueued: (n) => notifyIfQueued(message.channel, n),
        label: "!skip",
        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
      }
    );
    return;
  }

  // 7. !reject
  if (content === "!reject") {
    // !approve와 동일하게 task 조회/분기 판단까지 큐 안에서 실행해, 승인/반려 명령이
    // 서로 다른 await 지점 때문에 worker 순서를 역전시키지 않도록 한다.
	    await worker.enqueue(
	      async () => runWithWorkspaceLock(message, { label: "!reject" }, async () => {
	        const task = await taskService.getActiveTaskForChannel(message.channel.id);
        logger.info(`reject command received in state: ${task ? task.status : "NONE"}`);

        if (!task) {
          await message.reply("⚠️ 현재 취소할 수 있는 대기 중인 태스크가 없습니다.");
          return;
        }

        if (task.status === "PENDING_PLAN_APPROVAL") {
          const resolvedReject = await approvalService.resolveLatest(task.id, { approved: false, resolvedBy: message.author.username, reason: "계획 반려" });
          if (!resolvedReject) {
            await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
            return;
          }
          await taskService.updateTask(task.id, { status: "REJECTED" });
          await message.reply("❌ 계획이 반려되었습니다. 작업 세션이 초기화되었습니다.");
        } else if (task.status === "PENDING_FINAL_APPROVAL") {
          await rejectFinalApprovalTask(message, task);
        } else if (
          task.status === "PENDING_CODEX_APPROVAL" ||
          task.status === "PENDING_GEMINI_APPROVAL" ||
          task.status === "PENDING_COMMIT_APPROVAL"
        ) {
          // 승인을 먼저 획득한 요청만 실제 롤백(부작용)을 수행한다. 동시에 두 번 !reject가
          // 들어와도 discardChanges는 승인에서 이긴 쪽 한 번만 실행된다.
          const resolvedRollback = await approvalService.resolveLatest(task.id, { approved: false, resolvedBy: message.author.username, reason: "코드 변경사항 롤백" });
          if (!resolvedRollback) {
            await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
            return;
          }

          const statusMsg = await message.reply("🔄 코드 변경사항 롤백 중...");
          try {
            await git.discardChanges(getWorkspaceDir());
            await taskService.updateTask(task.id, { status: "REJECTED" });
            await statusMsg.edit("❌ 작업이 반려되어 모든 코드 변경사항이 롤백되었습니다. 작업 세션이 초기화되었습니다.");
          } catch (err) {
            // 승인은 이미 REJECTED로 확정됐는데 실제 git 롤백은 실패한 상태 - "반려됐다"고
            // 조용히 넘기면 사용자가 코드가 되돌아간 줄 알고 새 작업을 시작할 위험이 있으므로,
            // REJECTED로 덮어쓰지 않고 별도 상태(ROLLBACK_FAILED)로 남겨 불일치를 명시적으로 드러낸다.
            // (PENDING_%가 아니므로 새 !task 시작은 막지 않는다 - 워크스페이스 상태는 관리자가
            // 직접 git status/git log로 확인 후 수동 조치해야 한다.)
            logger.error("Git 롤백 실패 (승인은 이미 처리됨)", err);
            await taskService.updateTask(task.id, { status: "ROLLBACK_FAILED" });
            await statusMsg.edit(
              `❌ 승인 처리는 완료됐지만 코드 롤백에 실패했습니다: ${err.message}\n` +
              `⚠️ 워크스페이스에 반려되지 않은 변경사항이 남아있을 수 있습니다. \`!git status\`로 직접 확인해 주세요.`
            );
          }
        } else {
          await message.reply("⚠️ 현재 취소할 수 있는 대기 중인 태스크가 없습니다.");
        }
      }),
      {
        onQueued: (n) => notifyIfQueued(message.channel, n),
        label: "!reject",
        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
      }
    );
    return;
  }

  // 7.5 !approve-skill SKILL-ID / !reject-skill SKILL-ID (Phase 5: AI 기반 스킬 자동 축적 승인)
  // 커밋 완료 후 skillDiscovery가 제안한 skill을 실제로 /skills/에 기록할지 결정한다.
  // 이 명령들은 CLI/에이전트를 호출하지 않고 봇 자신의 /skills 디렉토리에만 파일을 쓰므로
  // (대상 워크스페이스 git 저장소와 무관) worker 큐를 거치지 않는다.
  if (content.startsWith("!approve-skill")) {
    const skillId = content.substring("!approve-skill".length).trim();
    if (!skillId) {
      await message.reply("사용법: `!approve-skill SKILL-ID`");
      return;
    }
    const found = await skillDiscovery.findPendingProposalBySkillId(skillId);
    if (!found) {
      await message.reply(`❌ 대기 중인 Skill 제안 중 \`${skillId}\` 를 찾을 수 없습니다.`);
      return;
    }
    const resolved = await approvalService.resolveLatest(found.taskId, { approved: true, resolvedBy: message.author.username });
    if (!resolved) {
      await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
      return;
    }
    try {
      const skillDir = skillDiscovery.writeSkillFiles(found.proposal);
      await skillRegistry.syncSkills();
      await message.reply(`✅ Skill \`${skillId}\` 이(가) 등록되었습니다. (\`${skillDir}\`)`);
    } catch (err) {
      logger.error("Skill 등록 실패", err);
      await message.reply(`❌ Skill 등록 실패: ${err.message}`);
    }
    return;
  }

  if (content.startsWith("!reject-skill")) {
    const skillId = content.substring("!reject-skill".length).trim();
    if (!skillId) {
      await message.reply("사용법: `!reject-skill SKILL-ID`");
      return;
    }
    const found = await skillDiscovery.findPendingProposalBySkillId(skillId);
    if (!found) {
      await message.reply(`❌ 대기 중인 Skill 제안 중 \`${skillId}\` 를 찾을 수 없습니다.`);
      return;
    }
    const resolved = await approvalService.resolveLatest(found.taskId, {
      approved: false,
      resolvedBy: message.author.username,
      reason: "Skill 제안 반려",
    });
    if (!resolved) {
      await message.reply("⚠️ 이미 처리된 승인입니다. (다른 요청이 먼저 처리했습니다)");
      return;
    }
    await message.reply(`❌ Skill \`${skillId}\` 제안이 반려되었습니다.`);
    return;
  }

  // 8. !git 관련
  if (content === "!git status") {
    logger.info("git status command received");
    try {
      const status = await git.getStatus(getWorkspaceDir());
      await message.reply(`📋 **Git Status:**\n\`\`\`text\n${status}\n\`\`\``);
    } catch (err) {
      await message.reply(`❌ Git Status 조회 실패: ${err.message}`);
    }
    return;
  }

  if (content === "!git diff") {
    logger.info("git diff command received");
    try {
      const diff = await git.getDiff(getWorkspaceDir());
      await sendLongMessage(message, `📋 **Git Diff:**\n\`\`\`diff\n${diff}\n\`\`\``);
    } catch (err) {
      await message.reply(`❌ Git Diff 조회 실패: ${err.message}`);
    }
    return;
  }

  // 9. !log / !app-log
  if (content.startsWith("!log ")) {
    const taskId = content.substring("!log".length).trim();
    logger.info(`task log command received: ${taskId}`);
    try {
      const task = await taskService.getTask(taskId);
      if (!task) {
        await message.reply(`❌ \`${taskId}\` 에 해당하는 Task를 찾을 수 없습니다.`);
        return;
      }
      const messages = await messageService.getTaskMessages(task.id);
      const taskLog = taskLogService.formatTaskLog(messages);
      await sendLongMessage(message, `📋 **Task Log: ${task.id}**\n\`\`\`text\n${taskLog}\n\`\`\``);
    } catch (err) {
      logger.error("!log TASK-ID 실행 오류", err);
      await message.reply(`❌ Task 로그 조회 실패: ${err.message}`);
    }
    return;
  }

  if (content === "!log" || content === "!app-log") {
    logger.info("app log command received");
    try {
      const logContent = fs.readFileSync(logger.logFilePath, "utf8");
      const lines = logContent.trim().split("\n");
      const lastLines = lines.slice(-20).join("\n");
      await message.reply(`📋 **최근 20개 로그 기록:**\n\`\`\`text\n${lastLines}\n\`\`\``);
    } catch (err) {
      await message.reply("❌ 로그 파일을 읽을 수 없습니다.");
    }
    return;
  }

  // 9.4 역할 기반 단발 에이전트 명령 (!pm/!planner/!coder/!reviewer/!qa/!summarizer)
  const roleCommand = parseRoleCommand(content);
  if (roleCommand) {
    if (!roleCommand.prompt) {
      await message.reply(`사용법: \`${roleCommand.command} 질문 또는 작업 내용\``);
      return;
    }

    logger.info(`role command received: ${roleCommand.command} -> ${roleCommand.role}`);
    await runRoleCommand(message, roleCommand.role, roleCommand.prompt);
    return;
  }

  // 9.5 !run-codex TASK-ID (Phase 5: Codex Adapter - 임의 task에 대해 Codex를 단발성으로 실행)
  // !task/!approve 승인 파이프라인과 별개로, 이미 존재하는 task(!task 또는 !dbtask로 생성된
  // 것 모두 가능)에 대해 Codex를 직접 실행하고 결과를 agent_results에 구조화 저장한다.
  // 보안 범위 한계: task에 skill이 선택되어 있으면 그 skill의 blocked_commands는 여기서도
  // Codex 런처 호출 자체를 막을 수 있지만(commandGuard.js 참고), skill의 allowed_commands는
  // Codex가 일단 실행된 뒤 내부적으로 하는 파일 수정까지 제한하지 않는다 - 그건 Codex 자체
  // sandbox(--sandbox workspace-write)에 맡겨져 있다.
  if (content.startsWith("!run-codex")) {
    const taskId = content.substring("!run-codex".length).trim();
    if (!taskId) {
      await message.reply("사용법: `!run-codex TASK-ID`");
      return;
    }

    const task = await taskService.getTask(taskId);
    if (!task) {
      await message.reply(`❌ \`${taskId}\` 에 해당하는 Task를 찾을 수 없습니다.`);
      return;
    }

    // 정책: 시스템 전체에 PENDING_%(!task -> !approve 파이프라인 진행 중) task가
    // 하나라도 있으면 !run-codex를 무조건 금지한다. 대상 task가 지금 진행 중인 그
    // task이든 다른 task이든 상관없이 막는다 - 워크스페이스(git 저장소)는 봇 전체에
    // 하나뿐이라, 승인 파이프라인이 진행 중인 상태에서 !run-codex가 같은 작업 트리에
    // Codex 변경을 더 얹으면 이후 리뷰/승인/롤백이 어느 변경을 대상으로 하는지
    // 불명확해지기 때문이다 (PAUSED까지 포함한 occupied task 가드는 !project 변경에도
    // 같은 이유로 쓰이고 있음). CREATED/QA_DONE/REJECTED/CANCELLED/DONE처럼
    // 비활성 상태인 task에 대해서는 그대로 허용한다.
    const occupiedTask = await taskService.getAnyOccupiedTask();
    if (occupiedTask) {
      await message.reply(
        `⚠️ 진행 중이거나 일시중지된 태스크가 있어 \`!run-codex\`를 실행할 수 없습니다: **${occupiedTask.id}** (상태: ${occupiedTask.status})\n` +
          "해당 작업을 완료/재개 후 마감하거나 `!reject`로 먼저 취소한 뒤 다시 시도해 주세요."
      );
      return;
    }

    logger.info(`run-codex command received: ${taskId}`);
    // 진행 메시지 전송(await message.reply)조차 enqueue()보다 먼저 하면 그 네트워크 I/O
    // 대기 사이에 다른 명령이 먼저 큐 슬롯을 선점할 수 있다. enqueue() 호출 자체를 최대한
    // 앞당기기 위해 진행 메시지 생성도 클로저 안으로 옮긴다.
	    await worker.enqueue(
	      async () => runWithWorkspaceLock(message, { label: `run-codex:${taskId}`, taskId }, async () => {
	        const statusMsg = await message.reply(`🔄 **[Codex Adapter]** ${taskId}에 대해 Codex를 실행합니다...`);
        try {
          // 스냅샷 캡처 -> 실제 Codex 실행 -> 변경 여부 비교를 전부 같은 job 안에서 처리한다.
          const gitBefore = await captureGitSnapshot(getWorkspaceDir());
          const result = await coderAgent.runCoderAgent(task, {
            instruction: `Task 요구사항("${task.original_request}")에 맞는 코드 구현을 진행해줘.`,
            cwd: getWorkspaceDir(),
          });
          await warnIfUnapprovedGitChange(message, getWorkspaceDir(), "Codex Adapter", gitBefore);

          if (result.exitCode === 0) {
            await statusMsg.edit(`✅ **[Codex Adapter]** 실행 완료 (${result.durationMs}ms). agent_results에 저장됨.`);
            await sendLongMessage(message, result.stdout, false);
          } else {
            await statusMsg.edit(`❌ **[Codex Adapter]** 실행 실패 (${result.durationMs}ms): ${result.stderr}`);
          }
        } catch (err) {
          logger.error("!run-codex 실행 오류", err);
          await statusMsg.edit(`❌ Codex Adapter 실행 실패: ${err.message}`);
        }
	      }),
      {
        onQueued: (n) => notifyIfQueued(message.channel, n),
        label: `run-codex:${taskId}`,
        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
      }
    );
    return;
  }

  // 10. 개별 에이전트 일회성 대화 처리 (이전 15회 기억 파일 유지 및 대화 연계)
  if (content.startsWith("!claude ")) {
    const prompt = content.substring(8).trim();
    logger.info(`claude command: ${prompt}`);
    let memory = loadAgentMemory("claude");
    memory.push({ role: "user", sender: message.author.username, content: prompt });
    const contextText = formatChatContext(memory);

    // message.reply()도 await하는 순간(네트워크 I/O) 다른 명령이 먼저 enqueue()에 도달해
    // 큐 슬롯을 선점할 수 있다. enqueue() 호출을 최대한 앞당기기 위해 진행 메시지 생성도
    // 클로저 안으로 옮긴다.
	    await worker.enqueue(
	      async () => runWithWorkspaceLock(message, { label: "!claude" }, async () => {
	        const statusMsg = await message.reply("🔄 Claude Code가 분석 중...");
        try {
          const gitBefore = await captureGitSnapshot(getWorkspaceDir());
          const response = await askClaude(contextText, { cwd: getWorkspaceDir() });
          await warnIfUnapprovedGitChange(message, getWorkspaceDir(), "Claude", gitBefore);

          memory.push({ role: "assistant", sender: "Claude", content: response });
          saveAgentMemory("claude", memory);

          await statusMsg.delete();
          await sendLongMessage(message, response);
        } catch (err) {
          logger.error("!claude 실행 오류", err);
          await statusMsg.edit(`❌ Claude 실행 실패: ${err.message}`);
        }
	      }),
      {
        onQueued: (n) => notifyIfQueued(message.channel, n),
        label: "!claude",
        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
      }
    );
    return;
  }

  if (content.startsWith("!codex ")) {
    const prompt = content.substring(7).trim();
    logger.info(`codex command: ${prompt}`);
    let memory = loadAgentMemory("codex");
    memory.push({ role: "user", sender: message.author.username, content: prompt });
    const contextText = formatChatContext(memory);

	    await worker.enqueue(
	      async () => runWithWorkspaceLock(message, { label: "!codex" }, async () => {
	        const statusMsg = await message.reply("🔄 Codex CLI가 분석/수정 중...");
        try {
          const gitBefore = await captureGitSnapshot(getWorkspaceDir());
          const response = await askCodex(contextText, { cwd: getWorkspaceDir() });
          await warnIfUnapprovedGitChange(message, getWorkspaceDir(), "Codex", gitBefore);

          memory.push({ role: "assistant", sender: "Codex", content: response });
          saveAgentMemory("codex", memory);

          await statusMsg.delete();
          await sendLongMessage(message, response);
        } catch (err) {
          logger.error("!codex 실행 오류", err);
          await statusMsg.edit(`❌ Codex 실행 실패: ${err.message}`);
        }
	      }),
      {
        onQueued: (n) => notifyIfQueued(message.channel, n),
        label: "!codex",
        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
      }
    );
    return;
  }

  if (content.startsWith("!gemini ")) {
    const prompt = content.substring(8).trim();
    logger.info(`gemini command: ${prompt}`);
    let memory = loadAgentMemory("gemini");
    memory.push({ role: "user", sender: message.author.username, content: prompt });
    const contextText = formatChatContext(memory);

	    await worker.enqueue(
	      async () => runWithWorkspaceLock(message, { label: "!gemini" }, async () => {
	        const statusMsg = await message.reply("🔄 Antigravity(Gemini)가 분석 중...");
        try {
          const gitBefore = await captureGitSnapshot(getWorkspaceDir());
          const response = await askGemini(contextText, { cwd: getWorkspaceDir() });
          await warnIfUnapprovedGitChange(message, getWorkspaceDir(), "Gemini", gitBefore);

          memory.push({ role: "assistant", sender: "Gemini", content: response });
          saveAgentMemory("gemini", memory);

          await statusMsg.delete();
          await sendLongMessage(message, response);
        } catch (err) {
          logger.error("!gemini 실행 오류", err);
          await statusMsg.edit(`❌ Gemini 실행 실패: ${err.message}`);
        }
	      }),
      {
        onQueued: (n) => notifyIfQueued(message.channel, n),
        label: "!gemini",
        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
      }
    );
    return;
  }

  if (content.startsWith("!gemma ")) {
    const prompt = content.substring(7).trim();
    logger.info(`gemma command: ${prompt}`);
    let memory = loadAgentMemory("gemma");
    memory.push({ role: "user", sender: message.author.username, content: prompt });
    const contextText = formatChatContext(memory);

	    await worker.enqueue(
	      async () => runWithWorkspaceLock(message, { label: "!gemma" }, async () => {
	        const statusMsg = await message.reply("🔄 Gemma4(Ollama)가 분석 중...");
        try {
          const response = await askGemma(contextText, { cwd: getWorkspaceDir() });

          memory.push({ role: "assistant", sender: "Gemma4", content: response });
          saveAgentMemory("gemma", memory);

          await statusMsg.delete();
          await sendLongMessage(message, response);
        } catch (err) {
          logger.error("!gemma 실행 오류", err);
          await statusMsg.edit(`❌ Gemma4 실행 실패: ${err.message}`);
        }
	      }),
      {
        onQueued: (n) => notifyIfQueued(message.channel, n),
        label: "!gemma",
        onWatchdog: (info) => notifyIfWatchdog(message.channel, info),
      }
    );
    return;
  }

  // 11. 진행 중인 태스크가 있는 채널에서 일반 텍스트 입력 시 대화 기록(피드백)으로 누적 처리 (DB 기반)
  if (!content.startsWith("!")) {
    const activeTask = await taskService.getActiveTaskForChannel(message.channel.id);
    if (activeTask) {
      await messageService.addMessage({
        taskId: activeTask.id,
        discordMessageId: message.id,
        channelId: message.channel.id,
        authorId: message.author.id,
        authorName: message.author.username,
        role: "user",
        content,
      });
      const messageCount = (await messageService.getTaskMessages(activeTask.id)).length;
      logger.info(`Context updated from ${message.author.username}: ${content}`);
      await message.reply(`📝 **추가 지시/피드백이 대화 맥락에 기록되었습니다.**\n(현재 누적 대화: ${messageCount}개)\n준비가 되셨다면 \`!approve\`를 입력해 실행해 주세요.`);
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  logger.error(`DISCORD_TOKEN이 설정되지 않아 봇을 시작할 수 없습니다. (instance=${BOT_INSTANCE_ID}, env=${envFilePath})`);
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  logger.error(`Discord login 실패 (instance=${BOT_INSTANCE_ID}, env=${envFilePath})`, err);
  process.exit(1);
});
