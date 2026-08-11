# ADR 0026: Stage 19B serialized, evidence-gated Git integration

- Status: Proposed implementation checkpoint; Stage 19B acceptance remains incomplete
- Date: 2026-08-11

## Context

Stage 19A provides deterministic, subject-bound evaluation and keeps model
advice non-authoritative. It deliberately stops before any Git mutation. A
later integration boundary must prove that the evaluated commit, reviewed
scope, product specification, required coverage, waivers, dissent, security and
feasibility evidence are exactly the inputs whose local target ref changes. It
must also survive duplicate delivery, concurrent workers, process interruption,
and a lost receipt without repeating an ambiguous effect.

Directly calling Git from the scheduler, accepting model-authored shell text, or
moving a ref before durable intent would collapse those boundaries. Mutating a
developer worktree would also make recovery dependent on ambient state.

## Decision

Add `@ai-dev-os/integrator` with a closed schema-version-1 domain, durable
`integration-run` aggregate, injected Git and validation ports, and literal
`productionEnabled: false`. The production entrypoint imports only domain and
persistence; the package manifest also carries `@ai-dev-os/workspace` because
the real sanitized Git adapter is exported exclusively by the testing subpath.
That adapter accepts exact task-owned fixture roots.

### Exact admission

An integration request canonically binds the repository/object format,
non-primary local target ref, exact target/source/integrated commit and tree,
strategy, ordered parents, allowed paths, Stage 19A evaluation admission,
product specification and requirements, deterministic evidence, waiver,
dissent, security and feasibility digests, validation plan, authority,
candidate task-result/artifact/manifest identity, idempotency key, deadline,
retry policy, resource bounds, exact request digest, and the exact Git and
validator port identifiers/schema versions plus route and physical-target
fingerprints.

Trusted composition provides a fingerprinted allowlist of exact authority,
evaluation-admission and reviewed-resolution digests. A self-asserted request
cannot authorize itself. An advisory proposal is permanently `authority:
"none"`; a separate allowlisted authorization must bind the exact proposal,
tree, scope, authority and unchanged validation plan. Deterministic failure,
unexpected skips, changed validation configuration, missing required coverage,
unauthorized waiver, or post-integration regression cannot be overridden by a
model recommendation or completion narrative.

### Lease, fencing and serialization

Acceptance is idempotent across the run ID and a globally scanned bounded
idempotency key. Claiming occurs in the same serializable persistence
transaction that scans the bounded `integration-run` projection. A live lease,
prepared intent, uncertain effect or committed receipt for the same repository
and target blocks another claim. Each successful claim consumes an attempt and
allocates the next monotonically increasing fencing token. Preparation and
effect start require an exact owner, lease ID, token, version and unexpired
lease both before any external callback and again at the pre-effect commit.
Recovery keeps the exact persisted owner/lease/fence but may run after expiry;
an uncertain or committed run has no transition that can invoke Git again.

### Effect and recovery protocol

Repository/ref/object-database-read-only preflight and pre-integration
validation produce canonical evidence; preflight may use bounded request-owned
scratch filesystem/object storage described below.
Unresolved conflicts and deterministic validation failure are terminalized
with those exact results. An allowlisted boundary failure may schedule only a
bounded pre-effect retry. Preparation otherwise persists an intent that binds
those results. Execution first
commits `effect-uncertain`; only then may the Git port run. The port result is
persisted as an exact receipt before post-integration validation. No automatic
retry is permitted after the uncertain marker.

Reconciliation durably starts one bounded recovery attempt before calling the
port. It never publishes the target integration effect, but the real fixture
port may compare-and-delete its exact private effect-guard ref. It compares the
target ref/tree and expected commit object to distinguish no effect,
commit-created, ref-published and diverged states. A published exact ref can
yield one reconstructed receipt followed by deterministic validation and
cleanup. Proven no-effect/divergence states terminate failed rather than repeat
the write. Boundary unavailability remains ambiguous; after the separately
bounded recovery budget is exhausted it becomes
`manual-reconciliation-required` and continues to block that physical target.
Exact retries return the durable state without a second port invocation.
Post-validation boundary failure still performs bounded cleanup and retains its
exact cleanup evidence before terminal failure.

