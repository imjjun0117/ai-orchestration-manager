const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const defaultDb = require("../db");
const { assertPhase16WriteEnabled } = require("./featureFlags");

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SAFE_ENV_KEYS = Object.freeze(["PATH", "LANG", "LC_ALL", "TZ", "TERM"]);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertWorkspaceCwd(workspacePath, cwd = workspacePath) {
  const realWorkspace = fs.realpathSync.native(workspacePath);
  const realCwd = fs.realpathSync.native(cwd);
  if (realCwd !== realWorkspace && !realCwd.startsWith(`${realWorkspace}${path.sep}`)) {
    throw new Error("sandbox cwd escapes the isolated workspace");
  }
  return { realWorkspace, realCwd };
}

function sanitizedEnvironment(source = process.env) {
  const result = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) result[key] = String(source[key]);
  }
  result.CI = "true";
  result.NO_COLOR = "1";
  return result;
}

function validateContainerImage(image) {
  const value = String(image || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(value)) {
    throw new Error("SANDBOX_CONTAINER_IMAGE must be an explicit container image reference");
  }
  if (value.endsWith(":latest") || (!value.includes(":") && !value.includes("@sha256:"))) {
    throw new Error("sandbox container image must use an explicit non-latest tag or digest");
  }
  return value;
}

function defaultContainerUser() {
  const processUid = typeof process.getuid === "function" ? process.getuid() : 65534;
  const processGid = typeof process.getgid === "function" ? process.getgid() : 65534;
  const uid = processUid === 0 ? 65534 : processUid;
  const gid = processUid === 0 ? 65534 : processGid;
  return `${uid}:${gid}`;
}

function validateContainerUser(value = defaultContainerUser()) {
  const normalized = String(value || "").trim();
  if (!/^\d{1,10}:\d{1,10}$/.test(normalized) || normalized.startsWith("0:")) {
    throw new Error("sandbox container user must be an explicit non-root uid:gid");
  }
  return normalized;
}

function buildContainerInvocation({
  workspacePath,
  cwd = workspacePath,
  command,
  args = [],
  image,
  memoryMb = 1024,
  cpus = 1,
  pidsLimit = 128,
  networkAllowed = false,
  containerUser = defaultContainerUser(),
}) {
  if (networkAllowed) throw new Error("sandbox network is denied by default; an allowlisted proxy is not configured");
  if (!String(command || "").trim()) throw new Error("sandbox command is required");
  const { realWorkspace, realCwd } = assertWorkspaceCwd(workspacePath, cwd);
  const relativeCwd = path.relative(realWorkspace, realCwd).split(path.sep).join("/");
  const containerCwd = relativeCwd ? `/workspace/${relativeCwd}` : "/workspace";
  const containerImage = validateContainerImage(image);
  return {
    executable: "docker",
    args: [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      validateContainerUser(containerUser),
      "--ipc",
      "none",
      "--pids-limit",
      String(positiveInteger(pidsLimit, 128)),
      "--memory",
      `${positiveInteger(memoryMb, 1024)}m`,
      "--cpus",
      String(Number(cpus) > 0 ? Number(cpus) : 1),
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=128m",
      "--mount",
      `type=bind,src=${realWorkspace},dst=/workspace`,
      "--workdir",
      containerCwd,
      "--env",
      "CI=true",
      "--env",
      "NO_COLOR=1",
      containerImage,
      command,
      ...args.map(String),
    ],
    env: sanitizedEnvironment(),
    policy: {
      backend: "container",
      canonicalRepositoryMounted: false,
      network: "DENY",
      workspaceAccess: "READ_WRITE",
      rootFilesystem: "READ_ONLY",
    },
  };
}

async function runSandboxed(
  options,
  {
    db = defaultDb,
    env = process.env,
    runner = execFileAsync,
  } = {}
) {
  await assertPhase16WriteEnabled({ db, env });
  const backend = String(options.backend || env.ISOLATED_SANDBOX_BACKEND || "").trim().toLowerCase();
  if (backend !== "container") {
    throw new Error("untrusted execution requires ISOLATED_SANDBOX_BACKEND=container; fallback execution is forbidden");
  }
  const invocation = buildContainerInvocation({
    ...options,
    image: options.image || env.SANDBOX_CONTAINER_IMAGE,
  });
  const timeout = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBuffer = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const result = await runner(invocation.executable, invocation.args, {
    env: invocation.env,
    timeout,
    maxBuffer,
    windowsHide: true,
  });
  return {
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    policy: invocation.policy,
  };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  SAFE_ENV_KEYS,
  assertWorkspaceCwd,
  buildContainerInvocation,
  runSandboxed,
  sanitizedEnvironment,
  validateContainerUser,
  validateContainerImage,
};
