# Phase 18 Requirements Trace

| Requirement | Implementation | Verification |
|---|---|---|
| MEM-001 Long/Episodic/Short memory | `memory_sources.tier`, task Short entry, role context package | tier/retention unit test; DB ingestion suite |
| MEM-002 source versioning | `memory_source_versions`, immutable hash, SUPERSEDED tombstone, idempotent ingestion hash | same-input idempotency and update regression |
| MEM-003 ACL before retrieval | `memory_source_acl`, `retrieve_phase18_memory_candidates`, active role claim/project binding | cross-role/cross-project DB negative tests |
| MEM-004 hybrid retrieval and bounded rerank | PostgreSQL FTS lexical score + deterministic hashed embedding cosine + recency/tier rerank | deterministic ranking, token budget, candidate/selection bounds |
| MEM-005 content-addressed context manifest | `memory_context_manifests`, canonical JSON SHA-256 DB 재검증, active claim/task/role/mode binding, DB item/hash/token revalidation, replay API | golden hash, forged hash/binding rejection, replay, stale item availability tests |
| MEM-006 stale/conflict handling | source version events, `conflict_key` group reconciliation, conflicting-source retrieval exclusion | supersede/conflict/resolution evidence tests |
| MEM-007 prompt-injection isolation | deterministic rule IDs, data-only JSON frame, manifest raw-content rejection | adversarial memory unit/DB tests |
| MEM-008 episodic provenance and deletion | `memory_provenance_edges`, recursive source/derived deletion, retention purge | provenance cascade and expired-source erasure tests |
| MEM-009 shadow/fallback | `TIERED_MEMORY_MODE`, `memory_shadow_reports`, unchanged legacy prompt in shadow, safe fallback codes, enforced 시작 시 5개 역할의 실제 non-Short memory shadow 품질 재검증 | shadow/enforced/fallback unit tests; Short-only 거부 feature gate test |
| MEM-010 role execution binding | Phase 17 claim-bound retrieval/record APIs; Phase 16 context binds Phase 18 manifest hash | wrong-role/claim denial and context-hash tests |
| MEM-011 latency/backpressure/token bounds | timeout, per-process bounded limiter, SQL candidate cap, per-role token budget | timeout, queue saturation, token selection tests |
| MEM-012 operations and rollback | `phase18-memory.js`, separate source/index deletion, migration down/reapply | disposable DB rollback/reapply test |
| ADV-B tiered memory | memory plane schema, retrieval, manifest, shadow rollout | Phase 18 suites and dual-review Gate |
| DEL-001..013 delivery governance | Phase 15 self-hosted delivery control plane | immutable submission and independent planning/development validation |
