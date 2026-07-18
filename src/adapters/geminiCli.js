const geminiAdapter = require("./geminiAdapter");

async function runGemini(prompt, options = {}) {
  const result = await geminiAdapter.invoke(prompt, options);
  return {
    stdout: result.text,
    stderr: result.raw.stderr || result.raw.errorMessage || "",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

module.exports = {
  runGemini,
};
