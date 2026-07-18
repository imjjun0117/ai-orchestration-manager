const { runCommand } = require("./shell");

// git.js의 모든 호출은 코드에 고정된 명령이며, !approve/!reject 승인 절차로
// 이미 보호되므로 commandGuard의 allow/blocklist 검사를 건너뛴다 (trusted: true).

// untracked 파일마다 `git diff --no-index` 프로세스를 하나씩 띄우므로, 파일 수가
// 너무 많으면(수십~수백 개) 순차 spawn이 과도하게 느려질 수 있다. 이 개수를 넘으면
// 개별 diff 생성을 생략하고 파일 목록 요약만 제공한다.
const MAX_UNTRACKED_DIFF_FILES = 50;

/**
 * Git 상태를 가져옵니다.
 * @param {string} cwd 대상 저장소 디렉토리
 */
async function getStatus(cwd) {
  const { stdout } = await runCommand("git", ["status"], { cwd, trusted: true });
  return stdout;
}

// C 스타일 단일 문자 escape (git quote.c의 quote_c_style 참고)
const SINGLE_CHAR_ESCAPES = {
  '"': 0x22,
  "\\": 0x5c,
  n: 0x0a,
  t: 0x09,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  r: 0x0d,
  v: 0x0b,
};

/**
 * git status --porcelain의 경로가 공백/특수문자/비ASCII 포함으로 큰따옴표에 감싸져
 * C 스타일로 quoting되어 나올 때 원래 경로 문자열로 복원한다.
 * - `\"`, `\\`, `\n`, `\t` 등 단일 문자 escape를 처리한다.
 * - `\NNN` (3자리 8진수) escape도 처리한다. 이건 원본 파일명의 raw byte 하나를
 *   나타내므로(예: 한글 등 비ASCII 파일명은 UTF-8 byte별로 8진수 escape가 연달아 나옴),
 *   문자 단위가 아니라 byte 배열로 모았다가 마지막에 한 번에 UTF-8로 디코딩해야 한다.
 *   (문자 단위로 처리하면 멀티바이트 UTF-8 문자가 깨진다.)
 * @param {string} raw
 */
function unquoteGitPath(raw) {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }

  const inner = raw.slice(1, -1);
  const bytes = [];

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (ch === "\\") {
      const octal = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        i += 3;
        continue;
      }

      const next = inner[i + 1];
      if (Object.prototype.hasOwnProperty.call(SINGLE_CHAR_ESCAPES, next)) {
        bytes.push(SINGLE_CHAR_ESCAPES[next]);
        i += 1;
        continue;
      }

      // 알 수 없는 escape 시퀀스는 백슬래시 자체를 보존한다.
      bytes.push(0x5c);
      continue;
    }

    // 일반 문자는 UTF-8 byte(들)로 변환해 그대로 누적한다.
    for (const b of Buffer.from(ch, "utf8")) {
      bytes.push(b);
    }
  }

  return Buffer.from(bytes).toString("utf8");
}

/**
 * 아직 git이 추적하지 않는(untracked) 파일 경로 목록을 가져온다.
 * --untracked-files=all을 써서 새 디렉토리도 "dir/" 한 줄로 뭉개지지 않고 내부 파일까지 전부 나열한다.
 * @param {string} cwd
 */
async function listUntrackedFiles(cwd) {
  const { stdout } = await runCommand(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd, trusted: true }
  );
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => unquoteGitPath(line.slice(3).trim()))
    .filter(Boolean);
}

/**
 * Git Diff 결과를 가져옵니다. 이미 추적 중인 파일의 변경은 물론, 아직 git add된 적 없는
 * 신규(untracked) 파일도 "새 파일 diff" 형태로 포함한다 (git diff는 기본적으로 untracked
 * 파일을 절대 보여주지 않으므로, Codex가 새 파일만 생성한 경우 변경이 없는 것으로
 * 오판하지 않도록 별도로 합친다). git add -N . 같은 인덱스 조작은 하지 않으므로
 * !reject의 git checkout . / git clean -fd 롤백 동작에는 영향이 없다.
 * @param {string} cwd 대상 저장소 디렉토리
 */
