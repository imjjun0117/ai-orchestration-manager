# Phase 15 Submission Candidate Status

- Candidate manifest: `submission-candidate.sealed.json`
- Pre-attestation draft: `submission-candidate.unsealed.json`
- Candidate round: `3` (Git binding and rollback-runbook closure)
- Canonical bundle hash: `sha256:1db055c76547fc9c6ee4540e3b6ce63a3c180c7ccb18a2a25652e38181e3eec3`
- Base commit: `c45c66107e6740c73a490eab5b015f6afbf0d3a1`
- Candidate commit: `d7693a8103041cd482c9de81b9dd86b3fac71432`
- Submitted by: `phase15-worker-codex-01`
- State: `SEALED_PENDING_SIGNED_VALIDATION`
- Database submission row: not created
- Phase Gate state: not started
- Previous reviewed round-2 draft hash: `sha256:6b2df959796ab94d265cb88df0fc847969422c02487fc89bd420632d4c80c723` (stale; never reuse)
- Previous reviewed round-1 draft hash: `sha256:e47dc7df23b7bf05c1d6445411945fd4f492ec015e572408b42d062325072955` (stale; never reuse)

The worker resolved the planning/development implementation findings, established the authoritative Git repository, and generated a separate sealed manifest attestation that binds the immutable candidate commit without self-reference. Prior draft hashes remain useful only as prevalidation evidence. Real assigned validator principals and signed verdicts for the canonical hash above do not exist yet.

`submission-candidate-status.md` is derived mutable status and is deliberately outside the canonical bundle. The immutable inputs are the candidate manifest, included code/docs, requirements trace, rollback plan, known-issues snapshot, and verification evidence.

Required external acceptance steps:

1. Bind four distinct bootstrap roles to real principals and credentials.
2. Obtain new independent planning and development validation for the exact sealed hash.
3. Preserve and sign both verdict artifacts with separate Ed25519 keys.
4. Verify/import the bootstrap package and replay the self-hosted Gate.
5. Confirm one `BOOTSTRAP_ACCEPTED` event and one Phase 16 dependency activation.
