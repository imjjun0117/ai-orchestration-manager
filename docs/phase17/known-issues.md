# Phase 17 Known Issues

1. `MULTIBOT_ROLE_MODE=enforced` is intentionally blocked until the Phase 17 delivery Gate is accepted. Shadow mode suppresses Discord publication.
2. Discord marker reconciliation scans at most 1,000 recent messages. If no unique author-bound marker is found, publication is sent to reconciliation rather than blindly acknowledged.
3. Gateway reconnect and REST rate-limit smoke cannot replace production monitoring for lower-level packet loss or a prolonged Discord outage. A failed smoke may also require later exact-message cleanup after Discord recovers.

The generalized operator recovery blocker is closed by migration `020_phase17_operator_reconciliation`: unresolved role jobs and outbox events now have revision-fenced `RETRY`/`DEAD_LETTER` decisions, idempotent request IDs, and append-only audit evidence. All six accounts pass simultaneous Shadow login, two-round expected-author-ID smoke, exact-process `SIGKILL` restart, Gateway Resume, and Discord REST rate-limit recovery.
