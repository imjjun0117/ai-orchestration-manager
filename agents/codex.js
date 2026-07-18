const fs = require("fs");
const path = require("path");
const { runCommand, extractErrorMessage } = require("../services/shell");

/**
 * Codex CLI를 비대화식 모드로 실행하여 응답을 받습니다.
 * @param {string} prompt 에이전트에게 보낼 프롬프트
 * @param {object} options 추가 옵션 (예: cwd 등)
 * @returns {Promise<string>} 응답 텍스트
 */
async function askCodex(prompt, options = {}) {
  // prompts/developer.md 로드하여 프롬프트와 결합
  const skillPath = path.join(__dirname, "../prompts/developer.md");
  let systemPrompt = "";
  if (fs.existsSync(skillPath)) {
    systemPrompt = fs.readFileSync(skillPath, "utf8");
  }

  const combinedPrompt = `${systemPrompt}\n\n[작업 요구사항]:\n${prompt}`;

  // --ask-for-approval은 글로벌 옵션이므로 exec 서브커맨드 앞에 위치해야 함.
  // --sandbox workspace-write로 실제 파일 생성/수정을 허용 (read-only면 아무 것도 못 씀).
  // --skip-git-repo-check로 Git 검증 우회.
  // spawn(shell:false)으로 실행되므로 combinedPrompt는 이스케이프 없이 단일 argv로 전달된다.
  // trusted: false - commandGuard allowlist(["codex","--ask-for-approval","never","exec"])를 실제로 통과시킨다.
  // 주의: commandGuard.getLauncherPromptArgIndex()가 "codex"의 프롬프트 위치를
  // args 배열의 "마지막 인자"로 가정한다. combinedPrompt는 반드시 args의 맨 끝에
  // 와야 하며, 뒤에 다른 인자를 추가하면 안 된다 (추가하려면 그쪽도 같이 맞춰야 한다).
  const args = [
    "--ask-for-approval", "never",
    "exec",
    "--sandbox", "workspace-write",
    "--skip-git-repo-check",
    combinedPrompt,
  ];

  try {
    const { stdout } = await runCommand("codex", args, { ...options, trusted: false, agentName: "codex" });
    return stdout;
  } catch (error) {
    if (error.stdout) {
      return error.stdout;
    }
    const err = new Error(`Codex 실행 실패: ${extractErrorMessage(error)}`);
    err.timedOut = error.timedOut;
    err.killed = error.killed;
    err.durationMs = error.durationMs;
    err.stdout = error.stdout;
    err.stderr = error.stderr;
    throw err;
  }
}

module.exports = {
  askCodex,
};
