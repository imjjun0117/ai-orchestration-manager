const db = require("../db");
const logger = require("../../services/logger");
const pathGuard = require("./pathGuard");
const roleAudit = require("../controlPlane/roleAuditService");

// 무조건 차단할 명령 토큰 시퀀스 (15.1 / 23.5 차단 명령)
const BLOCKED_TOKEN_SEQUENCES = [
  ["rm"],
  ["sudo"],
  ["chmod"],
  ["chown"],
  ["mv"],
  ["cp"],
  ["curl"],
  ["wget"],
  ["ssh"],
  ["scp"],
  ["git", "push"],
  ["git", "reset", "--hard"],
  ["git", "clean"],
  ["shutdown"],
  ["reboot"],
  ["drop", "table"],
  ["truncate"],
  ["delete", "from"],
];

// 개발 검증용 범용 명령 (23.4 허용 명령 Allowlist)
const DEV_TOOL_ALLOWED_SEQUENCES = [
  ["git", "status"],
  ["git", "diff"],
  ["git", "diff", "--check"],
  ["git", "log"],
  ["find"],
  ["grep"],
  ["npm", "test"],
  ["npm", "run", "test"],
  ["mvn", "test"],
];

// 에이전트 CLI 런처: trusted 예외로 우회하는 대신, 코드에 고정된 실행 형태를
// 명시적으로 allowlist에 올려 실제로 검증을 통과하도록 한다.
// 이 런처 명령들은 스킬별 allowed_commands 검사(아래 참고)의 대상이 아니다 -
// 스킬의 allowed_commands는 grep/find/git diff 같은 "실제 작업 도구"를 위한 목록이며,
// 우리 코드가 에이전트를 실행하기 위해 고정적으로 쓰는 런처 자체를 가리키지 않는다.
// (스킬별 blocked_commands는 이 런처 호출에도 방어 심층화 차원에서 그대로 적용된다.)
const AGENT_LAUNCHER_SEQUENCES = [
  ["claude", "-p"],
  ["codex", "--ask-for-approval", "never", "exec"],
  ["agy", "--print"],
  ["ollama", "run"],
];

const ALLOWED_TOKEN_SEQUENCES = [...DEV_TOOL_ALLOWED_SEQUENCES, ...AGENT_LAUNCHER_SEQUENCES];

// find의 하위 프로세스 실행 옵션 (샌드박스 우회 경로) - 허용된 find라도 무조건 차단한다.
const DANGEROUS_FIND_FLAGS = ["-exec", "-execdir", "-ok", "-okdir"];

// 차단 사유 메시지에 표시할 명령어 문자열의 최대 길이. 에이전트 런처 호출은 args에
// 프롬프트(개발자 시스템 프롬프트 포함, 수백~수천 자)를 통째로 담고 있을 수 있어서,
// 자르지 않으면 이 메시지를 그대로 노출하는 Discord 쪽에서 메시지 길이 제한에
// 걸리거나 화면이 도배될 위험이 있다. command_logs에는 항상 전체가 저장된다.
const MAX_DISPLAY_COMMAND_LENGTH = 300;

