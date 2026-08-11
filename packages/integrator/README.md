# `@ai-dev-os/integrator`

`@ai-dev-os/integrator` is the production-disabled Stage 19B boundary for
serialized, evaluation-gated local Git integration. It persists the exact
request, lease, preflight, validation, effect intent, receipt, recovery, and
terminal projection through `@ai-dev-os/persistence`.

`productionEnabled` is the literal `false`. The package root has no filesystem,
process, workspace, network, credential, provider, push, merge-service, signing,
or publication implementation. Its production constructor refuses preflight,
Git execution, and reconciliation before invoking an injected port. The real
Git implementation exists only under `@ai-dev-os/integrator/testing` and will
operate only on an exact disposable fixture root supplied by tests.

## Authority and evidence

Schema version 1 binds:

- repository/object format, exact non-`main`/`master` target ref plus the test
  route's configured protected refs and checked-out branches, exact target/source and
  integrated commit/tree identities, and exact target-first/source-second merge
  parents;
- the exact reviewed Git and deterministic-validator port identifiers and
  schema versions, full route fingerprints, physical repository-target
  fingerprint, and the allowlisted exact request digest, so a substituted
  route or request is refused before a callback;
- a Stage 19A accepted evaluation run/result/subject, subject-bound criterion
  manifest, deterministic evidence, product specification, requirements and
  coverage, authorized waivers, dissent, security findings, and feasibility
  findings through one externally authorized admission digest;
- one exact allowed-path set and a closed validation plan of command
  identifiers, criterion identifiers, configuration and threshold digests;
- an external authority digest and a separately authorized resolution digest;
- exact task-result/artifact/manifest provenance, idempotency, deadline,
  retries, paths, files, bytes, conflicts, wall time, and
  exactly one worktree.

An advisory resolution proposal always carries `authority: "none"`. It can be
used only when a separate canonical authorization binds its exact proposal,
authority, allowed paths, resulting tree, and unchanged validation plan, and
that authorization is allowlisted by trusted service composition. Model output
cannot pass deterministic validation, lower thresholds, add skips, approve a
waiver, widen paths, suppress dissent, or authorize a ref update.

The package does not authenticate Stage 19A evidence producers or human
reviewers itself. Trusted composition must authorize the exact admission and
resolution instances. Inline claims alone never authorize integration.

## Serialized durable lifecycle

```text
accept -> pending
pending/expired lease -> leased (monotonic fencing token)
leased boundary failure -> pending (only an allowlisted pre-effect retry)
leased -> prepared (repository-read-only bounded-scratch preflight + deterministic validation)
leased -> failed (durable conflict or deterministic-validation evidence)
prepared -> effect-uncertain (durable intent before Git)
effect-uncertain -> committed (durable exact receipt)
committed -> completed | failed (post-integration validation + cleanup evidence)
effect-uncertain/committed/reconciling -> reconciling (durable bounded recovery start)
reconciling -> completed | failed (target observation, validation, and cleanup)
reconciling -> manual-reconciliation-required (last recovery boundary unavailable)
pending/leased/prepared -> cancelled
```

Claiming transactionally refuses another active run for the same repository and
target ref. Every state-changing command carries an expected version; every
effect command additionally carries owner, lease ID, and fencing token. Exact
delivery retries are write-free. Command-ID reuse with different content fails
closed.

The effect-start event is committed before the Git port is called. A failure or
lost response after that point remains `effect-uncertain`; `execute` never calls
the effect again. Reconciliation inspects the exact target and expected object
and distinguishes no effect, prepared/commit-created evidence, published local
ref, and divergence. It reconstructs one exact receipt, terminates failed, or
retains an unresolved last-boundary ambiguity for explicit manual handling.
Recovery may run after the original lease/request window using only the
still-current persisted owner, lease, and fence; no execution transition is
available from an uncertain or committed state. Exhausting the automatic
recovery-boundary budget does not invent a no-effect result: it persists
`manual-reconciliation-required`, retains the ambiguity, and continues to
serialize the target. Normal external boundaries are
checked against the trusted service clock both before their callback and again
before a pre-effect durable transition. Full snapshots, commands,
prior/current digests, deterministic event IDs, versions, and sequences make
replay exact. Checkpoint and event are one persistence transaction.

## Disposable real-Git fixture boundary

The testing adapter uses the reviewed sanitized Git runtime with fixed argv
templates, an empty hooks/config/home environment, disabled credentials,
transport, signing, paging, editors, filters, textconv, merge drivers,
submodule recursion, and background maintenance. It never accepts shell text or
caller-provided raw Git arguments.

For each request it:

1. proves the repository lies inside the exact task-owned fixture root;
2. requires a clean worktree/index, no untracked paths or submodules, exact
   object format, ref, commits, trees, changed paths, inventory and bounds;
3. rejects symlink/gitlink entries and unsafe paths;
4. computes fast-forward ancestry or a deterministic merge tree in a
   request-bound private object directory, preserves
   textual conflicts for exact reviewed resolution, and hashes the exact
   target-to-result binary patch bytes against the authorized artifact digest;
5. creates one fresh no-checkout task-owned worktree and private index;
6. verifies the private index writes the reviewed tree and, for merge, creates
   the exact deterministic target-first/source-second commit;
7. revalidates clean target/source state immediately before a compare-and-swap
   `update-ref <target> <new> <expected-old>`; and
8. returns only finite hashes, counts, stable codes, and relative paths.

Preflight is read-only with respect to the durable repository/ref/object
database, but it uses bounded request-owned scratch filesystem state and removes
that state after the drained Git command. Reconciliation may compare-and-delete
the exact private effect-guard ref; it never publishes the target ref.

There is no push, PR merge, configured-protected/current-branch update, squash, rebase,
history rewrite, tag, release, signing, publication, or production registration.

## Bounds and failure behavior

Inputs are plain dense data with no aliases, accessors, symbols, or cycles.
Preflight caps total nodes at 75,000, text at 2,000,000 UTF-16 code units,
depth at 32, paths at 4,096, requirements at 2,048, conflicts at 1,024,
validation command IDs at 256, claimed/pre-effect attempts at 8 and separately
recovery attempts at 8, files at 50,000, bytes at 2,000,000,000, per-operation
wall time at 900,000 ms plus finite cancellation-drain and cleanup-containment
grace, one worktree, 30 journal events, and
10,000 retained run checkpoints. Pagination must make bounded progress.

Failure seams cover preflight, worktree creation, private index update,
write-tree, commit creation, ref update, receipt recovery, validation, and
cleanup. Errors do not retain source bodies, arbitrary Git output, credentials,
command strings, hidden reasoning, or unrelated paths. Cleanup failure keeps a
finite failure code and explicitly records whether evidence was preserved.
Post-validation boundary failure still attempts bounded cleanup and persists
that exact result before terminal failure.

The testing adapter is not production authority. Callers remain responsible for
providing a genuinely isolated fixture root and for never pointing it at a
product repository.

The disposable real-repository suite includes the complete named Stage 19B B3
matrix: clean and conflicting integration, stale targets, failing resolution,
fabricated test artifacts, policy violations, missing required features,
partial journeys, lowered criteria, undocumented waivers, narrative-only
completion, and post-integration regression. Each adversarial case is derived
from the actual candidate tree and must refuse before the target ref changes.
Stage 19B acceptance still requires definitive gates, independent review,
publication, and exact-head hosted PostgreSQL/Windows/Linux CI.
