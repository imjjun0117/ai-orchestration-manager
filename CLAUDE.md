# Claude Code Project Guidelines - AI Manager

## Project Overview
This is a Discord-based Local AI Manager designed to control multi-agent pipelines (Claude, Codex, Gemini, Gemma) running locally on macOS.

## Environment & Commands
- **Startup Bot:** `node bot.js`
- **Verify Status:** `!status` or `!test`
- **Dependency Install:** `npm install`
- **Runtime:** Node.js (CommonJS, `require`)

## Code Style & Architecture
- **Module System:** Always use CommonJS modules (`require` / `module.exports`), do NOT use ES Modules (`import`).
- **Asynchronous Code:** Prefer `async/await` over raw Promises or callbacks.
- **CLI Integrations:** When executing CLI commands non-interactively in shell services, always:
  - Redirect stdin using `< /dev/null` to prevent blocking.
  - Bypass interactive prompts using flags (e.g. `--permission-mode dontAsk` for Claude, `--ask-for-approval never` and `--skip-git-repo-check` for Codex, `--dangerously-skip-permissions` for Antigravity).
- **Error Handling:** Wrap shell command executions in try/catch and always check both `stdout` and `stderr`.
- **Git Safety:** Never commit or push without explicit user approval. Avoid modifying `.env` or tracking credentials.