function truncateForDisplay(text, maxLen = MAX_DISPLAY_COMMAND_LENGTH) {
  if (typeof text !== "string" || text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... (총 ${text.length}자 중 일부만 표시)`;
}

function sequenceMatches(tokens, sequence) {
  if (tokens.length < sequence.length) return false;
  return sequence.every((word, i) => tokens[i] === word);
}

function findDangerousFindUsage(command, args = []) {
  if (command !== "find") return null;
  return args.find((arg) => DANGEROUS_FIND_FLAGS.includes(arg)) || null;
}

function isBlocked(command, args = []) {
  const tokens = [command, ...args];
  if (BLOCKED_TOKEN_SEQUENCES.some((seq) => sequenceMatches(tokens, seq))) {
    return true;
  }
  if (findDangerousFindUsage(command, args)) {
    return true;
  }
  return false;
}

function isAllowed(command, args = []) {
  const tokens = [command, ...args];
  return ALLOWED_TOKEN_SEQUENCES.some((seq) => sequenceMatches(tokens, seq));
}

function isAgentLauncherCommand(command, args = []) {
  const tokens = [command, ...args];
  return AGENT_LAUNCHER_SEQUENCES.some((seq) => sequenceMatches(tokens, seq));
}

/**
 * commandList(예: skills.allowed_commands/blocked_commands, "git diff" 같은 공백 구분 문자열 배열)의
 * 항목 중 하나라도 현재 command/args와 매칭되는지 검사한다.
 */
function matchesAnyCommandEntry(command, args, commandList) {
  if (!commandList || commandList.length === 0) return false;
  const tokens = [command, ...args];
  return commandList.some((entry) => {
    const seq = String(entry).trim().split(/\s+/).filter(Boolean);
    return seq.length > 0 && sequenceMatches(tokens, seq);
  });
}

/**
 * task.selected_skill_id로 연결된 skill 레코드(allowed_commands/blocked_commands 포함)를 조회한다.
 * 조회 실패는 스킬별 부가 검증만 건너뛰게 하고(전역 규칙은 그대로 유지), 전체 실행을 막지 않는다.
 */
async function getSkillForTask(taskId) {
  try {
    return await roleAudit.getTaskSkill(taskId, { db });
  } catch (err) {
    if (roleAudit.runtimeInstanceId()) throw err;
    logger.error("commandGuard: task의 skill 조회 실패", err);
    return null;
  }
}

async function logBlockedCommand({ taskId, agentName, fullCommand, reason }) {
  try {
    await roleAudit.appendCommandLog({
      taskId,
      agentName,
      fullCommand,
      stderr: reason,
      exitCode: null,
      blocked: true,
      durationMs: null,
      timedOut: false,
      killed: false,
    }, { db });
  } catch (err) {
    // DB 로깅 실패가 차단 자체를 무력화하면 안 되므로 별도로 로그만 남긴다.
    logger.error("commandGuard: command_logs 기록 실패", err);
  }
}

/**
 * 신뢰되지 않은 명령을 blocklist -> 스킬 blocklist -> allowlist -> 스킬 allowlist 순으로 검증한다.
 * find는 allowlist에 있어도 -exec/-ok 등 하위 프로세스 실행 옵션이 있으면 무조건 차단된다.
 * 차단 시 command_logs에 기록 후 예외를 던진다.
 *
 * services/git.js의 고정 함수처럼 이미 !approve/!reject 승인 절차로 보호되는
 * 하드코딩된 명령에만 이 검증을 건너뛸 수 있다 (services/shell.js의 trusted 옵션 참고).
 * agents/*.js의 CLI 런처 호출은 더 이상 예외 대상이 아니며, 위 allowlist에 명시적으로
 * 등록되어 이 검증을 실제로 통과한다.
 *
 * context.taskId가 주어지면 해당 task에 선택된 skill의 allowed_commands/blocked_commands도
 * 함께 대조한다:
 * - 스킬 blocked_commands는 에이전트 런처 호출을 포함해 항상 적용된다 (방어 심층화).
 *   예: blocked_commands=["codex --ask-for-approval never exec"]로 지정하면 그 스킬이
 *   선택된 task에서는 !run-codex 자체가(런처 호출 단계에서) 차단된다.
 * - 스킬 allowed_commands는 에이전트 런처가 아닌 명령(향후 에이전트가 스스로 제안하는
 *   sub-command 등)에만 추가로 적용된다. 런처 자체는 전역 allowlist 통과만으로 충분하다 -
 *   그렇지 않으면 어떤 스킬이든 매칭되는 즉시 Codex/Gemini 호출 자체가 막혀버린다.
 *
 * !!! 중요한 보안 경계(한계) !!!
 * 이 파일이 실제로 검증하는 대상은 "우리 Node 프로세스가 spawn하는 명령"뿐이다.
 * codex/claude/agy 같은 에이전트 CLI는 한 번 실행되면 그 프로세스 내부에서 자기
 * 나름의 방식(각 CLI 자체 sandbox, 예: codex의 --sandbox workspace-write)으로 파일을
 * 읽고 쓰고 하위 명령을 실행한다 - 이 내부 동작은 우리 commandGuard가 가로채거나
 * 검사하지 않는다(가로챌 방법이 없다, 별도 프로세스이기 때문). 따라서 스킬의
 * allowed_commands는 "Codex가 내부적으로 어떤 파일/명령을 만지는지"를 제한하는
 * 장치가 아니다. Codex 내부 작업까지 스킬별로 통제하려면 별도 설계(예: Codex 자체
 * sandbox 정책을 스킬별로 다르게 넘기는 방식)가 필요하며, 현재는 구현되어 있지 않다.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [context]
 * @param {string} [context.taskId]
 * @param {string} [context.agentName]
 */
async function assertCommandAllowed(command, args = [], context = {}) {
  const { taskId = null, agentName = null } = context;
  // command_logs에는 전체를 남기지만(포렌식 목적), 던지는 Error.message는 짧게 자른다 -
  // args에 에이전트 런처의 프롬프트(개발자 시스템 프롬프트 포함, 수백~수천 자)가
  // 들어있는 경우가 있어서, 자르지 않으면 이 메시지를 그대로 표시하는 Discord 쪽에서
  // 메시지 길이 제한에 걸리거나 화면이 도배될 수 있다.
  const fullCommand = [command, ...args].join(" ");
  const displayCommand = truncateForDisplay(fullCommand);

  if (isBlocked(command, args)) {
    await logBlockedCommand({
      taskId,
      agentName,
      fullCommand,
      reason: "Blocked: command matched blocklist",
    });
    throw new Error(`Blocked command: ${displayCommand}`);
  }

  const skill = taskId ? await getSkillForTask(taskId) : null;

  if (skill && matchesAnyCommandEntry(command, args, skill.blocked_commands)) {
    await logBlockedCommand({
      taskId,
      agentName,
      fullCommand,
      reason: `Blocked: command matched skill(${skill.id}) blocklist`,
    });
    throw new Error(`Blocked command (skill blocklist: ${skill.id}): ${displayCommand}`);
  }

  if (!isAllowed(command, args)) {
    await logBlockedCommand({
      taskId,
      agentName,
      fullCommand,
      reason: "Blocked: command outside allowed policy",
    });
    throw new Error(`Command not in allowlist: ${displayCommand}`);
  }

  const isLauncher = isAgentLauncherCommand(command, args);
  if (skill && !isLauncher && skill.allowed_commands && skill.allowed_commands.length > 0) {
    if (!matchesAnyCommandEntry(command, args, skill.allowed_commands)) {
      await logBlockedCommand({
        taskId,
        agentName,
        fullCommand,
        reason: `Blocked: command outside skill(${skill.id}) allowlist`,
      });
      throw new Error(`Command not in skill allowlist (${skill.id}): ${displayCommand}`);
    }
  }
}

/**
 * 각 에이전트 런처의 argv에서 "자연어 프롬프트"가 위치하는 인덱스(args 배열 기준)를
 * 명시적으로 반환한다. agents/*.js가 실제로 구성하는 argv 순서와 반드시 일치해야 한다
 * (아래 각 케이스 옆에 대응하는 agents/*.js 파일과 argv 형태를 주석으로 남겨둔다).
 *
 * "공백을 포함하면 프롬프트"라는 휴리스틱 대신 위치를 명시적으로 판단하는 이유:
 * 나중에 런처 argv에 공백을 포함한 고정 플래그 값(예: `--message "some value"`)이
 * 추가되면, 휴리스틱은 그 값도 프롬프트로 오인해 경로 검사를 건너뛰게 된다. 위치를
 * 명시하면 그런 값은 프롬프트 인덱스가 아니므로 정상적으로 경로 검사 대상이 된다.
 *
 * @returns {number} 프롬프트가 위치한 args 인덱스, 해당 없으면 -1
 */
function getLauncherPromptArgIndex(command, args = []) {
  if (command === "claude") {
    // agents/claude.js: ["-p", prompt, "--permission-mode", "dontAsk", "--tools", ""]
    const flagIndex = args.indexOf("-p");
    return flagIndex >= 0 ? flagIndex + 1 : -1;
  }

  if (command === "codex") {
    // agents/codex.js: ["--ask-for-approval","never","exec","--sandbox","workspace-write",
    //                    "--skip-git-repo-check", combinedPrompt] - combinedPrompt는 항상 마지막 인자.
    if (!isAgentLauncherCommand(command, args)) return -1;
    return args.length > 0 ? args.length - 1 : -1;
  }

  if (command === "agy") {
    // agents/gemini.js: ["--print", combinedPrompt, "--new-project", "--sandbox"]
    const flagIndex = args.indexOf("--print");
    return flagIndex >= 0 ? flagIndex + 1 : -1;
  }

  if (command === "ollama") {
    // agents/gemma.js: ["run", "gemma4:e4b", combinedPrompt] - "run <model>" 다음 인자.
    const flagIndex = args.indexOf("run");
    return flagIndex >= 0 ? flagIndex + 2 : -1;
  }

  return -1;
}

/**
 * argIndex 위치의 인자가 "에이전트 런처 호출의 자연어 프롬프트 인자"인지 판단한다.
 * 이 인자만 경로 검사에서 제외해 자연어 텍스트가 경로로 오인되는 것을 막는다.
 * (looksLikePath는 공백 여부와 무관하게 "/"를 포함하면 경로로 판단하므로, 이 예외
 * 처리가 없으면 프롬프트에 우연히 "/"가 들어있을 때 오탐 차단이 발생한다.)
 */
function isLauncherPromptArg(command, args, argIndex) {
  const promptIndex = getLauncherPromptArgIndex(command, args);
  return promptIndex !== -1 && argIndex === promptIndex;
}

/**
 * 플래그가 아닌 모든 인자를 대상으로 bare filename 우회(예: `grep SECRET .env`)와
 * 공백을 이용한 경로 검사 우회(예: `grep root "link dir/passwd"`, `link dir`가 /etc 심볼릭 링크)를 차단한다.
 * - 에이전트 런처(codex/claude/agy/ollama) 호출의 프롬프트 인자(isLauncherPromptArg)만 예외로
 *   건너뛴다. 그 외 모든 인자는 공백 포함 여부와 무관하게 검사 대상이다.
 * - 모든 비-플래그 인자는 민감 파일 패턴(.env, *.pem, id_rsa 등) 여부를 검사한다 (항상 수행).
 * - 그중 구조적으로 파일 경로처럼 보이는 인자(pathGuard.looksLikePath)는 추가로
 *   PROJECT_ROOT 이탈/심볼릭 링크 우회 여부를 검증한다.
 * 차단 시 command_logs에 기록 후 예외를 던진다.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {object} [context]
 */
async function assertArgsSafe(command, args = [], cwd, context = {}) {
  const { taskId = null, agentName = null } = context;
  const fullCommand = [command, ...args].join(" ");

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string" || arg.startsWith("-")) continue;
    if (isLauncherPromptArg(command, args, i)) continue;

    if (pathGuard.isSensitivePath(arg)) {
      await logBlockedCommand({
        taskId,
        agentName,
        fullCommand,
        reason: `Blocked sensitive file argument: ${arg}`,
      });
      throw new Error(`Blocked sensitive file access: ${truncateForDisplay(arg)}`);
    }

    if (pathGuard.looksLikePath(arg, cwd)) {
      try {
        pathGuard.assertInsideProjectRoot(arg, cwd);
      } catch (err) {
        await logBlockedCommand({ taskId, agentName, fullCommand, reason: err.message });
        throw err;
      }
    }
  }
}

module.exports = {
  assertCommandAllowed,
  assertArgsSafe,
  isBlocked,
  isAllowed,
};
