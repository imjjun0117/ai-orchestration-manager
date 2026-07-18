// 순수 FIFO 저장소. 실행(worker) 로직은 여기 두지 않고 src/queue/worker.js가 담당한다.
const queue = [];

/**
 * 큐 맨 뒤에 작업을 넣는다.
 * @param {{jobFn: () => Promise<any>, resolve: Function, reject: Function}} job
 * @returns {number} 이 작업을 넣기 "전"까지 큐에 쌓여 있던 작업 수 (0이면 바로 앞이 비어 있었다는 뜻)
 */
function push(job) {
  const waitingAhead = queue.length;
  queue.push(job);
  return waitingAhead;
}

/**
 * 큐 맨 앞의 작업을 꺼낸다. 비어 있으면 undefined.
 */
function shift() {
  return queue.shift();
}

/**
 * 현재 큐에 남아있는(아직 실행되지 않은) 작업 수.
 */
function size() {
  return queue.length;
}

module.exports = {
  push,
  shift,
  size,
};
