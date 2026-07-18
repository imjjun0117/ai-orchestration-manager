const { askGemini } = require("../../agents/gemini");
const { successResult, errorResult } = require("./adapterResult");

const geminiAdapter = {
  name: "gemini",
  capabilities: {
    canExec: false,
    canReview: true,
    canPlan: false,
    canSummarize: true,
  },
  async invoke(prompt, opts = {}) {
    const startedAt = Date.now();
    const { workspaceDir, ...runOptions } = opts;
    try {
      const text = await askGemini(prompt, { ...runOptions, cwd: workspaceDir || opts.cwd });
      return successResult(text, startedAt);
    } catch (err) {
      return errorResult(err, startedAt);
    }
  },
};

module.exports = geminiAdapter;
