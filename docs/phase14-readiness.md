# Phase 14 Readiness Verification

Phase 14 packages the recurring verification steps into commands that can be run
before local multi-bot testing or deployment.

## Static Readiness

```bash
npm run verify
```

This checks:

- JavaScript syntax for app-owned files under `bot.js`, `agents/`, `services/`,
  `src/`, and `scripts/`
- required package scripts
- multi-bot example env files
- schema coverage for Phase 5-13 tables, columns, indexes, and role seed rows
- operator docs

No Discord token or database connection is required.

## Live Database Readiness

```bash
npm run verify:db
```

This adds live Postgres checks:

- required tables and columns exist
- role bindings are seeded as expected

Run `src/db/schema.sql` against the target database before this command.

## Stress Readiness

```bash
npm run verify:stress
```

This runs the live DB checks plus the Phase 13 workspace-lock stress harness.
It does not connect to Discord and does not invoke agent CLIs.

## Real Multi-Bot Smoke

After the automated readiness commands pass, start two test bots:

```bash
npm run multibot -- .env.bot-a .env.bot-b
```

In Discord:

```text
!a instance
!b instance
!a lock
!b lock
```

Then start a long-running task from one bot and confirm the other bot receives a
workspace-lock busy response for workspace-changing commands.
