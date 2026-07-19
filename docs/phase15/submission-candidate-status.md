# Phase 15 Submission Candidate Status

- Candidate manifest: `submission-candidate.sealed.json`
- Pre-attestation draft: `submission-candidate.unsealed.json`
- Candidate validation cycle: `18` (final Bootstrap round mapping correction)
- Database submission round: `1` (no prior Phase 15 submission was imported)
- Canonical bundle hash: `sha256:52a5305e0e887acaa55b7b646d20cf7ada8a3c302546215d7809f479aaea61cc`
- Base commit: `c45c66107e6740c73a490eab5b015f6afbf0d3a1`
- Candidate commit: `7f67184d5eb5b375964403ca4c5145f9f4035b03`
- Submitted by: `phase15-worker-codex-01`
- State: `SEALED_PENDING_SIGNED_VALIDATION`
- Database submission row: not created
- Phase Gate state: not started
- Previous reviewed round-2 draft hash: `sha256:6b2df959796ab94d265cb88df0fc847969422c02487fc89bd420632d4c80c723` (stale; never reuse)
- Previous reviewed round-1 draft hash: `sha256:e47dc7df23b7bf05c1d6445411945fd4f492ec015e572408b42d062325072955` (stale; never reuse)

The worker resolved the Round 16 rollback, supervisor, traceability, and friendly-role findings. The bundled rollback now requires an explicit channel-credential preservation/deletion boundary; the four-role supervisor prefixes every child stream and fails fast on a degraded role; the trace/evidence reflects the current 29 pure and 19 DB integration passes. The manifest binds the immutable rework commit without self-reference. Validation-cycle numbering is operator history; `submissionRound` is `1` because the transactional database has never stored a Phase 15 submission. The earlier import attempt with validation cycle `17` incorrectly mapped to `submissionRound=17`, failed before commit, and left phase/actor/submission/event counts at zero. Prior hashes and signatures are stale and must not be reused. New signed verdicts for the hash above do not exist yet.

`submission-candidate-status.md` is derived mutable status and is deliberately outside the canonical bundle. The immutable inputs are the candidate manifest, included code/docs, requirements trace, rollback plan, known-issues snapshot, and verification evidence.

Required external acceptance steps:

1. Bind four distinct bootstrap roles to real principals and credentials.
2. Obtain new independent planning and development validation for the exact sealed hash.
3. Preserve and sign both verdict artifacts with separate Ed25519 keys.
4. Verify/import the bootstrap package and replay the self-hosted Gate.
5. Confirm one `BOOTSTRAP_ACCEPTED` event and one Phase 16 dependency activation.
