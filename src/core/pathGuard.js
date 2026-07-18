const fs = require("fs");
const path = require("path");

// 프로젝트 루트 내부라도 무조건 차단하는 민감 파일 패턴 (23.9 .env 보안)
const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa$/,
  /^id_ed25519$/,
  /^\.aws$/,
  /^\.gcp$/,
  /^\.ssh$/,
  /^credentials$/,
];

// .env.example만 예외적으로 조회를 허용한다.
const SENSITIVE_EXCEPTIONS = [/^\.env\.example$/];

/**
 * 파일/디렉토리 basename이 민감 파일 패턴에 해당하는지 검사한다.
 * @param {string} targetPath
 */
function isSensitivePath(targetPath) {
  const base = path.basename(targetPath);
  if (SENSITIVE_EXCEPTIONS.some((re) => re.test(base))) {
    return false;
  }
  return SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(base));
}

/**
 * targetPath가 projectRoot(realpath 기준) 내부인지 검증한다.
 * - path.resolve + fs.realpathSync로 `../`, symlink를 통한 외부 경로 우회를 모두 해석한 뒤 비교한다.
 * - projectRoot 내부라도 민감 파일(.env, *.pem, id_rsa 등)이면 차단한다.
 * 통과 시 realpath로 정규화된 경로 문자열을 반환한다.
 * @param {string} targetPath 검증할 대상 경로 (상대/절대 모두 허용)
 * @param {string} [projectRoot] 기준 루트 경로. 생략 시 process.env.PROJECT_ROOT 사용.
 */
function assertInsideProjectRoot(targetPath, projectRoot = process.env.PROJECT_ROOT) {
  if (!projectRoot) {
    throw new Error("pathGuard: projectRoot가 지정되지 않았습니다 (PROJECT_ROOT 미설정).");
  }

  const realProjectRoot = fs.realpathSync(projectRoot);
  const resolvedPath = path.resolve(realProjectRoot, targetPath);
  const realTargetPath = fs.existsSync(resolvedPath)
    ? fs.realpathSync(resolvedPath)
    : resolvedPath;

  const isInside =
    realTargetPath === realProjectRoot || realTargetPath.startsWith(realProjectRoot + path.sep);

  if (!isInside) {
    throw new Error(`Blocked path outside PROJECT_ROOT: ${targetPath}`);
  }

  if (isSensitivePath(realTargetPath)) {
    throw new Error(`Blocked sensitive file access: ${targetPath}`);
  }

  return realTargetPath;
}

/**
 * 인자가 구조적으로 "파일 경로"처럼 보이는지 판단한다. (bare filename 우회 대응)
 * - 경로 접두사(/, ./, ../, ~)로 시작하면 경로로 본다.
 * - "/"를 포함하면 공백 포함 여부와 무관하게 경로로 본다. ("link dir/passwd" 같은
 *   공백 포함 symlink/디렉토리 경로로 검사를 우회하는 것을 막기 위함 - 공백이
 *   있다고 무조건 자연어로 취급하지 않는다.)
 * - 그 외에는 cwd 기준으로 실제 존재하는 파일/디렉토리면 공백 포함 여부와 무관하게
 *   경로로 본다. (예: "space name.txt" 같은 공백 포함 정상 파일명도 실존하면 경로로 취급)
 *
 * 이 함수는 공백이 있다는 이유만으로 자연어(에이전트 프롬프트 등)를 걸러내지 않는다.
 * 에이전트 런처(codex/claude/agy/ollama) 호출의 프롬프트 인자를 경로 검사에서 빼는 것은
 * 이 함수의 책임이 아니라 commandGuard.assertArgsSafe()에서 별도로 처리한다.
 * @param {string} token
 * @param {string} [cwd] 존재 여부 확인 기준 디렉토리
 */
function looksLikePath(token, cwd) {
  if (typeof token !== "string" || token.length === 0) return false;

  if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~")) {
    return true;
  }

  if (token.includes("/")) return true;

  if (!cwd) return false;
  try {
    return fs.existsSync(path.resolve(cwd, token));
  } catch (err) {
    return false;
  }
}

module.exports = {
  assertInsideProjectRoot,
  isSensitivePath,
  looksLikePath,
};
