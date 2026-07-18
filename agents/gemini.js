const fs = require("fs");
const path = require("path");
const { runCommand, extractErrorMessage } = require("../services/shell");

/**
 * Antigravity CLI를 비대화식 모드로 실행하여 응답을 받습니다.
 * @param {string} prompt 에이전트에게 보낼 프롬프트
 * @param {object} options 추가 옵션 (예: cwd 등)
 * @returns {Promise<string>} 응답 텍스트
 */
async function askGemini(prompt, options = {}) {
  // prompts/reviewer.md 로드하여 프롬프트와 결합
  const skillPath = path.join(__dirname, "../prompts/reviewer.md");
  let systemPrompt = "";
  if (fs.existsSync(skillPath)) {
    systemPrompt = fs.readFileSync(skillPath, "utf8");
  }

  const combinedPrompt = `${systemPrompt}\n\n[리뷰 대상 및 질문]:\n${prompt}`;

  // --print: Run a single prompt non-interactively and print the response
  // Gemini는 reviewer.md 상 리뷰 전용 역할이므로 파일 수정/커밋/푸시 권한이 필요 없다.
  // --dangerously-skip-permissions는 절대 사용하지 않는다 (과거 이 플래그로 인해
  // 이 프로세스가 dev/cms 리포지토리를 스스로 수정/커밋/푸시한 사고가 있었음).
  // --sandbox: 터미널/파일 조작을 제한하는 안전 모드로 실행.
  // --new-project: 매 호출마다 새 세션으로 시작해 이전에 남아있던(다른 프로젝트의)
  // 대화 상태를 이어받지 않도록 강제.
  // spawn(shell:false)으로 실행되므로 combinedPrompt는 이스케이프 없이 단일 argv로 전달된다.
  // trusted: false - commandGuard allowlist(["agy","--print"])를 실제로 통과시킨다.
  // 주의: commandGuard.getLauncherPromptArgIndex()가 "agy"의 프롬프트 위치를
  // "--print" 바로 다음 인자로 가정한다. 이 argv 순서를 바꾸면 그쪽도 같이 맞춰야 한다.
  const args = ["--print", combinedPrompt, "--new-project", "--sandbox"];

  try {
    const { stdout } = await runCommand("agy", args, { ...options, trusted: false, agentName: "gemini" });
    return stdout;
  } catch (error) {
    if (error.stdout) {
      return error.stdout;
    }
    const err = new Error(`Gemini(Antigravity) 실행 실패: ${extractErrorMessage(error)}`);
    err.timedOut = error.timedOut;
    err.killed = error.killed;
    err.durationMs = error.durationMs;
    err.stdout = error.stdout;
    err.stderr = error.stderr;
    throw err;
  }
}

module.exports = {
  askGemini,
};
