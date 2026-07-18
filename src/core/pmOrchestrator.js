const fs = require("fs");
const path = require("path");
const logger = require("../../services/logger");
const git = require("../../services/git");
const taskService = require("./taskService");
const taskLogService = require("./taskLogService");
const agentResultService = require("./agentResultService");
const approvalService = require("./approvalService");
const contextBuilder = require("./contextBuilder");
const roleResolver = require("./roleResolver");
const qaAgent = require("../agents/qaAgent");

const MANAGER_PROMPT_PATH = path.join(__dirname, "../../prompts/manager.md");
const DEFAULT_MAX_REVISION_ROUNDS = 3;
const AUTO_LOOP_STATUSES = new Set(["RECEIVED", "PM_PLANNING", "AUTONOMOUS_EXECUTION"]);

function resultText(result) {
  return String((result && (result.text || result.stdout)) || "");
}

function resultError(result) {
  return String((result && (result.raw && (result.raw.stderr || result.raw.errorMessage))) || result.stderr || "");
}

function isResultFailure(result) {
  return !result || result.exitCode !== 0 || result.timedOut || result.killed;
}

function extractJsonObject(text) {
  const value = String(text || "").trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : value;

  try {
    return JSON.parse(candidate);
  } catch (_) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("PM 판단 JSON을 찾을 수 없습니다.");
  }
}

function normalizeDecision(decision) {
  const action = String(decision.action || "").trim().toLowerCase();
  if (!["revise", "qa", "complete", "escalate"].includes(action)) {
    throw new Error(`지원하지 않는 PM action입니다: ${decision.action}`);
  }
  return {
    action,
    reason: String(decision.reason || "").trim() || "(사유 없음)",
    instruction: String(decision.instruction || "").trim(),
  };
}

function buildPmDecisionPrompt({ task, phase, plan, coderOutput, reviewerOutput, qaOutput, round, maxRounds }) {
  return (
    `너는 AI Manager의 PM 오케스트레이터다. 반드시 JSON 객체 하나만 출력한다.\n` +
    `허용 action: "revise", "qa", "complete", "escalate".\n` +
    `- reviewer 판단 후에는 qa 또는 revise 또는 escalate 중 하나를 선택한다.\n` +
    `- qa 판단 후에는 complete 또는 revise 또는 escalate 중 하나를 선택한다.\n` +
    `- revise를 선택하면 coder에게 줄 instruction을 구체적으로 작성한다.\n` +
    `- 판단 불가, 모순, 최대 라운드 도달이면 escalate를 선택한다.\n\n` +
    `출력 스키마:\n` +
    `{"action":"qa|revise|complete|escalate","reason":"...","instruction":"..."}\n\n` +
    `[Task]\n${task.id}: ${task.original_request}\n\n` +
    `[Phase]\n${phase}\n\n` +
    `[Round]\n${round}/${maxRounds}\n\n` +
    `[Plan]\n${plan || "(없음)"}\n\n` +
    `[Coder Output]\n${coderOutput || "(없음)"}\n\n` +
    `[Reviewer Output]\n${reviewerOutput || "(없음)"}\n\n` +
    `[QA Output]\n${qaOutput || "(없음)"}`
  );
}

async function append(task, params, context) {
  return taskLogService.appendTaskMessage(task, {
    discordMessageId: null,
    authorId: null,
    client: context.client,
    fallbackChannel: context.fallbackChannel,
    ...params,
  });
}

async function latestResultContent(taskId, resultType) {
  const result = await agentResultService.getLatestResultByType(taskId, resultType);
  return result ? result.content : "";
}

async function pauseIfRequested(task, context, fallbackFromStatus = null) {
  const latest = await taskService.getTask(task.id);
  if (!latest) {
    return null;
  }
  if (latest.status === "PAUSED") {
    return latest;
  }
  if (!latest.pause_requested) {
    return null;
  }

  const fromStatus = fallbackFromStatus || latest.status;
  const paused = await taskService.pauseTask(latest.id, fromStatus);
  const pausedTask = paused || { ...latest, status: "PAUSED", paused_from_status: fromStatus };
  await append(pausedTask, {
    authorName: "PM Orchestrator",
    role: "system",
    content: `일시중지 체크포인트 도달. 상태를 PAUSED로 전환했습니다. 재개: \`!resume ${latest.id}\``,
  }, context);
  if (context.fallbackChannel && typeof context.fallbackChannel.send === "function") {
    await context.fallbackChannel.send(`⏸️ **${latest.id}** 일시중지 완료. 나중에 \`!resume ${latest.id}\`로 재개할 수 있습니다.`);
  }
  return pausedTask;
}

