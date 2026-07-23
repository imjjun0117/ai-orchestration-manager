# Phase 17 Known Issues

1. Phase 17 Gate는 `ACCEPTED`이고 현재 `MULTIBOT_ROLE_MODE=enforced`로 운영됩니다. 신규 control-plane 변경은 여전히 shadow 검증 후 전환해야 합니다.
2. Discord marker reconciliation scans at most 1,000 recent messages. If no unique author-bound marker is found, publication is sent to reconciliation rather than blindly acknowledged.
3. Gateway reconnect and REST rate-limit smoke cannot replace production monitoring for lower-level packet loss or a prolonged Discord outage. A failed smoke may also require later exact-message cleanup after Discord recovers.
4. Planner 실행은 `claude-opus-4-8`로 고정된다. 사용량 또는 인증 오류가 나면 작업은 실패로 기록되며 승인 후보로 승격되지 않는다. 공급자 사용 가능 상태를 복구한 뒤 재시도해야 한다.

The generalized operator recovery blocker is closed by migration `020_phase17_operator_reconciliation`: unresolved role jobs and outbox events now have revision-fenced `RETRY`/`DEAD_LETTER` decisions, idempotent request IDs, and append-only audit evidence. All six accounts pass simultaneous Shadow login, two-round expected-author-ID smoke, exact-process `SIGKILL` restart, Gateway Resume, and Discord REST rate-limit recovery.
