# `@ai-dev-os/evaluation`

`@ai-dev-os/evaluation` is the production-disabled Stage 19A evidence and
evaluation domain. It converts bounded, versioned deterministic evidence into
an exact criterion projection, preserves model disagreement without granting it
authority, and journals every run through the existing persistence port.

The package performs no provider call, process launch, workspace read, Git
operation, network request, credential lookup, approval, waiver creation, or
integration effect. `productionEnabled` is the literal `false` on every
snapshot and service. Stage 17 admission and the future integrator remain
separate gates.

## Deterministic evidence

Schema version 1 supports eight closed evaluator kinds:

- output-schema parsing and violation counts;
- changed paths versus an exact allowed-path set;
- compilation exit status;
- test pass/fail/skip counts with an exact expected-skip count;
- blocking static-analysis findings;
- acceptance-criterion satisfaction;
- requirement/task/result coverage;
- repository head/tree identity.

Every item is bound to the repository, same-format Git head/tree, subject
digest, criterion, exact evaluator/version, configuration, kind-specific
evidence-contract digest, derived input digest, exact expected artifact digests, observation
time, and validity window. Requirement coverage carries explicit bounded
requirement-to-task-to-result edges rather than unrelated flat identifier sets.
Wrong-head, stale, future, wrong-input, wrong-route, or
configuration-substituted evidence is invalid. A failed deterministic item
dominates a passing narrative or model advisory.

Required and expected-quality criteria block normal acceptance when failed or
missing. Delight and deferred gaps remain visible but nonblocking. Service
composition injects a fingerprinted trusted configuration containing the exact
subject-bound criterion-manifest, evidence-instance, and waiver digests it
accepts. This prevents a request from authorizing itself by omitting criteria,
fabricating a passing evidence record, or merely claiming an operator,
product-owner, or security-reviewer waiver. A bounded, unexpired inline waiver
becomes `waived` only when its complete canonical digest is in that external
configuration. The package does not execute or authenticate evaluators,
authenticate humans, or mint approvals; reviewed evidence production and
configuration of those digests are external trusted responsibilities.

The Stage 18 fixed-subject checkpoint demonstrates that distinction with a
finite operator packet. The packet records the exact external prompt digest,
subject, criterion manifest, ordered evidence digests, zero waivers, and
nonclaims. Repository code does not pretend to cryptographically authenticate
the chat transport; it validates only the exact recorded projection and then
constructs the normal trusted digest allowlists. Allowlists make an evidence
instance eligible for deterministic evaluation. They do not change its
`satisfied` field, authorize a criterion outcome, or grant authority to the
result.

The same checkpoint keeps bootstrap evidence outside the frozen request. Its
audit cannot consume its own result as evidence for `PLN-02`; only a later
published subject may cite that exact result. `PRD-01` also remains a separate
production-gate semantic: correct fail-closed production gating does not become
development acceptance or production admission. ADR 0029 records the complete
two-phase boundary.

## Disagreement and completeness

Model advisories carry an independent route key and a recommendation, but no
completion, scope, execution, or integration authority. A recommendation that
differs from the deterministic projection is retained as a disagreement; it
never changes the decision.

`createCompletenessAudit` returns every non-passing criterion and may propose a
deterministic corrective-task key for a blocking gap. The output permanently
declares `authority: "none"`, `mayAuthorizeExecution: false`,
`mayApproveWaiver: false`, and `mayWidenScope: false`.

## Durable run contract

The bounded state machine is:

```text
accept -> pending
pending -> completed | retry-pending | failed | cancelled | expired
```

Requests allow one to eight attempts and a canonical deadline. Snapshots retain
the exact trusted-configuration fingerprint and content. Events include
the exact command, prior/current snapshot digests, deterministic event ID,
sequence, version, and full snapshot. Replay reconstructs every command and
requires byte-equivalent canonical events and checkpoint. The store writes the
checkpoint and event atomically using the closed `evaluation-run` persistence
aggregate type. Exact retries are write-free; conflicting identity or version
reuse fails closed. New acceptance uses the service instance's current trusted
configuration. Reopen/load requires its persisted fingerprint to appear in a
separate bounded trusted-fingerprint registry, allowing explicit configuration
rotation without treating a new superset as the old run's exact authority.

## Bounds and nonclaims

The public parser caps criteria at 256, deterministic evidence at 1,024,
waivers at 256, advisories at 128, identity collections at 2,048, explicit
coverage edges and changed/allowed paths at 4,096, artifact digests at 1,024,
and attempts at 8. A request-wide preflight additionally caps cumulative nodes
at 75,000, reserving the enclosing JSON budget for authority, result, snapshot,
and event projections; it caps cumulative text at 2,000,000 UTF-16 code units and depth at 32
before nested collections are parsed. A reachable journal contains at most nine
events (acceptance plus eight attempts/transitions); the store reads only a
tenth overflow sentinel before rejecting and also rejects empty, repeated, or
non-progressing pagination. Canonical domain JSON limits remain a second
enclosing payload bound.

This checkpoint does not implement `@ai-dev-os/integrator`, mutate Git, run a
model evaluator, arbitrate scope, approve waivers, execute corrective tasks, or
admit production. Those remain explicit Stage 19B and production-gate work.
