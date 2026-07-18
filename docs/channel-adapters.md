# Channel adapters and credential storage

The runtime now enters through a channel adapter. Discord remains the first implementation, while future KakaoTalk, Slack, or other transports can implement the same lifecycle (`onReady`, `onMessage`, and `login`) without changing the queue, agent, approval, or governance services.

## Encrypted bot credentials

`016_channel_credentials` stores only AES-256-GCM ciphertext, nonce, authentication tag, and metadata in PostgreSQL. The master key is supplied at runtime through `CHANNEL_TOKEN_MASTER_KEY` as a 32-byte base64 or 64-character hex value. The master key and the plaintext token must never be committed or passed on command-line arguments.

Apply the table migration:

```bash
npm run migrate:channels
```

For an interactive setup, configure the master key and run the guided command. The bot token is entered with terminal echo disabled:

```bash
export CHANNEL_TOKEN_MASTER_KEY='(secret-manager value)'
node scripts/channel-credentials.js setup
```

The wizard requires an interactive terminal, validates the master key before prompting, and asks for the channel and role/bot instance. If an ACTIVE credential already exists, it is preserved unless replacement is explicitly confirmed. A REVOKED credential is reactivated when the replacement token is stored. Piped or redirected input is rejected so automation cannot mistake an incomplete setup for success.

Import the token from the process environment without placing it in an argument or file tracked by Git:

```bash
CHANNEL_TOKEN_MASTER_KEY='(secret-manager value)' \
CHANNEL_TOKEN='(secret-manager value)' \
node scripts/channel-credentials.js store-env discord bot-a
```

Revoke a credential before rotating it, then import the replacement. Re-importing the same `(channel_type, bot_instance_id)` automatically reactivates the row:

```bash
node scripts/channel-credentials.js revoke discord bot-a
node scripts/channel-credentials.js store-env discord bot-a
```

For master-key rotation, provide the new key as `CHANNEL_TOKEN_MASTER_KEY`, keep the old key temporarily as `CHANNEL_TOKEN_MASTER_KEY_V<old-version>`, set `CHANNEL_TOKEN_MASTER_KEY_VERSION` to the new version, and run:

```bash
node scripts/channel-credentials.js rekey discord bot-a
```

Use `rekey --all` to re-encrypt every active channel credential during a master-key rotation:

```bash
node scripts/channel-credentials.js rekey --all
```

`store-env` accepts the channel-neutral `CHANNEL_TOKEN` first, then a channel-specific name such as `DISCORD_TOKEN`, `KAKAOTALK_TOKEN`, or `SLACK_TOKEN`. After import, omit the token from the runtime environment; `bot.js` falls back to the encrypted `channel_credentials` row for the Discord channel and bot instance.

For production, inject `CHANNEL_TOKEN_MASTER_KEY` from a secret manager and restrict database access to the runtime role. Never store the master key in the same database as the ciphertext.

## Role-specific bot instances

Running `node bot.js` in a terminal starts a guided launcher. It asks for one of the supported roles, generates and stores a local master key in `.env` with mode `0600` when approved and missing, and then reuses or replaces the role's encrypted DB credential before launching the bot. The token is entered without terminal echo.

For direct or unattended startup, select the credential with `--role`; the role maps to `bot_instance_id`:

```bash
node bot.js --role worker
node bot.js --role planning-validator
node bot.js --role development-validator
node bot.js --role gate-admin
```

Each role must have its own active credential when separate Discord applications are used. `--role` takes precedence over `BOT_INSTANCE_ID` and uses the encrypted DB credential instead of the legacy common `DISCORD_TOKEN`. `BOT_INSTANCE_ID` remains supported for unattended environments that do not pass `--role`.
