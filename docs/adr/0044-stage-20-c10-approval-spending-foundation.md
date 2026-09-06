# ADR 0044: C10 approval/spending foundation and binding hardening

- Status: Accepted for bounded implementation; publication requires reviews
- Date: 2026-09-05
- Prerequisite: C9 5769e44939395cdb9ec5b8c729d1965c35340224,
  tree c88c352ac8e79e752d1e7c9b19dda930c7e94ecf
- Production activation: prohibited

## Decision

Add @ai-dev-os/approval with @ai-dev-os/project as its sole runtime dependency.
Reuse C6 approval, spending, money and lifecycle contracts and C7 aggregates.
Add no migration or plan lifecycle edge. The submitted implementation prompt and
program scope decisions govern over both proposal dossiers; colliding Opus and
Fable OD-C10 identifiers are not a blanket accepted decision table.

All five classes are one-shot and project-bound. Require non-null binding.project
and matching scope.projectId; global C10 proposals await separate stop ownership.
Bind exact project/version/content, applicable
effect scope, account/model, policy, accepted brief/plan/seal evidence, money,
quote and original validity. Recurrence describes manual vendor arrangements;
unknown amount/quote remains non-durable preparation.

Separate evaluation, authenticated issuance and transaction ownership.
@ai-dev-os/application must authenticate the exact operation and operator before
privately issuing a non-serializable identity capability. Public values, booleans,
casts and model prose prove no authority. Only ./testing contains synthetic
issuance and concrete C7 composition; the production root cannot reach it.
Passing those fixtures does not establish a deployed production writer.

## Binding repairs

SEC-01: evidence usage must equal the original requirement's semantics.
One-shot matches schedule consumption; reusable evidence cannot bypass it.

SEC-02: retain original issuedAt/expiresAt and exact policy revision/fingerprint.
Reject future activation, stale policy, altered scope, revocation and expiry.
Evidence cannot establish its own original requirement. The broker retains a
bounded set or accepts originals from trusted application storage, never renewing
expiry at a later now+TTL. Restart persistence/authentication is the application's
responsibility; an evidence-only restart cannot silently restore authority.

SEC-07: derive money and subject material from the actual parsed spending record.
Compare every amount/vendor/currency/recurrence/quote term, class and linked
consumed approval. Project IDs must be equal: null is global-only, never a
wildcard. Actual task/provider/workspace must match. The C10 transaction
evaluator invokes this helper; a supplied independent digest string is no
longer accepted by the project API. Spending subject bytes remain unchanged.
This generic null-equality rule does not admit global C10 proposals. Preparation,
reparse, evaluation, projection and operation boundaries reject them. The actual
Project envelope proves content/version/active status inside the transaction;
unrelated project stops remain scoped. No legacy global record is migrated.

## Atomicity and observation

Consumption/authorization is a two-record operation; replacement closes two
pending predecessors and creates two unapproved successors atomically.
Authorized terms cannot be edited in place. Manual execution reports and receipt
references are operator assertions, never independently verified payment facts.

The transaction owner checks expected versions, actual Project content/state,
complete in-transaction stops and final admission time after asynchronous reads.
The testing bridge's current policy/account/plan/brief seam is explicitly
synthetic. The one-attempt latch is never re-armed; its mutation-attempt marker
differs from durable approval consumption. All two/four-record writes and events
roll back on proven refusal. Uncertainty gets one bounded exact observation,
never a repeated mutation. Partial/mismatched events are corrupt; complete absent
events plus unchanged heads prove not-recorded; insufficient evidence is unknown.
The package README defines bounds, restart limitations and uncancellable C7 I/O.

Authority identity intentionally excludes explanation and createdAt. Exact create
replay nevertheless requires full immutable prepared material equality after
each stored head is validated against its own original and the stored pair is
proved consistent. Advanced exact replay is no-write and never resets lifecycle.
Valid caller-material differences use store.material-conflict, including later
operations at current versions. Intrinsic checksum, record/linkage, partial pair
and paired-original damage remains corruption. Pure supplied-pair mismatch uses
request.binding-mismatch; persisted provenance is established only by the decoder.

## Canonical compatibility

Replace the 28 locale-sensitive plan comparisons with one private UTF-16
code-unit comparator. Numeric stage/version precedence is unchanged. Apply the
same ordering to three policy expressions. Normalized set-like collections
become independent of runtime locale; declared stage order and the presentation
bytes retained by the existing proposal contract remain semantic.

Earlier bytes are compatible where their ordering already agrees. Differing
mixed-case/punctuation records are refused by current reconstruction, never
silently rewritten. Sealed records, accepted briefs and evidence packets remain
immutable. Original source can verify historical bytes. No real operator records
are involved here; any future persisted-data migration requires separate scope.
Changed policy fingerprints/derived IDs require newly issued decisions; old
evidence is not upgraded to the new policy.

## Projections and deferred ownership

Both modes expose the same unavailable actions, empty commands and no authority.
Untrusted prose stays in labelled quotes. Approved, consumed, expired and
operator-reported-executed remain distinct. Waiting copy reflects missing
application wiring, with no Start, quote fetch, formatting, route, notification
delivery or invented balance.

Round-1 review repairs preserve consumed and terminal history under current drift,
inactive project or stop, recording those conditions in fixed caveats. A closed
approval's reason and spending substatus remain distinct from a consumed approval's
spending outcome. Current refusal/fresh-request presentation is restricted to
pending/unused records. Recorded money approval names disconnected application
authorization, and does not also ask for another decision. All actions remain
unavailable; evaluator admission safety is unchanged.

The small unpublished projection change adds expiryApplicable. Historical records
retain expiresAt, with expiryApplicable:false and expired:false. Pending request
and unused approval expiry have distinct truthful labels and matching substates.
Waiting/fresh-decision copy and alternatives do not survive closure, elapsed
validity, current refusal or unknown/corrupt recovery; consequenceOfRefusal is null
when inapplicable. Only approval tests/packed probes consume the changed fields.
Recovery precedes presentation without proving an uncertain operation committed.
Conflict text covers both version and full-material differences.

R2 owns joint scope consumption and plan sealing. C10 supplies pure evidence
conformance without a plan write or independent durable scope consumption.
Retain the existing scope-expansion class check and wrong-class regression;
redundant D-5 is not implemented. No new plan journal event is pre-mandated.
Other C9 advisories are deferred. AI Powerhouse/Windows-first direction, manual
purchases, borrowed caps and Fable exclusion from borrowed profiles remain.
PLN-02 and production-disabled gates are unchanged.

The consolidated repair scope is C10-MF-01 through MF-04. It folds Fable A1/A11,
directly contradictory historical A9 copy and affected documentation/A12. All five
Opus advisories, Fable A2-A8/A10 and nonoverlapping A9 work remain deferred. This
amends C10, adding no stage, schema/state-machine redesign, UI or R2 implementation.
