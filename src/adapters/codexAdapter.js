const { askCodex } = require("../../agents/codex");
const { successResult, errorResult } = require("./adapterResult");

const codexAdapter = {
  name: "codex",
  capabilities: {
    canExec: true,
    canReview: true,
    canPlan: false,
    canSummarize: false,
  },
  async invoke(prompt, opts = {}) {
    const startedAt = Date.now();
    const { workspaceDir, ...runOptions } = opts;
    try {
      const text = await askCodex(prompt, { ...runOptions, cwd: workspaceDir || opts.cwd });
      return successResult(text, startedAt);
    } catch (err) {
      return errorResult(err, startedAt);
    }
  },
};

module.exports = codexAdapter;
