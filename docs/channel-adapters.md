# Channel adapters and credential storage

The runtime now enters through a channel adapter. Discord remains the first implementation, while future KakaoTalk, Slack, or other transports can implement the same lifecycle (`onReady`, `onMessage`, and `login`) without changing the queue, agent, approval, or governance services.

## Encrypted bot credentials

`016_channel_credentials` stores only AES-256-GCM ciphertext, nonce, authentication tag, and metadata in PostgreSQL. The master key is supplied at runtime through `CHANNEL_TOKEN_MASTER_KEY` as a 32-byte base64 or 64-character hex value. The master key and the plaintext token must never be committed or passed on command-line arguments.

Apply the table migration:

```bash
npm run migrate:channels
```

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