async function invokeRole(task, role, prompt, context, resultType) {
  const binding = await roleResolver.resolveAgent(role);
  await append(task, {
    authorName: "PM Orchestrator",
    role: "system",
    content: `${role}(${binding.agentName}) 호출 시작`,
  }, context);

  const startedAt = Date.now();
  const result = await binding.adapter.invoke(prompt, {
    workspaceDir: context.cwd,
    cwd: context.cwd,
    taskId: task.id,
    role,
  });
  const durationMs = result && typeof result.durationMs === "number" ? result.durationMs : Date.now() - startedAt;
  const text = resultText(result) || resultError(result) || "(출력 없음)";

  await agentResultService.saveResult({
    taskId: task.id,
    agentName: role,
    resultType: isResultFailure(result) ? "error" : resultType,
    content: text,
    modelName: binding.agentName,
  });

  await append(task, {
    authorName: `${role} (${binding.agentName})`,
    role,
    content: `${role} 호출 완료 (${durationMs}ms, exit=${result ? result.exitCode : "unknown"})\n\n${text}`,
  }, context);

  return { binding, result, text };
}

function noteFailure(streak, agentName, failed) {
  if (!failed) {
    if (streak.agentName === agentName) {
      streak.count = 0;
    }
    return false;
  }
  if (streak.agentName === agentName) {
    streak.count += 1;
  } else {
    streak.agentName = agentName;
    streak.count = 1;
  }
  return streak.count >= 2;
}

async function escalate(task, reason, context) {
  const updated = await taskService.updateTask(task.id, {
    status: "PM_ESCALATION",
    current_agent: "pm",
    next_action: "human_input",
  });
  const content = `PM_ESCALATION: ${reason}`;
  await append(updated || task, {
    authorName: "PM Orchestrator",
    role: "pm",
    content,
  }, context);
  if (context.fallbackChannel && typeof context.fallbackChannel.send === "function") {
    await context.fallbackChannel.send(`⚠️ **${task.id}** 자동 루프가 사람 판단을 요청합니다.\n${reason}`);
  }
  return updated || task;
}

async function requestPmDecision(task, payload, context) {
  const prompt = buildPmDecisionPrompt({ task, ...payload });
  const pmDecision = await invokeRole(task, "pm", prompt, context, "decision");
  if (isResultFailure(pmDecision.result)) {
    throw new Error(`PM 판단 호출 실패: ${resultError(pmDecision.result) || pmDecision.text}`);
  }
  return normalizeDecision(extractJsonObject(pmDecision.text));
}