Each event contains the full next snapshot, exact command and fingerprint,
prior/current digest, deterministic event ID, sequence and aggregate version.
Replay validates the exact command delta and checkpoint. Checkpoint and journal
append share one transaction. A reachable journal is capped at 30 events,
covering independently authorized maxima of eight claimed/pre-effect attempts
and eight recovery attempts plus their exact lifecycle events, and pagination
reads at most one bounded
overflow sentinel.

### Reviewed Git fixture boundary

The test-only adapter uses `@ai-dev-os/workspace`'s sanitized `GitRuntime`; it
accepts no arbitrary shell text or raw Git argv. It verifies real-path
containment, clean index/worktree, exact object format/ref/commit/tree,
allowed-path equality, inventory and limits. Symlinks, reparse escapes,
gitlinks/submodules, unexpected paths, missing objects and wrong trees fail
closed. Program-valued hooks, filters, textconv and merge-driver configuration
are neutralized; transport, credentials, signing, editors, paging, submodule
recursion and maintenance stay disabled.

Merge preflight sends virtual merge writes to a deterministic request-owned
private object directory with the contained repository object store as a
read-only alternate, then removes it only after the Git process drains. The
durable repository object database is unchanged. Integration uses a fresh
task-owned no-checkout worktree and private index.
Fast-forward publishes the exact source commit. For a reviewed textual
resolution, the adapter hashes the exact target-to-result binary patch bytes
and requires the authorized artifact digest. Merge writes the exact reviewed
tree and deterministic commit with target first and source second. Immediately
before the only target-ref write, the adapter revalidates target, source, tree and
clean-state evidence. Publication is the compare-and-swap local
`update-ref <target> <new> <expected-old>`, so a post-validation race fails
without overwriting the new target.

No push, PR merge, configured-protected/current-branch update, squash, rebase, history rewrite, tag,
release, signing, remote publication, or production registration is present.

### Persistence evolution and bounds

Append PostgreSQL migration `0003-integration-run-aggregate`; released 0001 and
0002 bytes/checksums remain unchanged. The new migration replaces only the two
closed aggregate-type constraints and is checksum-pinned. SQLite and memory use
the extended public discriminator without a physical migration.

The request preflight caps nodes at 75,000, cumulative text at 2,000,000 UTF-16
code units and depth at 32 before nested parsing. Closed maxima cover 4,096
paths, 2,048 requirements, 1,024 conflicts, 256 validation commands, 8 claimed
attempts plus 8 separately bounded recovery attempts, 50,000 files,
2,000,000,000 bytes, 900,000 ms per external operation plus finite cancellation
drain/cleanup containment grace, one worktree, 30 events and
10,000 retained checkpoints. Every port receives cancellation and every service
wait is finite. An injected port that ignores cancellation yields an unconfirmed
drain or ambiguous outcome; only the reviewed real-Git runner proves process-tree
drain before settlement. Receipts/errors retain hashes, counts, stable codes and reviewed relative
paths—not source bodies, arbitrary command output, credentials, hidden
reasoning, or unrelated paths.

## Rejected alternatives

- Letting a model choose Git commands or resolve conflicts would grant advisory
  text effect authority.
- Updating the ref and journaling later would make a lost response unsafe to
  retry.
- Retrying after an uncertain effect would permit duplicate commits/ref moves.
- Squash/rebase would break exact parent and evaluation lineage.
- A shared developer worktree would expose unrelated files, hooks and index
  state and make cleanup unsafe.
- Editing PostgreSQL migrations 0001 or 0002 would invalidate released history;
  additive 0003 preserves it.

## Consequences and remaining work

This is a production-disabled Stage 19B implementation checkpoint, not an
accepted Stage 19B release. Its real fixtures cover clean fast-forward/merge,
textual conflict and reviewed resolution, drift, bounds, effect ambiguity,
reopen, post-integration regression, and the roadmap's concrete B3 cases for
fabricated tests, policy violations, missing required features, partial user
journeys, lowered criteria, undocumented waivers, and narrative-only completion.
Independent review, definitive gates, publication and exact-head hosted CI
remain separate gates.

The generic scheduler/application effect lifecycle, remaining Stage 18
development rows, deployment-scale indexed integration queue, human approval
authentication, production registration and Stage 20 loopback API remain
separate work.
