const { runCommand, extractErrorMessage } = require("../services/shell");

const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
const PROVIDER_FAILURE_PATTERNS = [
  /^you're out of usage credits\b/i,
  /^not logged in\b/i,
  /^authentication (?:failed|required)\b/i,
];

function assertModelName(model) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) {
    throw new Error("CLAUDE_MODEL 형식이 올바르지 않습니다.");
  }
}

function assertUsableResponse(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    const error = new Error("Claude가 빈 응답을 반환했습니다.");
    error.code = "CLAUDE_EMPTY_RESPONSE";
    throw error;
  }
  if (PROVIDER_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    const error = new Error("Claude 공급자 사용량 또는 인증 오류로 응답을 생성하지 못했습니다.");
    error.code = "CLAUDE_PROVIDER_UNAVAILABLE";
    error.stdout = text;
    throw error;
  }
  return text;
}

/**
 * Claude Code CLI를 실행하여 응답을 받습니다.
 * @param {string} prompt 에이전트에게 보낼 프롬프트
 * @param {object} options 추가 옵션 (예: cwd 등)
 * @returns {Promise<string>} 응답 텍스트
 */
async function askClaude(prompt, options = {}) {
  const {
    model = process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    run = runCommand,
    ...commandOptions
  } = options;
  assertModelName(model);
  // -p: Print response and exit
  // --permission-mode dontAsk: 권한 요청이 필요한 동작 발생 시 승인 대기 없이 차단/거절하여 비대화식 동작 보장
  // --tools "": 일회성 단순 질의 시 로컬 디렉토리 파일 스캔(Read/Glob 등)을 시도하다 백그라운드 쉘에서 먹통이 되는 버그 방지
  // spawn(shell:false)으로 실행되므로 prompt는 별도 이스케이프 없이 argv 배열 그대로 전달된다.
  // trusted: false - commandGuard allowlist(["claude", "-p"])를 실제로 통과시킨다.
  // 주의: commandGuard.getLauncherPromptArgIndex()가 "claude"의 프롬프트 위치를
  // "-p" 바로 다음 인자로 가정한다. 이 argv 순서를 바꾸면 그쪽도 같이 맞춰야 한다.
  const args = ["-p", prompt, "--model", model, "--permission-mode", "dontAsk", "--tools", ""];

  try {
    const { stdout } = await run("claude", args, { ...commandOptions, trusted: false, agentName: "claude" });
    return assertUsableResponse(stdout);
  } catch (error) {
    if (error && error.code) throw error;
    const err = new Error(`Claude 실행 실패: ${extractErrorMessage(error)}`);
    err.code = "CLAUDE_EXECUTION_FAILED";
    err.timedOut = error.timedOut;
    err.killed = error.killed;
    err.durationMs = error.durationMs;
    err.stdout = error.stdout;
    err.stderr = error.stderr;
    throw err;
  }
}

module.exports = {
  DEFAULT_CLAUDE_MODEL,
  askClaude,
  assertUsableResponse,
};
