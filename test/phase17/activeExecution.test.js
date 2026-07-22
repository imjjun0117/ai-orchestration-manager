const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { executeQa } = require("../../src/controlPlane/roleExecutor");
const { preflight, validateExecutionTopology } = require("../../scripts/run-phase17-multibot");

const ROLES = ["manager", "planner", "coder", "reviewer", "qa", "summarizer"];

function configs({ mode = "shadow", executionMode = "dry-run" } = {}) {
  return ROLES.map((role) => ({
    role,
    instanceId: `${role}-01`,
    mode,
    executionMode,
    parsed: {
      ...(role === "manager" || role === "coder" || role === "qa" ? {
        ISOLATED_WORKSPACE_MODE: "true",
        CODER_WRITE_ENABLED: "true",
      } : {}),
      ...(role === "coder" || role === "qa" ? {
        ISOLATED_WORKSPACE_ROOT: "/private/isolated",
      } : {}),
      ...(role === "coder" ? {
        WORKSPACE_DIR: "/private/canonical.git",
        FINALIZER_ACTOR_ID: "manager-01",
        CANDIDATE_APPROVAL_TTL_MS: "86400000",
        FINALIZER_LEASE_TTL_MS: "86400000",
      } : {}),
      ...(role === "qa" ? {
        ISOLATED_SANDBOX_BACKEND: "container",
        SANDBOX_CONTAINER_IMAGE: "sha256:abcdef1234567890",
        QA_NPM_SCRIPT: "test:phase17",
      } : {}),
    },
  }));
}

function fakeFileSystem({ isolationMode = 0o40700 } = {}) {
  const realpathSync = (value) => value;
  realpathSync.native = realpathSync;
  return {
    realpathSync,
    statSync: (value) => ({
      isDirectory: () => ["/private/isolated", "/private/canonical.git"].includes(value),
      mode: value === "/private/isolated" ? isolationMode : 0o40700,
    }),
  };
}

test("active six-role topology requires enforced mode, a bare canonical repo, and a local QA image", () => {
  assert.deepEqual(validateExecutionTopology(configs()), { mode: "shadow", executionMode: "dry-run" });
  const active = configs({ mode: "enforced", executionMode: "active" });
  let inspected = null;
  const result = validateExecutionTopology(active, {
    fileSystem: fakeFileSystem(),
    gitIsBare: (repository) => repository === "/private/canonical.git",
    inspectImage: (image) => { inspected = image; return "sha256:local"; },
  });
  assert.equal(result.mode, "enforced");
  assert.equal(result.executionMode, "active");
  assert.equal(result.canonical, "/private/canonical.git");
  assert.equal(result.isolationRoot, "/private/isolated");
  assert.equal(result.finalizerActorId, "manager-01");
  assert.equal(inspected, "sha256:abcdef1234567890");
});

test("active topology fails closed for mixed modes and unsafe execution prerequisites", () => {
  const mixed = configs();
  mixed[0].mode = "enforced";
  assert.throws(() => validateExecutionTopology(mixed), /same MULTIBOT_ROLE_MODE/);
  assert.throws(
    () => validateExecutionTopology(configs({ mode: "enforced", executionMode: "dry-run" })),
    /requires ROLE_WORKER_EXECUTION=active/
  );
  assert.throws(
    () => validateExecutionTopology(configs({ mode: "shadow", executionMode: "active" })),
    /active requires MULTIBOT_ROLE_MODE=enforced/
  );

  const active = configs({ mode: "enforced", executionMode: "active" });
  assert.throws(
    () => validateExecutionTopology(active, {
      fileSystem: fakeFileSystem({ isolationMode: 0o40755 }),
      gitIsBare: () => true,
      inspectImage: () => "sha256:local",
    }),
    /permissions must be 0700/
  );
  assert.throws(
    () => validateExecutionTopology(active, {
      fileSystem: fakeFileSystem(),
      gitIsBare: () => false,
      inspectImage: () => "sha256:local",
    }),
    /bare canonical repository/
  );
  active.find(({ role }) => role === "qa").parsed.ISOLATED_SANDBOX_BACKEND = "native";
  assert.throws(
    () => validateExecutionTopology(active, {
      fileSystem: fakeFileSystem(),
      gitIsBare: () => true,
      inspectImage: () => "sha256:local",
    }),
    /ISOLATED_SANDBOX_BACKEND=container/
  );
});

test("six-role preflight rejects topology drift before opening a database pool", async () => {
  const mixed = configs();
  mixed[0].mode = "enforced";
  let poolConstructed = false;
  class UnexpectedPool {
    constructor() {
      poolConstructed = true;
      throw new Error("database pool must not be constructed");
    }
  }
  await assert.rejects(
    preflight(mixed, "postgres://operator.invalid/control", { PoolClass: UnexpectedPool }),
    /same MULTIBOT_ROLE_MODE/
  );
  assert.equal(poolConstructed, false);
});

