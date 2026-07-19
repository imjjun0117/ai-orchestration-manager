const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const { runSandboxed } = require("../../src/workspace/sandboxService");

const enabled = process.env.PHASE16_CONTAINER_TEST === "1";

if (!enabled) {
  test("Phase 16 container escape suite", { skip: "set PHASE16_CONTAINER_TEST=1 to run Docker tests" }, () => {});
} else {
  let workspace;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "phase16-container-"));
    fs.writeFileSync(path.join(workspace, "input.txt"), "isolated-input\n");
  });

  after(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  test("container denies network/root writes and enforces non-root resource policy", async () => {
    const probe = [
      "set -eu",
      "test \"$(id -u)\" != 0",
      "test \"$(cat /workspace/input.txt)\" = isolated-input",
      "echo workspace-write-ok > /workspace/output.txt",
      "if touch /phase16-host-escape 2>/dev/null; then exit 21; fi",
      "test ! -e /sys/class/net/eth0",
      "if command -v getent >/dev/null 2>&1 && getent hosts example.com >/dev/null 2>&1; then exit 22; fi",
      "test \"$(cat /sys/fs/cgroup/pids.max)\" -le 128",
      "memory_limit=$(cat /sys/fs/cgroup/memory.max)",
      "test \"$memory_limit\" != max",
      "test \"$memory_limit\" -le 1073741824",
      "printf 'container-policy-pass\\n'",
    ].join("\n");
    const result = await runSandboxed({
      workspacePath: workspace,
      command: "sh",
      args: ["-c", probe],
      backend: "container",
      image: process.env.PHASE16_TEST_CONTAINER_IMAGE || "postgres:16",
      timeoutMs: 30_000,
      memoryMb: 1024,
      cpus: 1,
      pidsLimit: 128,
    }, {
      db: { query: async () => ({ rows: [{ id: "phase-16", status: "ACCEPTED" }] }) },
      env: {
        ISOLATED_WORKSPACE_MODE: "true",
        CODER_WRITE_ENABLED: "true",
        ISOLATED_SANDBOX_BACKEND: "container",
      },
    });
    assert.match(result.stdout, /container-policy-pass/);
    assert.equal(fs.readFileSync(path.join(workspace, "output.txt"), "utf8"), "workspace-write-ok\n");
    assert.equal(result.policy.canonicalRepositoryMounted, false);
    assert.equal(result.policy.network, "DENY");
  });
}
