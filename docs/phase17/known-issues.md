# Phase 17 Known Issues

1. Six role-specific bot profiles and DB principals are provisioned. Four migrated Discord accounts pass shadow login; the two local candidate tokens for QA and Summarizer were rejected by Discord and revoked, so two valid accounts remain required.
2. Actual six-account Discord expected-author-ID E2E and reconnect/rate-limit smoke tests remain pending. Forced process cleanup was exercised; login-failure registrations now compensate to OFFLINE.
3. `MULTIBOT_ROLE_MODE=enforced` is intentionally blocked until the Phase 17 delivery Gate is accepted. Shadow mode suppresses Discord publication.
4. Discord marker reconciliation scans at most 1,000 recent messages. If no unique author-bound marker is found, publication is sent to reconciliation rather than blindly acknowledged.

Items 1 and 2 block Phase 17 acceptance; they are not deferred debt.
