# @ai-dev-os/approval

C10 is a production-disabled approval/spending record library. Its sole runtime
dependency is @ai-dev-os/project. The root contains pure construction, exact-key
parsers, deterministic evaluation, scope-evidence conformance and projections.
It contains no issuer, transaction implementation, application command or payment.

## API and authority

prepareApprovalRequest(proposal, evaluatedAt, hash) returns ready with canonical
C6 records, or awaiting-quote without durable records. Unknown amount is never
zero. Scope-expansion, paid-usage, purchase, subscription and spending-limit are
all one-shot and require a non-null project binding with matching scope.projectId.
Global proposals are deferred until stop ownership is separately defined. Generic
C6 nullable types and money-helper null semantics are unchanged; C10 does not
admit, migrate or silently rebind global prepared requests. Recurrence describes
vendor terms, not reusable approval or renewal.

Identity binds class, risk, project/version/content/budget account, exact effect
scope, account/model, policy revision/fingerprint, plan/accepted-brief and
specification/coverage/seal evidence, all money/quote terms and original expiry.
Binding ID arrays use code-unit order. Explanation prose and creation time grant
no authority. A create returns idempotent-replay only for the complete original
prepared material, including both stored heads, even after lifecycle advancement.
It never resets records. Valid same-identity material that changes explanation,
creation time or another immutable field yields store.material-conflict on create
and later actions. Intrinsic envelope/record/linkage or paired-original damage
remains store.corrupt. Pure supplied-pair assertions have no persisted provenance
and report request.binding-mismatch; the store translates an internal stored
record's mismatch against its own original into corruption.

evaluateApprovalOperation returns candidate mutations. Caller-supplied controls
and operator evidence are values, not authentication. The future
ApprovalApplicationAdapter owner is @ai-dev-os/application: it must authenticate
the exact operation and operator, privately issue a non-serializable identity
capability, and own the transaction. A boolean, cast, chat or model statement
cannot substitute for issuance. No production adapter is deployed.

Only @ai-dev-os/approval/testing exports the synthetic WeakMap-backed issuer,
hash and C7 composition. Its readBinding(tx, expected) is an explicitly synthetic
trusted policy/account/plan/brief snapshot seam. Expected values are lookup
coordinates, never evidence of current truth. The composition independently
reads the actual Project and complete ProjectStop scan inside that transaction.
Project content, version and active status come from its verified envelope, with
no null-project bypass or assumed active default. Relevant stops refuse admission;
an unrelated project's stop is not a global switch.
The application owner must implement the other authoritative reads, shared clock,
authentication and durable attempt recovery before production wiring.

## Transactions and recovery

Existing C6 tables and approval-request/spending-request aggregates are reused;
there is no migration. Requested, approved, consumed/authorized,
operator-reported-executed and manually asserted receipt remain distinct.

Consumption and authorization write two records atomically. Replacement closes
two pending predecessors and creates two unapproved successors in one four-record
transaction. Changed amount/currency/recurrence creates a new identity; authorized
terms cannot change in place. Revoke, decline, expiry, binding invalidation and
withdrawal use existing transitions. Stop invalidation must name the approval.
A quoted predecessor closes through the existing request-approval then terminal
transition within the same transaction, without granting intermediate authority.
A stale policy can invalidate the old request; a fresh request is a new decision.

Expected versions and fresh admission time after all asynchronous evidence reads
guard one transaction attempt. The private attempt latch is reserved before I/O
and never re-armed, including a known refusal. Its consumed marker means a
conditional mutation was attempted, distinct from durable approval consumption.
Proven callback refusal rolls back every affected record and event.

Uncertainty permits one exact read observation and no write retry. Each explicit
repeat observation is bounded. Exact matching events for every affected record
establish committed; absent events and byte-equal original heads establish
not-recorded; partial/mismatched evidence is corrupt; insufficient evidence stays
unknown. Conflict requires a proven refused transaction. Journals retain the
exact operation, actor, controls and complete write set. Later head advancement
does not invalidate an exact historical commit event.

The synthetic composition retains at most 1,000 attempts in memory; restart
recovery remains the application's responsibility. Stop/journal scans have
1,000-entry and finite-page bounds, with a default 30-second monotonic budget
checked before/after awaited reads. C7 has no cancellation port: in-flight calls
are awaited, never detached. This is a cooperative evidence deadline, not an
interrupt of a hung driver. Event material is limited to 131,072 UTF-16 code
units before mutation. There are no background retry timers.

## Projections and R2

projectApproval accepts an explicit server timestamp and optional controls and
outcome. Normal and Developer have identical unavailable actions, authority none
and empty commands. Developer adds labelled audit detail only. Untrusted prose
stays quoted with provenance outside control/refusal fields. No remaining
balance, eligible route, sent notification or working Start control is implied.
Purchases and subscription changes remain manual.

Current drift, inactive-project and stop status apply to preparation, requested
and approved-but-unused records. Consumed and closed histories retain their
recorded approval/spending substates and represented domain actions, all still
unavailable; current conditions appear as fixed caveats. Closed approvals retain
their decline/revocation/invalidation/expiry reason. Consumed approvals show the
recorded spending outcome. Operator execution and receipt references remain
assertions, not independently verified outcomes.

The unpublished projection adds expiryApplicable: expired describes elapsed
validity only while a request is pending/unused. History has expiryApplicable:false
and expired:false while preserving expiresAt as evidence. Never-approved pending
validity lapses show Request expired; approved-unused lapses show Approval expired.
Approved money shows a recorded decision awaiting disconnected application
authorization, without another decision-needed spending substatus. Scope waiting
still names the disconnected joint consumption/seal. Waiting and fresh-decision
copy are suppressed for closed, expired, stale, stopped/inactive and unknown/corrupt
recovery presentations. consequenceOfRefusal is now null when no fresh decision
is represented; alternatives are empty then. Recovery keeps precedence without
confirming a new operation. Conflict copy covers material and version mismatch.
Only this package's tests and packed probe consume these projection fields today;
there is no application/UI consumer to migrate.

C10 refuses independent durable scope consumption. assertConsumedScopeApproval
is a pure future conformance contract: it authenticates no inputs and writes no
plan. R2 must jointly consume scope approval and seal the plan using authoritative
application/plan-store evidence. No new plan event is mandated here.

## Verification

Run the normal workspace build/typecheck/test/coverage scripts and root
npm run verify:approval-packed-consumer. The gate installs actual tarballs with
scripts disabled, explicitly rebuilds pinned better-sqlite3, executes memory
and real SQLite probes and walks the installed static/dynamic production graph.
Planted static, dynamic and indirect dynamic testing imports must be caught.
The parser is an existing pinned coverage-tool dependency; none was added.
Testing composition has behavioral tests separate from the pure root's maintained
coverage thresholds. See [ADR 0044](../../docs/adr/0044-stage-20-c10-approval-spending-foundation.md).
