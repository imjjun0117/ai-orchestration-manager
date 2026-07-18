# Phase 13 Local Stress Harness

Phase 13 adds a repeatable local stress harness for the multi-bot safety layers
introduced in Phases 11 and 12. It does not connect to Discord and does not run
Claude/Codex/Gemini/Gemma. It exercises the shared Postgres lock and local
process ownership paths directly.

## Run

```bash
npm run stress:locks -- --workers 8
```

Requirements:

- `DATABASE_URL` points to a database with `src/db/schema.sql` applied.
- The script can create temporary directories under the OS temp directory.
- No Discord token is required.

Useful options:

```bash
npm run stress:locks -- --workers 16
npm run stress:locks -- --workspace /tmp/ai-manager-phase13-workspace
npm run stress:locks -- --skip-process-smoke
```

## What It Checks

- Concurrent lock acquisition: multiple child Node processes target the same
  workspace at the same time; exactly one may acquire the lock and all others
  must receive `WorkspaceLockBusyError`.
- Path canonicalization: `/tmp/x`, `/tmp/x/`, `/tmp/./x`, and an available
  symlink alias are expected to normalize to one `workspace_key`.
- Owner safety: wrong host, wrong instance, or wrong PID cannot heartbeat or
  release another owner's lock.
- TTL takeover: an expired lock can be acquired by a new owner.
- Process ownership smoke: a task-bound local command records `current_pid`,
  `current_pgid`, `current_host_id`, and `current_owner_instance_id` while it is
  running, then clears those fields after exit.

## Scope

This harness is meant to catch regressions before running real multi-bot Discord
tests. It does not prove Discord gateway ordering, token permissions, or real
agent CLI behavior. Use it together with:

```bash
npm run multibot -- .env.bot-a .env.bot-b
```
