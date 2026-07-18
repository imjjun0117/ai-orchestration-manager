const { runCommand, extractErrorMessage } = require("../services/shell");

/**
 * Claude Code CLI를 실행하여 응답을 받습니다.
 * @param {string} prompt 에이전트에게 보낼 프롬프트
 * @param {object} options 추가 옵션 (예: cwd 등)
 * @returns {Promise<string>} 응답 텍스트
 */
async function askClaude(prompt, options = {}) {
  // -p: Print response and exit
  // --permission-mode dontAsk: 권한 요청이 필요한 동작 발생 시 승인 대기 없이 차단/거절하여 비대화식 동작 보장
  // --tools "": 일회성 단순 질의 시 로컬 디렉토리 파일 스캔(Read/Glob 등)을 시도하다 백그라운드 쉘에서 먹통이 되는 버그 방지
  // spawn(shell:false)으로 실행되므로 prompt는 별도 이스케이프 없이 argv 배열 그대로 전달된다.
  // trusted: false - commandGuard allowlist(["claude", "-p"])를 실제로 통과시킨다.
  // 주의: commandGuard.getLauncherPromptArgIndex()가 "claude"의 프롬프트 위치를
  // "-p" 바로 다음 인자로 가정한다. 이 argv 순서를 바꾸면 그쪽도 같이 맞춰야 한다.
  const args = ["-p", prompt, "--permission-mode", "dontAsk", "--tools", ""];

  try {
    const { stdout } = await runCommand("claude", args, { ...options, trusted: false, agentName: "claude" });
    return stdout;
  } catch (error) {
    if (error.stdout) {
      return error.stdout; // 에러가 났더라도 출력된 내용이 있으면 반환
    }
    const err = new Error(`Claude 실행 실패: ${extractErrorMessage(error)}`);
    err.timedOut = error.timedOut;
    err.killed = error.killed;
    err.durationMs = error.durationMs;
    err.stdout = error.stdout;
    err.stderr = error.stderr;
    throw err;
  }
}

module.exports = {
  askClaude,
};