test("active topology rejects an unavailable QA image and overlapping safety roots", () => {
  const active = configs({ mode: "enforced", executionMode: "active" });
  assert.throws(
    () => validateExecutionTopology(active, {
      fileSystem: fakeFileSystem(),
      gitIsBare: () => true,
      inspectImage: () => "",
    }),
    /image could not be verified locally/
  );

  const overlapping = configs({ mode: "enforced", executionMode: "active" });
  overlapping.find(({ role }) => role === "coder").parsed.WORKSPACE_DIR = "/private/isolated/canonical.git";
  const realpathSync = (value) => value;
  realpathSync.native = realpathSync;
  assert.throws(
    () => validateExecutionTopology(overlapping, {
      fileSystem: {
        realpathSync,
        statSync: (value) => ({ isDirectory: () => true, mode: value === "/private/isolated" ? 0o40700 : 0o40700 }),
      },
      gitIsBare: () => true,
      inspectImage: () => "sha256:local",
    }),
    /must not contain each other/
  );
});

test("active topology binds candidate finalization to the exact Manager and bounded TTLs", () => {
  const mismatchedActor = configs({ mode: "enforced", executionMode: "active" });
  mismatchedActor.find(({ role }) => role === "coder").parsed.FINALIZER_ACTOR_ID = "manager-other";
  assert.throws(
    () => validateExecutionTopology(mismatchedActor, {
      fileSystem: fakeFileSystem(), gitIsBare: () => true, inspectImage: () => "sha256:local",
    }),
    /must equal the active Manager/
  );

  const shortLease = configs({ mode: "enforced", executionMode: "active" });
  shortLease.find(({ role }) => role === "coder").parsed.FINALIZER_LEASE_TTL_MS = "60000";
  assert.throws(
    () => validateExecutionTopology(shortLease, {
      fileSystem: fakeFileSystem(), gitIsBare: () => true, inspectImage: () => "sha256:local",
    }),
    /approval TTL/
  );
});

test("QA build context excludes repository credentials and uses a fixed dependency image", () => {
  const fs = require("node:fs");
  const root = path.resolve(__dirname, "../..");
  const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8").trim().split(/\r?\n/);
  assert.deepEqual(dockerignore, [
    "*",
    "!.dockerignore",
    "!docker/",
    "!docker/phase17-qa.Dockerfile",
    "!package.json",
    "!package-lock.json",
  ]);
  const dockerfile = fs.readFileSync(path.join(root, "docker/phase17-qa.Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24\.14\.0-bookworm-slim$/m);
  assert.doesNotMatch(dockerfile, /:latest/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /NODE_PATH=\/opt\/ai-manager-dependencies\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./);
});

test("QA execution always uses the registered network-denied container sandbox", async () => {
  const calls = [];
  const database = {
    query: async (sql) => {
      assert.match(sql, /isolated_workspaces/);
      return { rows: [{ artifact_hash: "sha256:input", workspace_path: "/private/isolated/task/repository" }] };
    },
  };
  const job = { id: "job-qa", task_id: "task-qa", job_type: "TEST", input_artifact_id: "artifact-1" };
  const config = { role: "qa", instanceId: "qa-01" };
  const output = await executeQa(job, config, {
    db: database,
    env: {
      QA_NPM_SCRIPT: "  test:phase17  ",
      QA_TIMEOUT_MS: "120000",
      SANDBOX_CONTAINER_IMAGE: "sha256:abcdef1234567890",
    },
    runSandboxed: async (request, options) => {
      calls.push({ request, options });
      return {
        stdout: "all tests passed",
        policy: { backend: "container", network: "DENY", rootFilesystem: "READ_ONLY" },
      };
    },
    storeArtifact: async (artifact, options) => {
      calls.push({ artifact, options });
      return { id: "qa-output", artifact_hash: "sha256:output" };
    },
  });

  assert.deepEqual(calls[0].request, {
    taskId: "task-qa",
    agentName: "qa",
    workspacePath: path.resolve("/private/isolated/task/repository"),
    command: "npm",
    args: ["run", "test:phase17"],
    backend: "container",
    image: "sha256:abcdef1234567890",
    timeoutMs: 120000,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  assert.equal(calls[0].options.db, database);
  assert.deepEqual(calls[1].artifact.result.sandbox, {
    backend: "container",
    network: "DENY",
    rootFilesystem: "READ_ONLY",
  });
  assert.deepEqual(output, {
    outputArtifactId: "qa-output",
    result: { passed: true, artifactHash: "sha256:output" },
  });
});

test("QA sandbox failure never stores a successful output artifact", async () => {
  let stored = false;
  await assert.rejects(
    executeQa(
      { task_id: "task-qa", job_type: "TEST", input_artifact_id: "artifact-1" },
      { role: "qa", instanceId: "qa-01" },
      {
        db: { query: async () => ({ rows: [{ artifact_hash: "sha256:input", workspace_path: "/private/isolated/task" }] }) },
        env: { SANDBOX_CONTAINER_IMAGE: "sha256:abcdef1234567890" },
        runSandboxed: async () => { throw new Error("container policy rejected execution"); },
        storeArtifact: async () => { stored = true; },
      }
    ),
    /container policy rejected execution/
  );
  assert.equal(stored, false);
});
