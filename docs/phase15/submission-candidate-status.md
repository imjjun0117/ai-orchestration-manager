# Phase 15 Submission Candidate Status

- Candidate manifest: `submission-candidate.unsealed.json`
- Candidate round: `3` (Git binding and rollback-runbook closure)
- Current unsealed draft hash: `sha256:4b3a74baf80b30722b71c8b1ec3b564079ed863d008a4a1b16369c838c16ef9a`
- State: `GIT_BOUND_REBUILD_PENDING`
- Database submission row: not created
- Phase Gate state: not started
- Previous reviewed round-2 draft hash: `sha256:6b2df959796ab94d265cb88df0fc847969422c02487fc89bd420632d4c80c723` (stale; never reuse)
- Previous reviewed round-1 draft hash: `sha256:e47dc7df23b7bf05c1d6445411945fd4f492ec015e572408b42d062325072955` (stale; never reuse)

The worker resolved the planning/development implementation findings and established the authoritative Git repository. The prior draft hash remains useful only as prevalidation evidence. A final candidate commit and separate sealed manifest attestation are being generated; real assigned validator principals and signed verdicts do not exist yet.

`submission-candidate-status.md` is derived mutable status and is deliberately outside the canonical bundle. The immutable inputs are the candidate manifest, included code/docs, requirements trace, rollback plan, known-issues snapshot, and verification evidence.

Required external acceptance steps:

1. Commit and push the final documentation-only governance update.
2. Bind the sealed manifest to the verified base/candidate commit IDs.
3. Bind four distinct bootstrap roles to real principals and credentials.
4. Rebuild every file/evidence hash and produce a new sealed manifest/hash.
5. Obtain new independent planning and development validation for that exact hash.
6. Preserve and sign both verdict artifacts.
7. Verify/import the bootstrap package and replay the self-hosted Gate.
8. Confirm one `BOOTSTRAP_ACCEPTED` event and one Phase 16 dependency activation.
