const { canonicalJson, sha256Bytes } = require("../delivery/canonicalSubmissionManifest");

function normalizedStrings(values = []) {
  if (!Array.isArray(values)) throw new Error("context list values must be arrays");
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeScopePattern(value) {
  const pattern = String(value || "").trim().replaceAll("\\", "/");
  if (!pattern || pattern.startsWith("/") || pattern.split("/").includes("..")) {
    throw new Error(`unsafe context path scope: ${value}`);
  }
  return pattern;
}

function buildExecutionContextManifest({
  taskId,
  originalRequest,
  plan = null,
  instruction,
  role,
  expectedTaskState,
  expectedTaskVersion,
  allowedPaths = [],
  allowedTools = [],
  riskLevel = "unknown",
  policyVersion = "phase16-v1",
  constraints = {},
}) {
  if (!String(taskId || "").trim()) throw new Error("context taskId is required");
  if (!String(originalRequest || "").trim()) throw new Error("context originalRequest is required");
  if (!String(instruction || "").trim()) throw new Error("context instruction is required");
  if (!String(role || "").trim()) throw new Error("context role is required");
  if (!String(expectedTaskState || "").trim()) throw new Error("context expectedTaskState is required");
  if (!Number.isInteger(Number(expectedTaskVersion)) || Number(expectedTaskVersion) < 0) {
    throw new Error("context expectedTaskVersion must be a non-negative integer");
  }
  const manifest = {
    schemaVersion: 1,
    taskId: String(taskId),
    role: String(role),
    originalRequest: String(originalRequest),
    plan: plan === null ? null : String(plan),
    instruction: String(instruction),
    expectedTaskState: String(expectedTaskState),
    expectedTaskVersion: Number(expectedTaskVersion),
    allowedPaths: normalizedStrings(allowedPaths).map(normalizeScopePattern),
    allowedTools: normalizedStrings(allowedTools),
    riskLevel: String(riskLevel || "unknown"),
    policyVersion: String(policyVersion),
    constraints: constraints && typeof constraints === "object" && !Array.isArray(constraints) ? constraints : {},
  };
  return {
    manifest,
    contextManifestHash: sha256Bytes(Buffer.from(canonicalJson(manifest), "utf8")),
  };
}

module.exports = {
  buildExecutionContextManifest,
  normalizeScopePattern,
  normalizedStrings,
};
