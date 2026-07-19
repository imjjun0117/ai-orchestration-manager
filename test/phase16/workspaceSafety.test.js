const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { afterEach, test } = require("node:test");

const { buildCandidateArtifact, describeCandidateArtifact } = require("../../src/workspace/artifactService");
const { buildExecutionContextManifest } = require("../../src/workspace/contextManifestService");
const { assertIsolatedWriteEnabled, assertPhase16WriteEnabled } = require("../../src/workspace/featureFlags");
const { assertTargetRef } = require("../../src/workspace/finalizerService");
const { assertManagedWorkspacePath, ensureIsolationRoot } = require("../../src/workspace/isolatedWorkspaceService");
const processService = require("../../src/core/processService");
const {
  buildContainerInvocation,
  runRegisteredNativeAgent,
  runSandboxed,
  sanitizedEnvironment,
  validateContainerImage,
} = require("../../src/workspace/sandboxService");
const { buildAgentEnvironment } = require("../../services/shell");
const taskControlService = require("../../src/workspace/taskControlService");
const { buildCodexArgs } = require("../../agents/codex");
const { assertAgentWorkspace, assertRegisteredAgentWorkspace } = require("../../src/workspace/workspaceExecutionPolicy");
const { formatBoundApproval } = require("../../src/workspace/approvalDisplay");
const { assertArtifactScope, globPattern } = require("../../src/workspace/taskWorkspaceWorkflowService");

const temporaryPaths = [];

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

afterEach(() => {
  while (temporaryPaths.length) fs.rmSync(temporaryPaths.pop(), { recursive: true, force: true });
});

test("isolated writes fail closed until both Phase 16 flags are enabled", () => {
  assert.throws(() => assertIsolatedWriteEnabled({}), /ISOLATED_WORKSPACE_MODE=true/);
  assert.throws(
    () => assertIsolatedWriteEnabled({ ISOLATED_WORKSPACE_MODE: "true", CODER_WRITE_ENABLED: "false" }),
    /CODER_WRITE_ENABLED=true/
  );
  assert.equal(
    assertIsolatedWriteEnabled({ ISOLATED_WORKSPACE_MODE: "TRUE", CODER_WRITE_ENABLED: "true" }),
    true
  );
});

test("isolated writes require an ACCEPTED Phase 16 Gate in addition to flags", async () => {
  const env = { ISOLATED_WORKSPACE_MODE: "true", CODER_WRITE_ENABLED: "true" };
  await assert.rejects(
    assertPhase16WriteEnabled({
      env,
      db: { query: async () => ({ rows: [{ id: "phase-16", status: "VALIDATION_IN_PROGRESS" }] }) },
    }),
    /must be ACCEPTED/
  );
  const accepted = await assertPhase16WriteEnabled({
    env,
    db: { query: async () => ({ rows: [{ id: "phase-16", status: "ACCEPTED" }] }) },
  });
  assert.equal(accepted.status, "ACCEPTED");
});

test("Coder and QA can never fall back to the canonical workspace", () => {
  const canonical = temporaryDirectory("phase16-policy-canonical-");
  const isolationRoot = temporaryDirectory("phase16-policy-isolation-");
  const isolated = path.join(isolationRoot, "task", "repository");
  fs.mkdirSync(isolated, { recursive: true });
  const enabledEnv = {
    ISOLATED_WORKSPACE_MODE: "true",
    CODER_WRITE_ENABLED: "true",
    ISOLATED_WORKSPACE_ROOT: isolationRoot,
  };
  assert.throws(
    () => assertAgentWorkspace({ agentName: "codex", cwd: canonical, env: enabledEnv }),
    /canonical fallback is forbidden/
  );
  assert.throws(
    () => assertAgentWorkspace({ agentName: "qa", cwd: isolated, env: { ...enabledEnv, CODER_WRITE_ENABLED: "false" } }),
    /CODER_WRITE_ENABLED=true/
  );
  assert.equal(assertAgentWorkspace({ agentName: "coder", cwd: isolated, env: enabledEnv }).enforced, true);
  assert.equal(assertAgentWorkspace({ agentName: "reviewer", cwd: canonical, env: {} }).enforced, false);
});

