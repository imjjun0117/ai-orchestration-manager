const { askGemma } = require("../../agents/gemma");
const { successResult, errorResult } = require("./adapterResult");

const gemmaAdapter = {
  name: "gemma",
  capabilities: {
    canExec: false,
    canReview: false,
    canPlan: false,
    canSummarize: true,
  },
  async invoke(prompt, opts = {}) {
    const startedAt = Date.now();
    const { workspaceDir, ...runOptions } = opts;
    try {
      const text = await askGemma(prompt, { ...runOptions, cwd: workspaceDir || opts.cwd });
      return successResult(text, startedAt);
    } catch (err) {
      return errorResult(err, startedAt);
    }
  },
};

module.exports = gemmaAdapter;