async function getDiff(cwd) {
  const { stdout: trackedDiff } = await runCommand("git", ["diff"], { cwd, trusted: true });

  const untrackedFiles = await listUntrackedFiles(cwd);

  if (untrackedFiles.length === 0) {
    return trackedDiff;
  }

  // untracked 파일이 너무 많으면(MAX_UNTRACKED_DIFF_FILES 초과) 파일마다 프로세스를
  // 띄우는 대신 목록 요약만 제공한다. 이 경우에도 반환값이 절대 빈 문자열이 되지
  // 않도록 해서, "변경 없음"으로 오판되어 협업이 취소되는 일이 없게 한다.
  if (untrackedFiles.length > MAX_UNTRACKED_DIFF_FILES) {
    const preview = untrackedFiles
      .slice(0, MAX_UNTRACKED_DIFF_FILES)
      .map((file) => `  - ${file}`)
      .join("\n");
    const remaining = untrackedFiles.length - MAX_UNTRACKED_DIFF_FILES;
    const summary =
      `[알림] untracked 파일이 ${untrackedFiles.length}개로 많아 개별 diff 생성을 생략합니다 ` +
      `(최대 ${MAX_UNTRACKED_DIFF_FILES}개까지만 표시).\n` +
      `새로 생성된 파일 목록:\n${preview}` +
      (remaining > 0 ? `\n  ... 외 ${remaining}개` : "");
    return [trackedDiff, summary].filter(Boolean).join("\n");
  }

  const untrackedDiffs = [];

  for (const file of untrackedFiles) {
    try {
      // 차이가 있으면(신규 파일이므로 항상 있음) exit code 1이라 runCommand가 reject한다.
      // 이 경우 stdout에는 정상적인 unified diff 결과가 들어있다.
      const { stdout } = await runCommand(
        "git",
        ["diff", "--no-index", "--", "/dev/null", file],
        { cwd, trusted: true }
      );
      if (stdout) untrackedDiffs.push(stdout);
    } catch (err) {
      if (err.stdout) {
        untrackedDiffs.push(err.stdout);
      }
    }
  }

  return [trackedDiff, ...untrackedDiffs].filter(Boolean).join("\n");
}

/**
 * 현재 HEAD 커밋 해시를 가져옵니다. (승인되지 않은 커밋 발생 여부 감지용)
 * @param {string} cwd 대상 저장소 디렉토리
 */
async function getHeadHash(cwd) {
  try {
    const { stdout } = await runCommand("git", ["rev-parse", "HEAD"], { cwd, trusted: true });
    return stdout.trim();
  } catch (err) {
    return null;
  }
}

/**
 * 변경사항을 추가하고 커밋합니다.
 * @param {string} commitMessage 커밋 메시지
 * @param {string} cwd 대상 저장소 디렉토리
 */
async function addAndCommit(commitMessage, cwd) {
  // spawn(shell:false)으로 실행되므로 commitMessage는 이스케이프 없이 단일 argv로 전달된다.
  await runCommand("git", ["add", "."], { cwd, trusted: true });
  const { stdout } = await runCommand("git", ["commit", "-m", commitMessage], { cwd, trusted: true });
  return stdout;
}

/**
 * 모든 로컬 변경사항을 되돌립니다.
 * @param {string} cwd 대상 저장소 디렉토리
 */
async function discardChanges(cwd) {
  await runCommand("git", ["checkout", "."], { cwd, trusted: true });
  await runCommand("git", ["clean", "-fd"], { cwd, trusted: true });
}

module.exports = {
  getStatus,
  getDiff,
  getHeadHash,
  addAndCommit,
  discardChanges,
};
