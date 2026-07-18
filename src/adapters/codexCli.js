const codexAdapter = require("./codexAdapter");

async function runCodex(prompt, options = {}) {
  const result = await codexAdapter.invoke(prompt, options);
  return {
    stdout: result.text,
    stderr: result.raw.stderr || result.raw.errorMessage || "",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

module.exports = {
  runCodex,
};
