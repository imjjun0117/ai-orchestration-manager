const fs = require("fs");
const path = require("path");
const { runCommand, extractErrorMessage } = require("../../services/shell");
const agentResultService = require("../core/agentResultService");

/**
 * 워크스페이스(cwd)에서 실행할 테스트 명령을 자동 감지한다.
 * package.json이 있으면 npm test, 없고 pom.xml이 있으면 mvn test.
 * 둘 다 없으면 null (QA 인프라가 없는 프로젝트를 막지 않기 위해 건너뛴다는 뜻).
 * @param {string} cwd
 * @returns {{command: string, args: string[]} | null}
 */
function detectTestCommand(cwd) {
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    return { command: "npm", args: ["test"] };
  }
  if (fs.existsSync(path.join(cwd, "pom.xml"))) {
    return { command: "mvn", args: ["test"] };
  }
  return null;
}

/**
 * commandGuard(assertCommandAllowed/assertArgsSafe)가 던지는 차단 에러는 spawn 자체를
 * 시도하기도 전에 던져지는 일반 Error라서 .stdout/.stderr 속성이 없다. spawn이 실제로
 * 실행돼서 실패한 경우(exit code!=0, ENOENT 등)는 runCommand가 항상 {error,stdout,stderr}
 * 형태로 reject한다(services/shell.js 참고). 이 차이로 "테스트 코드 문제로 실패한 것"과
 * "정책상 애초에 실행이 막힌 것"을 구분한다 - 후자는 Codex가 코드를 고쳐도 해결되지
 * 않는 문제이므로 QA 실패(무한 재수정 유발)가 아니라 건너뜀으로 취급해야 한다.
 */
function isCommandGuardBlock(err) {
  return err instanceof Error && err.stdout === undefined && err.stderr === undefined;
}

/**
 * 테스트 러너 실행 파일 자체가 설치돼 있지 않은 경우(spawn ENOENT)를 판별한다.
 * 이것도 commandGuard 차단과 동일하게 "코드를 고쳐도 해결되지 않는 문제"이므로
 * 실제 테스트 실패로 분류하면 안 된다 - 그렇게 분류하면 Codex 재수정 루프가
 * mvn/npm이 설치될 때까지 영원히 반복된다.
 * services/shell.js의 child.on("error", ...)는 { error, stdout:"", stderr:"" } 형태로
 * reject하므로(reject 형태 자체는 바꾸지 않는다), stdout/stderr가 존재해 isCommandGuardBlock
 * 으로는 걸러지지 않는다 - err.error.code === "ENOENT"를 우선 확인하고, 혹시
 * error 객체가 Error 인스턴스가 아니어서 .code를 못 읽는 예외적인 형태에 대비해
 * extractErrorMessage()의 "spawn <명령> ENOENT" 패턴도 폴백으로 확인한다. 테스트 자체가
 * 실행돼서 남긴 실패 메시지에 우연히 "ENOENT" 문자열이 섞여 있는 것만으로는(예:
 * 테스트가 자체적으로 어떤 파일을 못 찾아 ENOENT를 출력하는 경우) 오탐하지 않도록,
 * 정규식은 반드시 문자열 맨 앞에서 "spawn <명령어> ENOENT" 형태로만 매칭한다.
 */
function isSpawnEnoent(err) {
  if (err && err.error && err.error.code === "ENOENT") {
    return true;
  }
  return /^spawn \S+ ENOENT/.test(extractErrorMessage(err));
}

/**
 * QA(테스트 실행) 에이전트. 워크스페이스에서 감지된 테스트 명령을 실행하고 결과를
 * agent_results(result_type="qa_report")에 저장한다.
 *
 * 판정 결과는 세 가지다:
 * - skipped:true, passed:true - 테스트 설정이 없거나(package.json/pom.xml 둘 다 없음)
 *   skill의 allowed_commands 정책상 애초에 테스트 명령 실행이 막힌 경우. 코드 수정으로
 *   해결될 문제가 아니므로 재수정 루프를 유발하지 않고 통과로 간주한다.
 * - passed:true, skipped:false - 테스트가 실제로 실행되어 exit code 0으로 끝남.
 * - passed:false - 테스트가 실제로 실행되어 실패함(0이 아닌 exit code). 이 경우에만
 *   호출부가 Codex 재수정 루프를 트리거해야 한다.
 *
 * 테스트 실패 자체는 QA의 정상적인 판정 결과이므로 이 함수는 그로 인해 예외를
 * 던지지 않는다.
 * @param {object} task tasks 테이블 레코드 (id 사용)
 * @param {object} params
 * @param {string} params.cwd
 * @returns {Promise<{passed: boolean, skipped: boolean, output: string}>}
 */
async function runQaAgent(task, { cwd }) {
  const testCommand = detectTestCommand(cwd);

  if (!testCommand) {
    const message = "테스트 설정(package.json/pom.xml)을 찾지 못해 QA를 건너뛰었습니다.";
    await agentResultService.saveResult({
      taskId: task.id,
      agentName: "qa",
      resultType: "qa_report",
      content: message,
      modelName: null,
    });
    return { passed: true, skipped: true, output: message };
  }

  const commandLabel = `${testCommand.command} ${testCommand.args.join(" ")}`;

  try {
    const { stdout, stderr } = await runCommand(testCommand.command, testCommand.args, {
      cwd,
      taskId: task.id,
      agentName: "qa",
    });
    const output = [stdout, stderr].filter(Boolean).join("\n");
    await agentResultService.saveResult({
      taskId: task.id,
      agentName: "qa",
      resultType: "qa_report",
      content: `[${commandLabel}] PASS\n\n${output}`,
      modelName: null,
    });
    return { passed: true, skipped: false, output };
  } catch (err) {
    if (isCommandGuardBlock(err)) {
      const message = `테스트 명령(${commandLabel})이 보안 정책에 의해 차단되어 QA를 건너뛰었습니다: ${err.message}`;
      await agentResultService.saveResult({
        taskId: task.id,
        agentName: "qa",
        resultType: "qa_report",
        content: message,
        modelName: null,
      });
      return { passed: true, skipped: true, output: message };
    }

    if (isSpawnEnoent(err)) {
      const message = `테스트 러너(${testCommand.command})가 설치되어 있지 않아 QA를 건너뛰었습니다: ${extractErrorMessage(err)}`;
      await agentResultService.saveResult({
        taskId: task.id,
        agentName: "qa",
        resultType: "qa_report",
        content: message,
        modelName: null,
      });
      return { passed: true, skipped: true, output: message };
    }

    const output = extractErrorMessage(err);
    await agentResultService.saveResult({
      taskId: task.id,
      agentName: "qa",
      resultType: "qa_report",
      content: `[${commandLabel}] FAIL\n\n${output}`,
      modelName: null,
    });
    return { passed: false, skipped: false, output };
  }
}

module.exports = {
  detectTestCommand,
  runQaAgent,
};
