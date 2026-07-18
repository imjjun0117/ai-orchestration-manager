const claudeAdapter = require("./claudeAdapter");

async function runClaude(prompt, options = {}) {
  const result = await claudeAdapter.invoke(prompt, options);
  return {
    stdout: result.text,
    stderr: result.raw.stderr || result.raw.errorMessage || "",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

module.exports = {
  runClaude,
};
