---
name: agy-claude-delivery-cycle
description: Use for repository implementation work that must follow a Codex-owned, dual-review delivery cycle. Codex plans, implements, tests, and revises; Claude Code model fable independently verifies development correctness; Antigravity (agy) independently verifies planning and requirement coverage; Codex applies verified findings and resubmits the work until both reviewers pass or a genuine blocker remains. Trigger for features, fixes, refactors, tests, migrations, configuration, and implementation-related documentation changes.
---

# Codex Dual-Review Delivery Cycle

Run every command from the repository root. Keep Codex as the sole implementer and orchestrator. Use Claude Fable only for development verification and Antigravity only for planning verification. Do not allow either reviewer to edit files. Keep their first-pass reviews independent by giving each the same raw task artifacts without the other reviewer's conclusions.

## 0. Preflight

Verify `agy` and `claude` are installed and Claude is authenticated. Confirm that model `fable` and the command flags used below are available from current CLI help without exposing tokens or account details. If a CLI fails only because the execution sandbox blocks a required local port, keychain, or log path, request the minimum escalation and retry. Never substitute another reviewer or use a dangerous bypass flag silently.

## 1. Baseline and Codex work

Capture `git status --short`, `git diff`, and `git diff --cached` before editing. Record pre-existing changes and baseline test failures. Preserve out-of-scope content; when an in-scope file already contains user changes, keep its existing hunks intact.

Have Codex translate the request into requirements, acceptance criteria, a concise implementation plan, and validation commands. Then have Codex implement the change directly and run relevant tests and diagnostics. Claude and Antigravity must not perform this implementation.

## 2. Build the review packet

Prepare the same evidence for both reviewers:

- Original user request and clarified constraints
- Codex plan and acceptance criteria
- Baseline `HEAD`, working-tree state, and known pre-existing failures
- Changed-file list and relevant diff
- Current review-round number
- Validation commands, exit statuses, and key output from the current diff
- Known uncertainties and residual risks

Avoid secrets and excessive output. Provide exact relevant failure lines and file references when needed. If the packet could exceed a reviewer's context, split it by component and include a coverage manifest so no requirement, file, or test disappears silently. Keep evidence in the conversation when practical instead of creating persistent workflow artifacts.

## 3. Claude Fable development verification

Invoke Claude Code non-interactively with `claude --model fable --print --permission-mode plan --allowedTools "<minimum scoped inspection tools>" "<development-review prompt containing the packet>" < /dev/null`. Do not allow `Edit` or `Write`. Allow narrowly scoped non-destructive test commands only when independent reproduction is safe and materially useful. Ask Claude to verify implementation correctness, regressions, error handling, security, compatibility, maintainability, and test coverage against the review packet and repository state. Explicitly forbid edits, commits, pushes, and implementation work.

Require a structured result containing:

- Verdict: `PASS`, `CHANGES_REQUIRED`, or `BLOCKED`
- Findings ordered by severity, each with file/line, evidence, impact, and required correction
- Missing or weak tests
- Residual risks

Allow `N/A` with a one-line justification when a result section does not apply. Treat vague preferences as non-blocking. Require concrete evidence for every blocking finding.

## 4. Antigravity planning verification

Invoke Antigravity non-interactively and read-only with `agy --sandbox --print-timeout 5m -p "<planning-review prompt containing the packet>" < /dev/null`. Put the review packet directly in the prompt so Antigravity does not need command permission to inspect files. Ask it to verify that Codex's plan and delivered change cover the original request, acceptance criteria, scope, dependencies, sequencing, edge cases, rollout or migration needs, and validation strategy. Explicitly forbid tools, file edits, and implementation work.

Require the same verdict values and evidence standard as the Claude review. Allow `N/A` with justification; limit missing-test findings to tests implied by requirements or acceptance criteria. Ask for requirement-to-plan and requirement-to-change gaps, unnecessary scope, missing validation, and planning risks.

## 5. Codex adjudication and revision

Have Codex independently check every reviewer finding against the request, repository, diff, and test evidence. Do not accept a finding merely because a reviewer produced it. Record each finding as accepted, rejected, or deferred. When rejecting a finding, quote its relevant evidence and provide concrete counterevidence so self-adjudication remains auditable.

Have Codex directly implement all accepted corrections, update the plan or acceptance criteria when Antigravity identifies a valid planning gap, and rerun relevant validation. Never send implementation work to Claude or Antigravity.

## 6. Revalidation loop

After every Codex revision, rerun relevant tests, rebuild the review packet, and submit it again to both reviewers without leaking one reviewer's conclusions to the other. Give each reviewer its own prior findings and Codex's dispositions so it can confirm resolution, but never give it the other reviewer's report. Require fresh verdicts on the current state.

If a reviewer times out, returns meta-chat, or violates the required schema, retry it once with a shorter packet and sharper format instruction. If the retry still fails, mark that reviewer `BLOCKED` and stop the cycle with the captured evidence.

Repeat adjudication, Codex revision, tests, and dual revalidation until:

- Both latest reviewer verdicts are `PASS` and Codex's own requirements and checks pass; or
- A genuine blocker, conflicting requirement, missing authority, unavailable dependency, or verifier failure requires user input.

Cap the cycle at five total dual-review rounds. If the same material finding remains unresolved for three revision rounds, stop earlier. Treat either limit as `BLOCKED`, not success, and report both latest verdicts plus the unresolved evidence. When the reviewers conflict, have Codex resolve the conflict with repository evidence; ask the user only when the decision materially changes scope or intent.

## Safety

Never stash, reset, discard user changes, alter secrets, run destructive commands, commit, or push without explicit authorization. Keep verifier permissions read-only. Do not use `--dangerously-skip-permissions` for either reviewer.

## Final report

Report the final status, Codex's change summary, both latest reviewer verdicts, accepted and rejected findings, revision rounds, validation commands and results, residual risks or blockers, and changed files. Confirm that Codex performed all implementation and revisions and that no commit or push occurred unless the user explicitly authorized it.
