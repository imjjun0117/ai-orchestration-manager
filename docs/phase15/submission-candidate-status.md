# Phase 15 Submission Candidate Status

- Candidate manifest: `submission-candidate.unsealed.json`
- Candidate round: `2` (validation rework)
- Canonical bundle hash: `sha256:6b2df959796ab94d265cb88df0fc847969422c02487fc89bd420632d4c80c723`
- State: `DRAFT_BLOCKED`
- Database submission row: not created
- Phase Gate state: not started
- Previous reviewed draft hash: `sha256:e47dc7df23b7bf05c1d6445411945fd4f492ec015e572408b42d062325072955` (stale; never reuse)

The worker resolved the planning/development implementation findings and generated a new round/hash. This candidate remains intentionally unsealed because the workspace has no authoritative Git metadata, so real base and candidate commit SHAs are unavailable. Real assigned validator principals and signed verdicts also do not exist yet.

`submission-candidate-status.md` is derived mutable status and is deliberately outside the canonical bundle. The immutable inputs are the candidate manifest, included code/docs, requirements trace, rollback plan, known-issues snapshot, and verification evidence.

Required external acceptance steps:

1. Place the final implementation in the authoritative Git repository.
2. Replace both unavailable commit fields with verified base/candidate commit IDs.
3. Bind four distinct bootstrap roles to real principals and credentials.
4. Rebuild every file/evidence hash and produce a new sealed manifest/hash.
5. Obtain new independent planning and development validation for that exact hash.
6. Preserve and sign both verdict artifacts.
7. Verify/import the bootstrap package and replay the self-hosted Gate.
8. Confirm one `BOOTSTRAP_ACCEPTED` event and one Phase 16 dependency activation.
