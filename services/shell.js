const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const pathGuard = require("../src/core/pathGuard");
const commandGuard = require("../src/core/commandGuard");
const hostIdentity = require("../src/core/hostIdentity");
const {
  assertRegisteredAgentWorkspace,
  requiresIsolatedWorkspace,
} = require("../src/workspace/workspaceExecutionPolicy");
const { sanitizedEnvironment } = require("../src/workspace/sandboxService");
const db = require("../src/db");
const roleAudit = require("../src/controlPlane/roleAuditService");
const logger = require("./logger");

// 로컬 환경의 CLI 실행을 위해 PATH 환경변수를 확장해 줍니다.
const envWithPaths = {
  ...process.env,
  PATH: ["/usr/local/bin", path.join(os.homedir(), ".local/bin"), process.env.PATH || ""]
    .filter(Boolean)
    .join(path.delimiter),
};

function buildAgentEnvironment(source = envWithPaths) {
  const result = sanitizedEnvironment(source);
  for (const key of ["HOME", "CODEX_HOME"]) {
    if (source[key] !== undefined) result[key] = String(source[key]);
  }
  return result;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;

function sendSignalToChildTree({ pid, pgid, signal }) {
  if (!pid) return;
  if (pgid && process.platform !== "win32") {
    process.kill(-pgid, signal);
    return;
  }
  process.kill(pid, signal);
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timeoutEnvKeyFor(command, agentName) {
  const keys = [agentName, command]
    .filter(Boolean)
    .map((key) => String(key).toLowerCase());

  for (const key of keys) {
    if (key === "codex") return "CODEX_TIMEOUT_MS";
    if (key === "claude") return "CLAUDE_TIMEOUT_MS";
    if (key === "gemini" || key === "agy") return "GEMINI_TIMEOUT_MS";
    if (key === "gemma" || key === "ollama") return "GEMMA_TIMEOUT_MS";
  }
  return null;
}

function resolveTimeoutMs(command, agentName, explicitTimeoutMs) {
  if (explicitTimeoutMs !== undefined && explicitTimeoutMs !== null) {
    return parsePositiveInt(explicitTimeoutMs);
  }

  const envKey = timeoutEnvKeyFor(command, agentName);
  if (envKey) {
    const envTimeout = parsePositiveInt(process.env[envKey]);
    if (envTimeout) return envTimeout;
  }

  return parsePositiveInt(process.env.AGENT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
}

async function logCommandExecution({
  taskId,
  agentName,
  fullCommand,
  stdout,
  stderr,
  exitCode,
  blocked = false,
  durationMs,
  timedOut = false,
  killed = false,
}) {
  try {
    await roleAudit.appendCommandLog({
      taskId, agentName, fullCommand, stdout, stderr, exitCode,
      blocked, durationMs, timedOut, killed,
    }, { db });
  } catch (err) {
    logger.error("shell: command_logs 기록 실패", err);
  }
}

function currentOwnerInstanceId() {
  return String(process.env.BOT_INSTANCE_ID || "default").trim() || "default";
}

async function updateTaskProcess(taskId, { pid, pgid, hostId, ownerInstanceId }) {
  if (!taskId) return;
  try {
    await roleAudit.recordTaskProcess(taskId, { pid, pgid, hostId, ownerInstanceId }, { db });
  } catch (err) {
    if (roleAudit.runtimeInstanceId()) throw err;
    logger.error("shell: task process 기록 실패", err);
  }
}

async function clearTaskPid(taskId, pid) {
  if (!taskId || !pid) return;
  try {
    await roleAudit.clearTaskProcess(taskId, pid, { db });
  } catch (err) {
    logger.error("shell: current_pid 정리 실패", err);
  }
}

/**
 * 로컬 CLI 명령을 child_process.spawn(shell: false)으로 실행합니다.
 * 쉘을 거치지 않으므로 인자를 이스케이프할 필요가 없고, 인젝션 위험도 없습니다.
 *
 * @param {string} command 실행 파일 이름 (예: "git", "claude", "codex", "agy", "ollama")
 * @param {string[]} [args] argv 배열. 쉘 해석 없이 그대로 전달된다.
 * @param {object} options
 * @param {string} options.cwd 필수. 명령이 실행될 작업 디렉토리이자 path sandbox 기준 경로(PROJECT_ROOT 역할).
 * @param {boolean} [options.trusted=false] true면 commandGuard의 allow/blocklist 및 인자 경로 검사를
 *   완전히 건너뛴다. services/git.js의 고정 복구 명령(add/commit/checkout/clean)처럼 이미
 *   !approve/!reject 승인 절차로 보호되는, 내부 하드코딩된 명령에만 사용해야 한다.
 *   에이전트 CLI 런처(claude/codex/agy/ollama)는 trusted를 쓰지 않고, commandGuard의
 *   allowlist에 명시적으로 등록된 형태로 검증을 실제로 통과한다.
 * @param {string} [options.taskId] 차단 시 command_logs에 남길 task_id
 * @param {string} [options.agentName] command_logs에 남길 agent 이름
 * @param {number} [options.timeoutMs] timeout. 생략 시 agent별 env 또는 AGENT_TIMEOUT_MS 사용
 * @param {number} [options.killGraceMs=5000] timeout 후 SIGKILL까지 기다릴 시간
 * @param {(child: import("child_process").ChildProcess) => void} [options.onSpawn] child PID 추적용 콜백
 * @returns {Promise<{stdout: string, stderr: string, durationMs: number}>}
 */
async function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    trusted = false,
    taskId = null,
    agentName = null,
    timeoutMs: explicitTimeoutMs = null,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    onSpawn = null,
    detached: explicitDetached = null,
    ...spawnOptions
  } = options;

  if (!cwd) {
    throw new Error("runCommand: cwd는 필수입니다 (PROJECT_ROOT 역할을 겸함).");
  }

  // cwd 자체가 실제 존재하는 경로이고 심볼릭 링크로 엉뚱한 곳을 가리키지 않는지 확인한다.
  const realCwd = pathGuard.assertInsideProjectRoot(".", cwd);

  if (!trusted) {
    await assertRegisteredAgentWorkspace({ agentName, taskId, cwd: realCwd });
    const context = { taskId, agentName };
    await commandGuard.assertCommandAllowed(command, args, context);
    await commandGuard.assertArgsSafe(command, args, cwd, context);
  }

  const fullCommand = [command, ...args].join(" ");
  const timeoutMs = resolveTimeoutMs(command, agentName, explicitTimeoutMs);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const detached = explicitDetached !== null && explicitDetached !== undefined
      ? explicitDetached
      : process.platform !== "win32";
    const child = spawn(command, args, {
      ...spawnOptions,
      cwd: realCwd,
      detached,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: requiresIsolatedWorkspace(agentName) ? buildAgentEnvironment(envWithPaths) : envWithPaths,
    });
    const childPid = child.pid || null;
    const childPgid = detached && childPid && process.platform !== "win32" ? childPid : null;
    const hostId = hostIdentity.getHostId();
    const ownerInstanceId = currentOwnerInstanceId();
    const pidReady = taskId && childPid
      ? updateTaskProcess(taskId, { pid: childPid, pgid: childPgid, hostId, ownerInstanceId })
      : Promise.resolve();

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let killed = false;
    let timeoutTimer = null;
    let killTimer = null;

    function durationMs() {
      return Date.now() - startedAt;
    }

    function clearTimers() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    }

    function finishWithResolve() {
      if (finished) return;
      finished = true;
      clearTimers();
      const duration = durationMs();
      const cleanStdout = stdout.trim();
      const cleanStderr = stderr.trim();
      Promise.allSettled([
        pidReady.then(() => clearTaskPid(taskId, childPid)),
        logCommandExecution({
          taskId,
          agentName,
          fullCommand,
          stdout: cleanStdout,
          stderr: cleanStderr,
          exitCode: 0,
          durationMs: duration,
          timedOut,
          killed,
        }),
      ]).finally(() => {
        resolve({ stdout: cleanStdout, stderr: cleanStderr, durationMs: duration });
      });
    }

    function finishWithReject(error, exitCode = null) {
      if (finished) return;
      finished = true;
      clearTimers();
      const duration = durationMs();
      const cleanStdout = stdout.trim();
      const cleanStderr = stderr.trim();
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const stderrForLog = cleanStderr || normalizedError.message;
      Promise.allSettled([
        pidReady.then(() => clearTaskPid(taskId, childPid)),
        logCommandExecution({
          taskId,
          agentName,
          fullCommand,
          stdout: cleanStdout,
          stderr: stderrForLog,
          exitCode,
          durationMs: duration,
          timedOut,
          killed,
        }),
      ]).finally(() => {
        reject({
          error: normalizedError,
          stdout: cleanStdout,
          stderr: cleanStderr,
          timedOut,
          killed,
          durationMs: duration,
        });
      });
    }

    if (typeof onSpawn === "function") {
      try {
        onSpawn(child);
      } catch (err) {
        logger.error("shell: onSpawn 콜백 실행 실패", err);
      }
    }

    pidReady.catch((error) => {
      if (finished) return;
      try {
        sendSignalToChildTree({ pid: childPid, pgid: childPgid, signal: "SIGTERM" });
      } catch (signalError) {
        logger.error("shell: PID 감사 실패 후 SIGTERM 전송 실패", signalError);
      }
      finishWithReject(error, null);
    });

    if (timeoutMs) {
      timeoutTimer = setTimeout(() => {
        if (finished) return;
        timedOut = true;
        const timeoutError = new Error(`Command timed out after ${timeoutMs}ms`);
        try {
          sendSignalToChildTree({ pid: childPid, pgid: childPgid, signal: "SIGTERM" });
        } catch (err) {
          logger.error("shell: SIGTERM 전송 실패", err);
        }
        killTimer = setTimeout(() => {
          if (finished) return;
          killed = true;
          try {
            sendSignalToChildTree({ pid: childPid, pgid: childPgid, signal: "SIGKILL" });
          } catch (err) {
            logger.error("shell: SIGKILL 전송 실패", err);
          }
          finishWithReject(timeoutError, null);
        }, parsePositiveInt(killGraceMs) || DEFAULT_KILL_GRACE_MS);
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finishWithReject(error, null);
    });

    child.on("close", (exitCode) => {
      if (timedOut || exitCode !== 0) {
        const error = timedOut
          ? new Error(`Command timed out after ${timeoutMs}ms`)
          : new Error(`Command exited with code ${exitCode}`);
        finishWithReject(error, exitCode);
      } else {
        finishWithResolve();
      }
    });
  });
}