test("Coder execution requires a matching task registration and live write lease", async () => {
  const isolationRoot = temporaryDirectory("phase16-policy-registration-");
  const isolated = path.join(isolationRoot, "task", "repository");
  fs.mkdirSync(isolated, { recursive: true });
  const env = {
    ISOLATED_WORKSPACE_MODE: "true",
    CODER_WRITE_ENABLED: "true",
    ISOLATED_WORKSPACE_ROOT: isolationRoot,
  };
  await assert.rejects(
    assertRegisteredAgentWorkspace(
      { agentName: "codex", taskId: null, cwd: isolated, env },
      { db: { query: async () => ({ rows: [{ id: "phase-16", status: "ACCEPTED" }] }) } }
    ),
    /requires a task ID/
  );
  await assert.rejects(
    assertRegisteredAgentWorkspace(
      { agentName: "qa", taskId: "TASK-1", cwd: isolated, env },
      { db: {
        query: async (sql) => sql.includes("delivery_phases")
          ? { rows: [{ id: "phase-16", status: "ACCEPTED" }] }
          : { rows: [] },
      } }
    ),
    /live registered task workspace/
  );
  const accepted = await assertRegisteredAgentWorkspace(
    { agentName: "coder", taskId: "TASK-1", cwd: isolated, env },
    { db: {
      query: async (sql) => sql.includes("delivery_phases")
        ? { rows: [{ id: "phase-16", status: "ACCEPTED" }] }
        : { rows: [{ id: "iw-1", fencing_token: 3 }] },
    } }
  );
  assert.equal(accepted.registration.id, "iw-1");
});

test("container policy mounts only the isolated workspace and strips credentials", () => {
  const workspace = temporaryDirectory("phase16-sandbox-");
  const nested = path.join(workspace, "nested");
  fs.mkdirSync(nested);
  const invocation = buildContainerInvocation({
    workspacePath: workspace,
    cwd: nested,
    command: "node",
    args: ["--version"],
    image: "node:24.14.0-alpine",
  });
  assert.equal(invocation.executable, "docker");
  assert.deepEqual(invocation.policy, {
    backend: "container",
    canonicalRepositoryMounted: false,
    network: "DENY",
    workspaceAccess: "READ_WRITE",
    rootFilesystem: "READ_ONLY",
  });
  assert.ok(invocation.args.includes("none"));
  assert.ok(invocation.args.includes("no-new-privileges"));
  assert.ok(invocation.args.includes("--user"));
  assert.ok(invocation.args.some((entry) => entry === `type=bind,src=${fs.realpathSync(workspace)},dst=/workspace`));
  assert.equal(invocation.env.DATABASE_URL, undefined);
  assert.equal(invocation.env.DISCORD_TOKEN, undefined);
  assert.deepEqual(
    sanitizedEnvironment({ PATH: "/bin", DATABASE_URL: "secret", CHANNEL_TOKEN_MASTER_KEY: "secret" }),
    { PATH: "/bin", CI: "true", NO_COLOR: "1" }
  );
  assert.deepEqual(
    buildAgentEnvironment({
      PATH: "/bin",
      HOME: "/safe-home",
      CODEX_HOME: "/safe-codex",
      DATABASE_URL: "secret",
      DISCORD_TOKEN: "secret",
    }),
    { PATH: "/bin", CI: "true", NO_COLOR: "1", HOME: "/safe-home", CODEX_HOME: "/safe-codex" }
  );
  assert.throws(() => validateContainerImage("node:latest"), /non-latest/);
  assert.throws(() => validateContainerImage("node"), /explicit non-latest/);
  assert.throws(
    () => buildContainerInvocation({ workspacePath: workspace, cwd: os.tmpdir(), command: "true", image: "node:24" }),
    /escapes/
  );
});

