# Phase 10 Multi-Bot Test Harness

Phase 10 is a reproduction harness, not the final multi-instance lock solution.
It lets two or more Discord bot processes connect to the same test Discord
channel, database, and workspace so race conditions can be observed before
Phase 11 adds DB-backed global locking.

## Environment Files

Create local env files from the examples:

- `.env.bot-a`
- `.env.bot-b`

Required keys:

- `DISCORD_TOKEN`: a distinct Discord bot token per process
- `BOT_INSTANCE_ID`: stable identifier such as `bot-a`
- `HOST_INSTANCE_ID`: stable host identifier shared by bot processes on the
  same machine, such as `local-dev`
- `COMMAND_PREFIX`: prefix used to address this bot, such as `!a`
- `DATABASE_URL`: shared test database
- `WORKSPACE_DIR`: shared temporary git workspace

Use a temporary workspace for stress testing. Do not point Phase 10 tests at a
production working tree.

## Run

```bash
npm run multibot -- .env.bot-a .env.bot-b
```

The harness prefixes stdout/stderr with each instance id:

```text
[bot-a] ...
[bot-b] ...
```

Each bot also writes an instance-specific app log by default:

- `logs/app.bot-a.log`
- `logs/app.bot-b.log`

## Discord Smoke Commands

With the example prefixes:

```text
!a instance
!b instance
!a ping
!b ping
```

The bot normalizes prefixed commands internally, so `!a task hello` runs the
same code path as `!task hello` inside the `bot-a` process.

## Collision Modes

Use different `COMMAND_PREFIX` values for targeted testing. Use the same
`COMMAND_PREFIX` intentionally when you want both bots to process the same
Discord command and reproduce duplicate event handling.

Known expected risks before Phase 11:

- Worker queues are still process-local.
- DB guards reduce some collisions but do not provide an atomic global
  workspace lock.
- A same-prefix command can be handled by multiple bot processes.
- PID ownership is not yet host/instance scoped beyond log and process env
  identification in older Phase 10-only runs. Phase 12 adds host-aware process
  ownership and process-group termination for task-bound CLI processes.
