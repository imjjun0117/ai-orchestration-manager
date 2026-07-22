const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULT_CLAUDE_MODEL, askClaude } = require("../../agents/claude");
const roleAudit = require("../../src/controlPlane/roleAuditService");
const commandGuard = require("../../src/core/commandGuard");
const { runCommand } = require("../../services/shell");

test("planner Claude invocation pins Opus 4.8 and preserves the prompt argv boundary", async () => {
  let invocation;
  const output = await askClaude("한국어 계획", {
    cwd: "/tmp",
    run: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: "정상 계획", stderr: "", durationMs: 1 };
    },
  });
  assert.equal(output, "정상 계획");
  assert.equal(DEFAULT_CLAUDE_MODEL, "claude-opus-4-8");
  assert.deepEqual(invocation.args.slice(0, 4), ["-p", "한국어 계획", "--model", "claude-opus-4-8"]);
  assert.equal(invocation.options.trusted, false);
});

test("Claude usage-credit text with exit code zero fails closed", async () => {
  await assert.rejects(
    askClaude("계획", {
      cwd: "/tmp",
      run: async () => ({
        stdout: "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
      }),
    }),
    (error) => error.code === "CLAUDE_PROVIDER_UNAVAILABLE" && !error.message.includes("Fable")
  );
  assert.equal(await askClaude("계획", {
    cwd: "/tmp",
    run: async () => ({ stdout: "정상 계획에서 'not logged in' 오류 문구를 설명합니다." }),
  }), "정상 계획에서 'not logged in' 오류 문구를 설명합니다.");
});

test("Claude nonzero execution and empty output are never converted to success", async () => {
  await assert.rejects(
    askClaude("계획", {
      cwd: "/tmp",
      run: async () => { throw { stdout: "partial", stderr: "rate limited", durationMs: 3 }; },
    }),
    (error) => error.code === "CLAUDE_EXECUTION_FAILED" && /rate limited/.test(error.message)
  );
  await assert.rejects(
    askClaude("계획", { cwd: "/tmp", run: async () => ({ stdout: "  " }) }),
    (error) => error.code === "CLAUDE_EMPTY_RESPONSE"
  );
});

test("role audit uses bounded APIs only inside the Phase 17 role runtime", async () => {
  const statements = [];
  const db = {
    async query(sql) {
      statements.push(sql);
      return { rows: [{ id: "skill-1", allowed_commands: [], blocked_commands: [] }] };
    },
  };
  await roleAudit.getTaskSkill("task-1", {
    db,
    env: { BOT_ROLE: "planner", BOT_INSTANCE_ID: "planner-01", MULTIBOT_ROLE_MODE: "enforced" },
  });
  await roleAudit.getTaskSkill("task-legacy", {
    db,
    env: { BOT_INSTANCE_ID: "legacy-bot" },
  });
  assert.match(statements[0], /get_phase17_task_skill/);
  assert.match(statements[1], /FROM tasks t JOIN skills/);
});

test("role audit rejects a PID ownership conflict instead of silently continuing", async () => {
  await assert.rejects(
    roleAudit.recordTaskProcess("task-1", { pid: 42, pgid: 42, hostId: "host" }, {
      db: { async query() { return { rows: [{ recorded: false }] }; } },
      env: { BOT_ROLE: "planner", BOT_INSTANCE_ID: "planner-01", MULTIBOT_ROLE_MODE: "enforced" },
    }),
    (error) => error.code === "TASK_PROCESS_OWNERSHIP_CONFLICT"
  );
});

test("shell terminates and fails a spawned child when Phase 17 PID ownership conflicts", async () => {
  const previous = {
    role: process.env.BOT_ROLE,
    instanceId: process.env.BOT_INSTANCE_ID,
    mode: process.env.MULTIBOT_ROLE_MODE,
    recordTaskProcess: roleAudit.recordTaskProcess,
    appendCommandLog: roleAudit.appendCommandLog,
  };
  process.env.BOT_ROLE = "planner";
  process.env.BOT_INSTANCE_ID = "planner-01";
  process.env.MULTIBOT_ROLE_MODE = "enforced";
  roleAudit.recordTaskProcess = async () => {
    const error = new Error("active owner conflict");
    error.code = "TASK_PROCESS_OWNERSHIP_CONFLICT";
    throw error;
  };
  roleAudit.appendCommandLog = async () => 1;
  try {
    await assert.rejects(
      runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        trusted: true,
        taskId: "task-conflict",
        agentName: "claude",
        killGraceMs: 100,
      }),
      (failure) => failure.error?.code === "TASK_PROCESS_OWNERSHIP_CONFLICT"
    );
  } finally {
    roleAudit.recordTaskProcess = previous.recordTaskProcess;
    roleAudit.appendCommandLog = previous.appendCommandLog;
    for (const [name, value] of [
      ["BOT_ROLE", previous.role],
      ["BOT_INSTANCE_ID", previous.instanceId],
      ["MULTIBOT_ROLE_MODE", previous.mode],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Phase 17 command guard fails closed when bounded skill lookup is unavailable", async () => {
  const previous = {
    role: process.env.BOT_ROLE,
    instanceId: process.env.BOT_INSTANCE_ID,
    mode: process.env.MULTIBOT_ROLE_MODE,
    getTaskSkill: roleAudit.getTaskSkill,
  };
  process.env.BOT_ROLE = "planner";
  process.env.BOT_INSTANCE_ID = "planner-01";
  process.env.MULTIBOT_ROLE_MODE = "enforced";
  roleAudit.getTaskSkill = async () => { throw new Error("bounded audit unavailable"); };
  try {
    await assert.rejects(
      commandGuard.assertCommandAllowed("claude", ["-p", "계획"], { taskId: "task-1", agentName: "claude" }),
      /bounded audit unavailable/
    );
  } finally {
    roleAudit.getTaskSkill = previous.getTaskSkill;
    for (const [name, value] of [
      ["BOT_ROLE", previous.role],
      ["BOT_INSTANCE_ID", previous.instanceId],
      ["MULTIBOT_ROLE_MODE", previous.mode],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