test("production native and container runners require the registered isolated task workspace", async () => {
  const canonical = temporaryDirectory("phase16-runtime-canonical-");
  const isolationRoot = temporaryDirectory("phase16-runtime-isolation-");
  const workspace = path.join(isolationRoot, "task", "repository");
  fs.mkdirSync(workspace, { recursive: true });
  const env = {
    ISOLATED_WORKSPACE_MODE: "true",
    CODER_WRITE_ENABLED: "true",
    ISOLATED_SANDBOX_BACKEND: "container",
    ISOLATED_WORKSPACE_ROOT: isolationRoot,
  };
  const db = {
    query: async (sql, params) => {
      if (sql.includes("delivery_phases")) return { rows: [{ id: "phase-16", status: "ACCEPTED" }] };
      if (params[0] === "TASK-RUNTIME" && params[1] === fs.realpathSync(workspace)) {
        return { rows: [{ id: "iw-runtime", workspace_id: "workspace-runtime", fencing_token: 9 }] };
      }
      return { rows: [] };
    },
  };
  await assert.rejects(
    runSandboxed({
      taskId: "TASK-RUNTIME",
      workspacePath: canonical,
      command: "true",
      backend: "container",
      image: "node:24.14.0-alpine",
    }, { db, env, runner: async () => ({ stdout: "", stderr: "" }) }),
    /task-isolated workspace/
  );
  await assert.rejects(
    runSandboxed({
      taskId: "TASK-RUNTIME",
      agentName: "reviewer",
      workspacePath: canonical,
      command: "true",
      backend: "container",
      image: "node:24.14.0-alpine",
    }, { db, env, runner: async () => ({ stdout: "", stderr: "" }) }),
    /write-capable agent identity/
  );
  const container = await runSandboxed({
    taskId: "TASK-RUNTIME",
    workspacePath: workspace,
    command: "true",
    backend: "container",
    image: "node:24.14.0-alpine",
  }, { db, env, runner: async () => ({ stdout: "container-ok", stderr: "" }) });
  assert.equal(container.stdout, "container-ok");
  assert.equal(container.policy.isolatedWorkspaceId, "iw-runtime");
  const native = await runRegisteredNativeAgent({
    taskId: "TASK-RUNTIME",
    workspacePath: workspace,
    agentName: "codex",
  }, {
    db,
    env,
    runner: async ({ cwd, registration }) => `${cwd}:${registration.id}`,
  });
  assert.equal(native.result, `${fs.realpathSync(workspace)}:iw-runtime`);
  assert.equal(native.policy.network, "DENY");
  const codexArgs = buildCodexArgs("approved task context");
  assert.deepEqual(codexArgs.slice(0, 6), [
    "--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check",
  ]);
  assert.equal(codexArgs.at(-1), "approved task context");
});

test("pause never signals before the task compare-and-set succeeds", async () => {
  const calls = [];
  const task = {
    id: "TASK-PAUSE-ORDER",
    row_version: 4,
    current_pid: 4242,
    current_pgid: 4242,
    current_host_id: null,
    current_owner_instance_id: "worker",
  };
  const db = {
    async query(sql) {
      if (sql.includes("SELECT * FROM tasks")) return { rows: [task] };
      throw new Error("simulated compare-and-set database failure");
    },
  };
  await assert.rejects(
    taskControlService.pauseTaskProcess({
      taskId: task.id,
      expectedVersion: 4,
      ownerInstanceId: "worker",
    }, {
      db,
      processApi: {
        pauseProcessTree() { calls.push("pause"); return {}; },
      },
    }),
    /simulated compare-and-set/
  );
  assert.deepEqual(calls, []);
});

