function successResult(text, startedAt, raw = {}) {
  return {
    text: text || "",
    raw: {
      stdout: text || "",
      stderr: "",
      ...raw,
    },
    exitCode: 0,
    timedOut: false,
    killed: false,
    durationMs: Date.now() - startedAt,
  };
}

function errorResult(error, startedAt) {
  const raw = {
    stdout: error && error.stdout ? error.stdout : "",
    stderr: error && error.stderr ? error.stderr : "",
    errorMessage: error && error.message ? error.message : String(error || "알 수 없는 오류"),
    errorCode: error && error.code ? error.code : "ADAPTER_EXECUTION_FAILED",
  };

  return {
    text: raw.stdout,
    raw,
    exitCode: 1,
    timedOut: Boolean(error && error.timedOut),
    killed: Boolean(error && error.killed),
    durationMs: error && typeof error.durationMs === "number" ? error.durationMs : Date.now() - startedAt,
  };
}

module.exports = {
  successResult,
  errorResult,
};
