const fs = require("fs");
const path = require("path");
const { runCommand, extractErrorMessage } = require("../services/shell");

// mode별로 다른 시스템 프롬프트를 쓴다. summarizer.md(기본값)는 Git Diff/에러 로그를
// 이모지 섞인 "한 줄 요약"으로 만드는 용도(finalizeAfterReview의 최종 diff 요약)이고,
// conversationSummarizer.md는 Context Builder(summaryService)가 대화 히스토리를
// 장식 없이 담백하게 rolling 요약할 때 쓴다. 두 역할을 같은 프롬프트로 섞으면 대화
// 요약에도 이모지/마크다운 장식이 섞여 나오는 문제가 있었다.
const PROMPT_FILE_BY_MODE = {
  "diff-summary": "summarizer.md",
  "conversation-summary": "conversationSummarizer.md",
};

const INPUT_LABEL_BY_MODE = {
  "diff-summary": "[요약 대상 로그/Diff]",
  "conversation-summary": "[요약 대상 대화 내역]",
};

/**
 * Ollama를 통해 Gemma4 모델을 실행하여 응답을 받습니다.
 * @param {string} prompt 에이전트에게 보낼 프롬프트
 * @param {object} options 추가 옵션 (예: cwd 등)
 * @param {string} [options.mode] "diff-summary"(기본값) | "conversation-summary" - 어떤 system prompt를 쓸지 선택
 * @returns {Promise<string>} 응답 텍스트
 */
async function askGemma(prompt, options = {}) {
  const { mode = "diff-summary", ...runOptions } = options;
  const promptFile = PROMPT_FILE_BY_MODE[mode] || PROMPT_FILE_BY_MODE["diff-summary"];
  const inputLabel = INPUT_LABEL_BY_MODE[mode] || INPUT_LABEL_BY_MODE["diff-summary"];

  const skillPath = path.join(__dirname, `../prompts/${promptFile}`);
  let systemPrompt = "";
  if (fs.existsSync(skillPath)) {
    systemPrompt = fs.readFileSync(skillPath, "utf8");
  }

  const combinedPrompt = `${systemPrompt}\n\n${inputLabel}:\n${prompt}`;

  // ollama run gemma4:e4b "질문" --hidethinking --nowordwrap
  // gemma4:e4b는 기본적으로 답변 앞에 긴 사고 과정(Thinking...~...done thinking.)을
  // 그대로 출력하는 "thinking" 모델이라, --hidethinking 없이는 요약/커밋 요약처럼
  // 짧아야 할 결과물이 오히려 수천 자짜리 추론 로그로 부풀려진다 (Phase 4 컨텍스트
  // 압축의 의미가 없어짐). --hidethinking으로 최종 답변만 남긴다.
  // --nowordwrap: 비TTY 환경에서도 ollama가 자동 줄바꿈을 하며 ANSI 커서/지우기
  // 제어 코드(\x1B[K 등)를 섞어 내보내는 걸 막는다 (안 붙이면 저장되는 요약/응답
  // 텍스트 중간에 제어 문자가 깨진 채로 섞여 들어감).
  // spawn(shell:false)으로 실행되므로 combinedPrompt는 이스케이프 없이 단일 argv로 전달된다.
  // trusted: false - commandGuard allowlist(["ollama","run"])를 실제로 통과시킨다.
  // 주의: commandGuard.getLauncherPromptArgIndex()가 "ollama"의 프롬프트 위치를
  // "run <model>" 다음 인자(즉 "run"의 인덱스+2)로 가정한다. combinedPrompt는 반드시
  // "run"의 인덱스+2에 있어야 하므로, 플래그들은 프롬프트 "다음"에 둔다. mode는 여기서
  // 소비하고 runOptions에는 남기지 않으므로 runCommand로 흘러가지 않는다.
  const args = ["run", "gemma4:e4b", combinedPrompt, "--hidethinking", "--nowordwrap"];

  try {
    const { stdout } = await runCommand("ollama", args, { ...runOptions, trusted: false, agentName: "gemma" });
    return stdout;
  } catch (error) {
    if (error.stdout) {
      return error.stdout;
    }
    const err = new Error(`Gemma4 실행 실패: ${extractErrorMessage(error)}`);
    err.timedOut = error.timedOut;
    err.killed = error.killed;
    err.durationMs = error.durationMs;
    err.stdout = error.stdout;
    err.stderr = error.stderr;
    throw err;
  }
}

module.exports = {
  askGemma,
};