test("candidate artifact binds base, candidate, context, binary diff, and changed files", () => {
  const repository = temporaryDirectory("phase16-artifact-");
  git(repository, "init", "--quiet");
  git(repository, "config", "user.name", "Phase 16 Test");
  git(repository, "config", "user.email", "phase16@example.invalid");
  fs.writeFileSync(path.join(repository, "alpha.txt"), "base\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "--quiet", "-m", "base");
  const base = git(repository, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repository, "alpha.txt"), "candidate\n");
  fs.writeFileSync(path.join(repository, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  git(repository, "add", "alpha.txt", "binary.bin");
  git(repository, "commit", "--quiet", "-m", "candidate");
  const candidate = git(repository, "rev-parse", "HEAD");
  const context = `sha256:${"c".repeat(64)}`;
  const first = buildCandidateArtifact({
    repositoryRoot: repository,
    taskId: "TASK-PHASE16-ARTIFACT",
    baseCommitSha: base,
    candidateCommitSha: candidate,
    contextManifestHash: context,
  });
  const second = buildCandidateArtifact({
    repositoryRoot: repository,
    taskId: "TASK-PHASE16-ARTIFACT",
    baseCommitSha: base,
    candidateCommitSha: candidate,
    contextManifestHash: context,
  });
  assert.equal(first.artifactHash, second.artifactHash);
  assert.equal(first.manifest.baseCommitSha, base);
  assert.equal(first.manifest.candidateCommitSha, candidate);
  assert.equal(first.manifest.contextManifestHash, context);
  assert.deepEqual(first.files.map((file) => file.path), ["alpha.txt", "binary.bin"]);
  assert.deepEqual(first.manifest.summary, {
    changedFileCount: 2,
    additions: 1,
    deletions: 1,
    binaryFiles: 1,
    deletedFiles: 0,
  });
  assert.deepEqual(describeCandidateArtifact(first).riskSignals, ["CHANGES_BINARY_FILES"]);
  assert.match(first.diffHash, /^sha256:[0-9a-f]{64}$/);
  assert.throws(
    () => buildCandidateArtifact({
      repositoryRoot: repository,
      taskId: "TASK-PHASE16-ARTIFACT",
      baseCommitSha: candidate,
      candidateCommitSha: base,
      contextManifestHash: context,
    }),
    /not an ancestor/
  );
});

test("execution context hash changes with instruction, scope, and expected task version", () => {
  const input = {
    taskId: "TASK-PHASE16-CONTEXT",
    originalRequest: "Change the payment validator",
    plan: "Update code and tests",
    instruction: "Implement the approved plan",
    role: "coder",
    expectedTaskState: "CODING",
    expectedTaskVersion: 7,
    allowedPaths: ["test/payment/**", "src/payment/**"],
    allowedTools: ["npm-test", "codex"],
    riskLevel: "medium",
    constraints: { maxChangedFiles: 8, maxDiffLines: 300 },
  };
  const first = buildExecutionContextManifest(input);
  const reordered = buildExecutionContextManifest({
    ...input,
    allowedPaths: [...input.allowedPaths].reverse(),
    allowedTools: [...input.allowedTools].reverse(),
  });
  assert.equal(first.contextManifestHash, reordered.contextManifestHash);
  assert.notEqual(
    first.contextManifestHash,
    buildExecutionContextManifest({ ...input, expectedTaskVersion: 8 }).contextManifestHash
  );
  assert.notEqual(
    first.contextManifestHash,
    buildExecutionContextManifest({ ...input, allowedPaths: ["src/other/**"] }).contextManifestHash
  );
  assert.throws(
    () => buildExecutionContextManifest({ ...input, allowedPaths: ["../secrets/**"] }),
    /unsafe context path scope/
  );
});

test("approval presentation shows exact commits, hashes, paths, risk, expiry, and finalizer scope", () => {
  const output = formatBoundApproval({
    approvalId: 42,
    taskId: "TASK-42",
    status: "PENDING",
    artifactId: "artifact-42",
    artifactHash: `sha256:${"a".repeat(64)}`,
    contextManifestHash: `sha256:${"b".repeat(64)}`,
    diffHash: `sha256:${"c".repeat(64)}`,
    baseCommitSha: "1".repeat(40),
    candidateCommitSha: "2".repeat(40),
    changedPaths: ["src/a.js", "test/a.test.js"],
    summary: { changedFileCount: 2, additions: 10, deletions: 3, binaryFiles: 0, deletedFiles: 0 },
    riskSignals: ["LARGE_DIFF"],
    expectedTaskState: "PENDING_COMMIT_APPROVAL",
    expectedTaskVersion: 7,
    expiresAt: "2030-01-01T00:00:00.000Z",
    allowedActorIds: ["gate-admin"],
    allowedTargetRefs: ["refs/heads/main"],
  });
  for (const expected of [
    "approval #42", "artifact-42", "src/a.js", "test/a.test.js", "LARGE_DIFF",
    "PENDING_COMMIT_APPROVAL@7", "gate-admin", "refs/heads/main", "!approve 42",
  ]) assert.match(output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("candidate scope matcher rejects paths and diff size outside the approved context", () => {
  assert.equal(globPattern("src/**").test("src/nested/file.js"), true);
  const candidate = {
    files: [{ path: "src/a.js" }],
    manifest: { summary: { changedFileCount: 1, additions: 4, deletions: 1 } },
  };
  assert.equal(assertArtifactScope(candidate, {
    allowedPaths: ["src/**"],
    constraints: { maxChangedFiles: 2, maxDiffLines: 10 },
  }), true);
  assert.throws(
    () => assertArtifactScope({ ...candidate, files: [{ path: "outside.txt" }] }, { allowedPaths: ["src/**"] }),
    /outside the approved scope/
  );
  assert.throws(
    () => assertArtifactScope(candidate, { allowedPaths: ["src/**"], constraints: { maxDiffLines: 2 } }),
    /diff-line limit/
  );
  assert.throws(
    () => assertArtifactScope({ ...candidate, files: [{ path: "src/.env.production" }] }, { allowedPaths: ["src/**"] }),
    /sensitive paths/
  );
});

test("managed workspace and finalizer references reject escape forms", () => {
  const canonical = temporaryDirectory("phase16-canonical-");
  const isolation = temporaryDirectory("phase16-isolation-");
  fs.mkdirSync(path.join(isolation, "safe", "repository"), { recursive: true });
  const roots = ensureIsolationRoot(isolation, canonical);
  assert.equal(roots.realRoot, fs.realpathSync(isolation));
  assert.equal(
    assertManagedWorkspacePath(path.join(isolation, "safe", "repository"), isolation),
    fs.realpathSync(path.join(isolation, "safe", "repository"))
  );
  assert.throws(() => assertManagedWorkspacePath(canonical, isolation), /outside/);
  assert.equal(assertTargetRef("refs/heads/phase16/candidate"), "refs/heads/phase16/candidate");
  for (const ref of [
    "main", "refs/tags/v1", "refs/heads/../escape", "refs/heads/main/",
    "refs/heads/main.lock", "refs/heads/.hidden", "refs/heads/a//b", "refs/heads/a@{1}",
  ]) {
    assert.throws(() => assertTargetRef(ref), /unsafe target ref/);
  }
});

test("pause, resume, and kill target the entire local process group", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    assert.equal(processService.isProcessGroupAlive(child.pid), true);
    const paused = processService.pauseProcessTree({ pid: child.pid, pgid: child.pid });
    assert.equal(paused.usedProcessGroup, true);
    assert.equal(processService.isProcessGroupAlive(child.pid), true);
    const resumed = processService.resumeProcessTree({ pid: child.pid, pgid: child.pid });
    assert.equal(resumed.usedProcessGroup, true);
    const killed = await processService.killProcessTree({ pid: child.pid, pgid: child.pid, killGraceMs: 100 });
    assert.equal(killed.usedProcessGroup, true);
    assert.equal(killed.sigtermSent, true);
    assert.equal(processService.isProcessGroupAlive(child.pid), false);
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
});
