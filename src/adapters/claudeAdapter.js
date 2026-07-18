const { askClaude } = require("../../agents/claude");
const { successResult, errorResult } = require("./adapterResult");

const claudeAdapter = {
  name: "claude",
  capabilities: {
    canExec: true,
    canReview: true,
    canPlan: true,
    canSummarize: true,
  },
  async invoke(prompt, opts = {}) {
    const startedAt = Date.now();
    const { workspaceDir, ...runOptions } = opts;
    try {
      const text = await askClaude(prompt, { ...runOptions, cwd: workspaceDir || opts.cwd });
      return successResult(text, startedAt);
    } catch (err) {
      return errorResult(err, startedAt);
    }
  },
};

module.exports = claudeAdapter;
