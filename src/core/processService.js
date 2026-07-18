function parsePid(pid) {
  const parsed = Number.parseInt(pid, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`유효하지 않은 PID입니다: ${pid}`);
  }
  return parsed;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") {
      return false;
    }
    throw err;
  }
}

function isProcessGroupAlive(pgid) {
  const normalizedPgid = parsePid(pgid);
  try {
    process.kill(-normalizedPgid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") {
      return false;
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcess(pid, { killGraceMs = 5000 } = {}) {
  const normalizedPid = parsePid(pid);

  if (!isProcessAlive(normalizedPid)) {
    return {
      pid: normalizedPid,
      alreadyExited: true,
      sigtermSent: false,
      sigkillSent: false,
    };
  }

  process.kill(normalizedPid, "SIGTERM");
  await sleep(killGraceMs);

  if (!isProcessAlive(normalizedPid)) {
    return {
      pid: normalizedPid,
      alreadyExited: false,
      sigtermSent: true,
      sigkillSent: false,
    };
  }

  process.kill(normalizedPid, "SIGKILL");
  return {
    pid: normalizedPid,
    alreadyExited: false,
    sigtermSent: true,
    sigkillSent: true,
  };
}

function signalTarget({ pid, pgid, signal }) {
  if (pgid && process.platform !== "win32") {
    const normalizedPgid = parsePid(pgid);
    process.kill(-normalizedPgid, signal);
    return { target: -normalizedPgid, usedProcessGroup: true };
  }
  const normalizedPid = parsePid(pid);
  process.kill(normalizedPid, signal);
  return { target: normalizedPid, usedProcessGroup: false };
}

function isTargetAlive({ pid, pgid }) {
  if (pgid && process.platform !== "win32") {
    return isProcessGroupAlive(pgid);
  }
  return isProcessAlive(pid);
}

async function killProcessTree({ pid, pgid = null, killGraceMs = 5000 } = {}) {
  const normalizedPid = parsePid(pid);
  const normalizedPgid = pgid ? parsePid(pgid) : null;

  if (!isTargetAlive({ pid: normalizedPid, pgid: normalizedPgid })) {
    return {
      pid: normalizedPid,
      pgid: normalizedPgid,
      alreadyExited: true,
      sigtermSent: false,
      sigkillSent: false,
      usedProcessGroup: Boolean(normalizedPgid && process.platform !== "win32"),
    };
  }

  const termTarget = signalTarget({ pid: normalizedPid, pgid: normalizedPgid, signal: "SIGTERM" });
  await sleep(killGraceMs);

  if (!isTargetAlive({ pid: normalizedPid, pgid: normalizedPgid })) {
    return {
      pid: normalizedPid,
      pgid: normalizedPgid,
      alreadyExited: false,
      sigtermSent: true,
      sigkillSent: false,
      usedProcessGroup: termTarget.usedProcessGroup,
    };
  }

  signalTarget({ pid: normalizedPid, pgid: normalizedPgid, signal: "SIGKILL" });
  return {
    pid: normalizedPid,
    pgid: normalizedPgid,
    alreadyExited: false,
    sigtermSent: true,
    sigkillSent: true,
    usedProcessGroup: termTarget.usedProcessGroup,
  };
}

module.exports = {
  isProcessAlive,
  isProcessGroupAlive,
  killProcess,
  killProcessTree,
  parsePid,
};