async function runAutoLoop(task, {
  client,
  fallbackChannel,
  cwd,
  maxRevisionRounds = DEFAULT_MAX_REVISION_ROUNDS,
} = {}) {
  const context = { client, fallbackChannel, cwd };
  let currentTask = await taskService.getTask(task.id) || task;
  const failureStreak = { agentName: null, count: 0 };

  if (currentTask.status === "PAUSED") {
    logger.info(`[PMOrchestrator] task=${currentTask.id} 이미 PAUSED 상태라 자동 루프를 시작하지 않음`);
    return currentTask;
  }
  if (!AUTO_LOOP_STATUSES.has(currentTask.status)) {
    logger.info(`[PMOrchestrator] task=${currentTask.id} 자동 루프 대상 상태가 아님: ${currentTask.status}`);
    return currentTask;
  }

  let paused = await pauseIfRequested(currentTask, context, currentTask.status);
  if (paused) return paused;

  let plan = currentTask.plan || "";
  if (!(currentTask.status === "AUTONOMOUS_EXECUTION" && plan)) {
    currentTask = await taskService.updateTask(currentTask.id, {
      status: "PM_PLANNING",
      current_agent: "pm",
      round: currentTask.round || 0,
      next_action: null,
    }) || currentTask;

    paused = await pauseIfRequested(currentTask, context, "PM_PLANNING");
    if (paused) return paused;

    const systemPrompt = fs.existsSync(MANAGER_PROMPT_PATH) ? fs.readFileSync(MANAGER_PROMPT_PATH, "utf8") : "";
    const planPrompt = contextBuilder.buildPlannerContext({
      taskPrompt: currentTask.original_request,
      systemPrompt,
    });
    const planRun = await invokeRole(currentTask, "pm", planPrompt, context, "plan");
    if (noteFailure(failureStreak, "pm", isResultFailure(planRun.result))) {
      return escalate(currentTask, "PM planning이 2회 연속 실패했습니다.", context);
    }
    if (isResultFailure(planRun.result)) {
      return escalate(currentTask, `PM planning 실패: ${resultError(planRun.result) || planRun.text}`, context);
    }

    plan = planRun.text;
    currentTask = await taskService.updateTask(currentTask.id, {
      plan,
      status: "AUTONOMOUS_EXECUTION",
      current_agent: "coder",
      round: 0,
    }) || currentTask;

    paused = await pauseIfRequested(currentTask, context, "AUTONOMOUS_EXECUTION");
    if (paused) return paused;
  }

  let round = Number(currentTask.round || 0);
  let nextAgent = currentTask.current_agent || "coder";
  let coderInstruction =
    `PM 계획과 task 대화 맥락을 바탕으로 요구사항을 구현해줘.\n\n[PM Plan]\n${plan}`;
  let coderOutput = "";
  let reviewerOutput = "";
  let qaOutput = "";

  while (round <= maxRevisionRounds) {
    paused = await pauseIfRequested(currentTask, context, "AUTONOMOUS_EXECUTION");
    if (paused) return paused;

    if (nextAgent === "pm") {
      nextAgent = plan ? "coder" : "pm";
    }

    if (nextAgent === "coder") {
      currentTask = await taskService.updateTask(currentTask.id, {
        status: "AUTONOMOUS_EXECUTION",
        current_agent: "coder",
        round,
        next_action: null,
      }) || currentTask;

      paused = await pauseIfRequested(currentTask, context, "AUTONOMOUS_EXECUTION");
      if (paused) return paused;

      const coderPrompt = await contextBuilder.buildCoderContext(currentTask, {
        instruction: coderInstruction,
        cwd,
      });
      const coderRun = await invokeRole(currentTask, "coder", coderPrompt, context, "code_diff");
      if (noteFailure(failureStreak, "coder", isResultFailure(coderRun.result))) {
        return escalate(currentTask, "coder가 2회 연속 실패했습니다.", context);
      }
      if (isResultFailure(coderRun.result)) {
        round += 1;
        if (round > maxRevisionRounds) {
          return escalate(currentTask, "coder 실패 후 최대 수정 라운드에 도달했습니다.", context);
        }
        coderInstruction = `이전 coder 호출이 실패했습니다. 오류를 반영해 다시 시도해줘.\n\n${resultError(coderRun.result) || coderRun.text}`;
        continue;
      }
      coderOutput = coderRun.text;
      currentTask = await taskService.updateTask(currentTask.id, {
        current_agent: "reviewer",
        round,
      }) || currentTask;
      nextAgent = "reviewer";

      paused = await pauseIfRequested(currentTask, context, "AUTONOMOUS_EXECUTION");
      if (paused) return paused;
    }

    if (nextAgent === "reviewer") {
      coderOutput = coderOutput || await latestResultContent(currentTask.id, "code_diff");
      const diff = await git.getDiff(cwd);
      currentTask = await taskService.updateTask(currentTask.id, { current_agent: "reviewer" }) || currentTask;
      const reviewerPrompt = await contextBuilder.buildReviewerContext(currentTask, {
        diff,
        instruction:
          '사용자 목적에 비추어 설계 결함, 로직 오류, 보안 취약점이 없는지 리뷰해줘. 수정이 필요하다면 구체적인 개선 지침을 남기고, 문제가 없다면 명확히 "문제 없음"이라고 밝혀줘.',
        cwd,
      });
      const reviewerRun = await invokeRole(currentTask, "reviewer", reviewerPrompt, context, "review");
      if (noteFailure(failureStreak, "reviewer", isResultFailure(reviewerRun.result))) {
        return escalate(currentTask, "reviewer가 2회 연속 실패했습니다.", context);
      }
      if (isResultFailure(reviewerRun.result)) {
        return escalate(currentTask, `reviewer 실패: ${resultError(reviewerRun.result) || reviewerRun.text}`, context);
      }
      reviewerOutput = reviewerRun.text;
      currentTask = await taskService.updateTask(currentTask.id, {
        current_agent: "pm_review",
      }) || currentTask;
      nextAgent = "pm_review";

      paused = await pauseIfRequested(currentTask, context, "AUTONOMOUS_EXECUTION");
      if (paused) return paused;
    }

    if (nextAgent === "pm_review") {
      coderOutput = coderOutput || await latestResultContent(currentTask.id, "code_diff");
      reviewerOutput = reviewerOutput || await latestResultContent(currentTask.id, "review");
      let decision;
      try {
        decision = await requestPmDecision(currentTask, {
          phase: "reviewer_result",
          plan,
          coderOutput,
          reviewerOutput,
          round,
          maxRounds: maxRevisionRounds,
        }, context);
      } catch (err) {
        logger.error("PM reviewer 판단 파싱 실패", err);
        return escalate(currentTask, err.message, context);
      }

      await append(currentTask, {
        authorName: "PM Orchestrator",
        role: "pm",
        content: `PM 판단: ${decision.action}\n사유: ${decision.reason}`,
      }, context);

      if (decision.action === "escalate") {
        return escalate(currentTask, decision.reason, context);
      }
      if (decision.action === "revise") {
        round += 1;
        if (round > maxRevisionRounds) {
          return escalate(currentTask, "PM이 재수정을 요청했지만 최대 수정 라운드에 도달했습니다.", context);
        }
        coderInstruction = decision.instruction || `Reviewer 피드백을 반영해 재수정해줘.\n\n${reviewerOutput}`;
        currentTask = await taskService.updateTask(currentTask.id, {
          current_agent: "coder",
          round,
        }) || currentTask;
        nextAgent = "coder";
        continue;
      }

      currentTask = await taskService.updateTask(currentTask.id, { current_agent: "qa" }) || currentTask;
      nextAgent = "qa";

      paused = await pauseIfRequested(currentTask, context, "AUTONOMOUS_EXECUTION");
      if (paused) return paused;
    }

    if (nextAgent === "qa") {
      currentTask = await taskService.updateTask(currentTask.id, { current_agent: "qa" }) || currentTask;
      await append(currentTask, {
        authorName: "PM Orchestrator",
        role: "system",
        content: "qa 호출 시작",
      }, context);
      const qaResult = await qaAgent.runQaAgent(currentTask, { cwd });
      qaOutput = qaResult.output || "";
      await append(currentTask, {
        authorName: "qa",
        role: "qa",
        content:
          `qa 완료 (passed=${qaResult.passed}, skipped=${qaResult.skipped})\n\n` +
          (qaResult.output || "(출력 없음)"),
      }, context);

      if (!qaResult.passed) {
        round += 1;
        if (round > maxRevisionRounds) {
          return escalate(currentTask, "QA 실패 후 최대 수정 라운드에 도달했습니다.", context);
        }
        coderInstruction =
          `QA 실패를 수정해줘. 아래 테스트 실패 로그를 근거로 코드를 고쳐줘.\n\n${qaResult.output}`;
        currentTask = await taskService.updateTask(currentTask.id, {
          current_agent: "coder",
          round,
        }) || currentTask;
        nextAgent = "coder";
        continue;
      }

      currentTask = await taskService.updateTask(currentTask.id, { current_agent: "pm_qa" }) || currentTask;
      nextAgent = "pm_qa";

      paused = await pauseIfRequested(currentTask, context, "AUTONOMOUS_EXECUTION");
      if (paused) return paused;
    }

    if (nextAgent === "pm_qa") {
      coderOutput = coderOutput || await latestResultContent(currentTask.id, "code_diff");
      reviewerOutput = reviewerOutput || await latestResultContent(currentTask.id, "review");
      qaOutput = qaOutput || await latestResultContent(currentTask.id, "qa_report");
      let qaDecision;
      try {
        qaDecision = await requestPmDecision(currentTask, {
          phase: "qa_result",
          plan,
          coderOutput,
          reviewerOutput,
          qaOutput,
          round,
          maxRounds: maxRevisionRounds,
        }, context);
      } catch (err) {
        logger.error("PM QA 판단 파싱 실패", err);
        return escalate(currentTask, err.message, context);
      }

      if (qaDecision.action === "escalate") {
        return escalate(currentTask, qaDecision.reason, context);
      }
      if (qaDecision.action === "revise") {
        round += 1;
        if (round > maxRevisionRounds) {
          return escalate(currentTask, "PM이 QA 이후 재수정을 요청했지만 최대 수정 라운드에 도달했습니다.", context);
        }
        coderInstruction = qaDecision.instruction || "QA 결과와 리뷰 결과를 반영해 재수정해줘.";
        currentTask = await taskService.updateTask(currentTask.id, {
          current_agent: "coder",
          round,
        }) || currentTask;
        nextAgent = "coder";
        continue;
      }

      currentTask = await taskService.updateTask(currentTask.id, { current_agent: "summarizer" }) || currentTask;
      nextAgent = "summarizer";

      paused = await pauseIfRequested(currentTask, context, "AUTONOMOUS_EXECUTION");
      if (paused) return paused;
    }

    if (nextAgent === "summarizer") {
      reviewerOutput = reviewerOutput || await latestResultContent(currentTask.id, "review");
      qaOutput = qaOutput || await latestResultContent(currentTask.id, "qa_report");
      currentTask = await taskService.updateTask(currentTask.id, { current_agent: "summarizer" }) || currentTask;
      const summaryPrompt =
        `다음 task의 최종 승인 요청 요약을 한국어로 작성해줘.\n` +
        `변경 요약, 검증 결과, 운영자가 !approve 전에 확인할 포인트를 포함해줘.\n\n` +
        `[Task]\n${currentTask.original_request}\n\n[Plan]\n${plan}\n\n[Review]\n${reviewerOutput}\n\n[QA]\n${qaOutput}`;
      const summaryRun = await invokeRole(currentTask, "summarizer", summaryPrompt, context, "summary");
      if (noteFailure(failureStreak, "summarizer", isResultFailure(summaryRun.result))) {
        return escalate(currentTask, "summarizer가 2회 연속 실패했습니다.", context);
      }
      if (isResultFailure(summaryRun.result)) {
        return escalate(currentTask, `summarizer 실패: ${resultError(summaryRun.result) || summaryRun.text}`, context);
      }

      currentTask = await taskService.updateTask(currentTask.id, {
        status: "PENDING_FINAL_APPROVAL",
        current_agent: "pm",
        next_action: "final_approval",
        round,
      }) || currentTask;
      await approvalService.openApproval(currentTask.id, "final_approval", "pm");

      await append(currentTask, {
        authorName: "PM Orchestrator",
        role: "pm",
        content: `자동 루프 완료. 최종 승인 대기 상태로 전환했습니다.\n\n${summaryRun.text}`,
      }, context);

      if (fallbackChannel && typeof fallbackChannel.send === "function") {
        await fallbackChannel.send(
          `✅ **${currentTask.id}** 자동 파이프라인이 완료되어 최종 승인 대기 상태입니다.\n` +
          "`!log " + currentTask.id + "` 로 전체 흐름을 확인한 뒤 `!approve`로 커밋하거나 `!reject`로 롤백하세요."
        );
      }

      return currentTask;
    }

    logger.error(`[PMOrchestrator] 알 수 없는 current_agent=${nextAgent}, coder 단계로 복구: ${currentTask.id}`);
    nextAgent = "coder";
  }

  return escalate(currentTask, "자동 루프가 최대 수정 라운드를 초과했습니다.", context);
}

module.exports = {
  DEFAULT_MAX_REVISION_ROUNDS,
  runAutoLoop,
  _internal: {
    extractJsonObject,
    normalizeDecision,
    buildPmDecisionPrompt,
  },
};