/**
 * runCommand가 실패할 때 던지는 두 가지 서로 다른 형태에서 사람이 읽을 수 있는
 * 에러 메시지를 최대한 보존해서 뽑아낸다.
 * 1) commandGuard.assertCommandAllowed/assertArgsSafe가 던지는 일반 Error 객체
 *    (예: "Blocked command (skill blocklist: ...): ...") - 이 경우 .stdout/.stderr가
 *    없으므로, 이전에는 agents/*.js의 `error.stderr || error.error` 같은 접근이
 *    전부 undefined가 되어 "실행 실패: undefined"로 뭉개지는 버그가 있었다.
 * 2) spawn 자체가 실패하거나 명령이 0이 아닌 exit code/timeout으로 끝났을 때 reject하는
 *    { error, stdout, stderr, timedOut, killed, durationMs } 형태.
 * @param {*} error runCommand 호출부의 catch(error)에서 받은 값
 * @returns {string}
 */
function extractErrorMessage(error) {
  if (!error) return "알 수 없는 오류";
  if (error.stderr) return error.stderr;
  if (error.message) return error.message; // 1) commandGuard가 던진 일반 Error
  if (error.error) {
    return error.error instanceof Error ? error.error.message : String(error.error);
  }
  return String(error);
}

module.exports = {
  buildAgentEnvironment,
  runCommand,
  extractErrorMessage,
  _internal: {
    DEFAULT_TIMEOUT_MS,
    timeoutEnvKeyFor,
    resolveTimeoutMs,
  },
};
