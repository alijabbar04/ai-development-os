# ADR 0029: Stage 18 operator-authorized fixed-subject audit

Status: Accepted

Date: 2026-08-14

## Context

The published Stage 18 completeness candidate correctly froze commit
`f5372fece6371385e15b6cbb2edd2f4063c7eac3`, tree
`9f5a842192bb9317127cc4b57af5fbf50d0d36dc`, all 16 matrix rows, all ten
ADR 0016 specialist concerns, and exact requirement-task-result edges. Its
trusted evaluation configuration intentionally authorized nothing, so every
evidence instance was rejected before its deterministic status could matter.

The operator subsequently authorized one exact overlay digest, one exact
criterion-manifest digest, and the 16 exact candidate evidence-instance
digests derived from that frozen subject. The authorization explicitly grants
no criterion outcome, waiver, execution authority, production admission, or
model-independence claim.

Two semantic boundaries remain load-bearing:

1. `PLN-02` describes the existence of the completeness audit itself. Requiring
   its already-proven status inside the subject under audit would be circular.
2. `PRD-01` requires production to remain unavailable until Stage 17W evidence
   exists. Its exact `production-gated` state is the required fail-closed
   behavior and is not a development-acceptance failure, even though the
   frozen generic evidence rule records only literal `proven` rows as
   satisfied.

## Decision

### Exact external input authorization

The repository records a finite operator-authorization packet containing:

- the exact external prompt byte count and SHA-256;
- repository identity;
- frozen head, tree, subject, and overlay digests;
- the exact criterion-manifest digest;
- the ordered criterion/evidence identity and digest list;
- zero waiver digests;
- exact nonclaims; and
- a canonical packet digest.

The packet truthfully says that the chat transport is not cryptographically
authenticated by repository code. That limitation does not become a forged
signature. The Stage 19 evaluation contract accepts externally configured
exact digest allowlists, so the packet supplies only those allowlists. It is
not criterion evidence and cannot authorize itself.

### Phase A: immutable subject evaluation

The deterministic evaluation continues to read every matrix and artifact blob
from the frozen subject commit, never from the moving feature branch. The
operator packet authorizes the exact manifest and all 16 exact evidence
instances. It authorizes no waiver.

The resulting official evaluation remains `rejected`: the 12 frozen `proven`
rows pass, while `ANT-02`, `AM-02`, `PLN-02`, and `PRD-01` retain failed
deterministic status evidence. The manifest itself is authorized, so there is
no manifest-authorization finding. The completeness audit remains permanently
non-authorizing.

### Phase B: later bootstrap evidence

Phase A cannot consume its own result. Only after the exact result is committed,
published, independently reviewed within the stated limitations, and bound to
exact-head CI may that external result become evidence for `PLN-02` in a later
subject. Such a later promotion cannot rewrite or retroactively change the
Phase A result. Until that separate evidence boundary exists, `PLN-02` remains
`incomplete`.

The Stage 18 development projection separately derives blockers only from rows
whose `blocksDevelopmentAcceptance` flag is true. Therefore `ANT-02` and
`AM-02` remain the development blockers. `PRD-01` remains exactly
`production-gated` and blocks production. A future criterion manifest that
directly models this richer status semantics requires its own external
authorization; this ADR does not substitute a new manifest for the one the
operator authorized.

## Consequences

- Exact input authorization no longer collapses into authorization of a pass.
- Missing, partial, reordered, duplicated, substituted, wrong-subject, stale,
  or self-referential authorization material fails closed.
- The fixed subject and later bootstrap evidence cannot form a digest cycle.
- Same-family read-only review remains useful source evidence but is not called
  model-family-independent.
- `developmentAccepted` remains false while `ANT-02` or `AM-02` is incomplete.
- `productionAdmitted` remains false while Stage 17W and later deployment gates
  are not proven.
- Stage 20 source remains unauthorized while development acceptance is false.
