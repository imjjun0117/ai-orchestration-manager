const taskQueue = require("./taskQueue");
const logger = require("../../services/logger");

// 이 프로세스 안에서 큐를 소비하는 백그라운드 루프가 이미 돌고 있는지 여부.
// Node는 싱글 스레드라 이 플래그의 체크-후-설정 사이에 다른 코드가 끼어들 수 없으므로
// 별도 락 없이도 "동시에 두 개의 소비 루프가 도는" 경우가 생기지 않는다.
let isRunning = false;

const DEFAULT_WATCHDOG_MS = 10 * 60 * 1000;

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveWatchdogMs(explicitWatchdogMs) {
  if (explicitWatchdogMs !== undefined && explicitWatchdogMs !== null) {
    return parsePositiveInt(explicitWatchdogMs);
  }
  return parsePositiveInt(process.env.WORKER_WATCHDOG_MS) || DEFAULT_WATCHDOG_MS;
}

/**
 * 에이전트 CLI 호출처럼 시간이 오래 걸리고, 같은 워크스페이스(git 저장소)를 공유하는
 * 작업을 큐에 등록한다. 큐는 항상 한 번에 하나씩만 실행되도록 직렬화하므로, 여러
 * 사용자의 요청이 거의 동시에 들어와도 Codex/Claude/Gemini/Gemma 프로세스가 같은
 * 작업 트리를 동시에 건드리는 경합이 생기지 않는다.
 *
 * @param {() => Promise<any>} jobFn 실제로 실행할 비동기 작업 (예: () => askCodex(prompt, options))
 * @param {object} [options]
 * @param {(waitingAhead: number) => void} [options.onQueued] 이 작업이 실제로 시작되기까지
 *   앞서 처리돼야 하는 작업 수(큐에 쌓인 것 + 지금 한창 실행 중인 것 포함)를 알려주는 콜백.
 *   0이면 바로 실행된다는 뜻이라 보통 별도 안내가 필요 없다.
 * @param {string} [options.label] watchdog 로그에 표시할 작업 이름
 * @param {number} [options.watchdogMs] 이 시간 이상 실행되면 경고만 남긴다. 작업을 죽이지 않는다.
 * @param {(info: {label: string, elapsedMs: number}) => void} [options.onWatchdog]
 * @returns {Promise<any>} jobFn의 실행 결과(또는 예외)를 그대로 전달하는 Promise
 */
function enqueue(jobFn, { onQueued, label = "worker job", watchdogMs = null, onWatchdog = null } = {}) {
  return new Promise((resolve, reject) => {
    // taskQueue에 쌓여 있는 것뿐 아니라, "지금 한창 실행 중이라 이미 큐 밖으로 나간" 작업까지
    // 합쳐야 실제로 몇 개를 더 기다려야 하는지가 정확하다 (isRunning만 true고 큐가 비어 있는
    // 상태 - 즉 직전 작업이 실행 중인 상태 - 를 반영하지 않으면 "0개 대기"로 잘못 안내된다).
    const waitingAhead = taskQueue.size() + (isRunning ? 1 : 0);
    taskQueue.push({ jobFn, resolve, reject, label, watchdogMs, onWatchdog });
    if (onQueued) {
      try {
        onQueued(waitingAhead);
      } catch (err) {
        logger.error("worker: onQueued 콜백 실행 실패", err);
      }
    }
    processNext();
  });
}

/**
 * 큐를 처음부터 끝까지(다른 소비 루프가 없을 때만) 순차적으로 비운다.
 * 작업 하나가 실패해도(reject) 나머지 작업 처리는 계속 진행된다 - 워커 자체가
 * 죽지 않는다.
 */
async function processNext() {
  if (isRunning) return;
  isRunning = true;

  try {
    let job;
    while ((job = taskQueue.shift())) {
      const startedAt = Date.now();
      const resolvedWatchdogMs = resolveWatchdogMs(job.watchdogMs);
      let watchdogTimer = null;
      if (resolvedWatchdogMs) {
        watchdogTimer = setTimeout(() => {
          const elapsedMs = Date.now() - startedAt;
          logger.error(`[worker] watchdog 경고: ${job.label} ${elapsedMs}ms 이상 실행 중`);
          if (typeof job.onWatchdog === "function") {
            try {
              job.onWatchdog({ label: job.label, elapsedMs });
            } catch (err) {
              logger.error("worker: onWatchdog 콜백 실행 실패", err);
            }
          }
        }, resolvedWatchdogMs);
      }
      try {
        const result = await job.jobFn();
        job.resolve(result);
      } catch (err) {
        job.reject(err);
      } finally {
        if (watchdogTimer) clearTimeout(watchdogTimer);
      }
    }
  } finally {
    isRunning = false;
  }
}

/**
 * 현재 대기 중인(아직 실행 시작 안 한) 작업 수. Discord 상태 표시 등에 쓸 수 있다.
 */
function getQueueLength() {
  return taskQueue.size();
}

module.exports = {
  enqueue,
  getQueueLength,
  _internal: {
    DEFAULT_WATCHDOG_MS,
    resolveWatchdogMs,
  },
};
