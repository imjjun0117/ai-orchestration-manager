function enabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function isolatedWorkspaceMode(env = process.env) {
  return enabled(env.ISOLATED_WORKSPACE_MODE);
}

function coderWriteEnabled(env = process.env) {
  return enabled(env.CODER_WRITE_ENABLED);
}

function assertIsolatedWriteEnabled(env = process.env) {
  if (!isolatedWorkspaceMode(env)) {
    throw new Error("ISOLATED_WORKSPACE_MODE=true is required; canonical write fallback is forbidden");
  }
  if (!coderWriteEnabled(env)) {
    throw new Error("CODER_WRITE_ENABLED=true is required after Phase 16 Gate acceptance");
  }
  return true;
}

module.exports = {
  assertIsolatedWriteEnabled,
  coderWriteEnabled,
  enabled,
  isolatedWorkspaceMode,
};
