# @ai-dev-os/workspace

Repository discovery, immutable snapshots, managed private worktrees, and diff
and commit manifests.

The single promise this package makes: **the user's working tree, index, refs,
configuration, and object database are never modified.** Everything else is
built to keep that true even when the repository is hostile.

## How a snapshot is taken without touching the source

1. `GIT_OBJECT_DIRECTORY` points at a private object store, so every new object
   is written there. `GIT_ALTERNATE_OBJECT_DIRECTORIES` points at the source
   objects, which stay readable and are never written.
2. The user's index file is **copied** to a private path and `GIT_INDEX_FILE`
   points at the copy. Copying is a plain file read, not a Git operation, and
   it preserves staged state exactly.
3. Working-tree bytes are read by this process and hashed with
   `hash-object -w --no-filters --stdin`. Because the bytes arrive on standard
   input with no path attached, no `.gitattributes` entry applies.
4. Object identifiers are placed in the private index with
   `update-index --cacheinfo`, which records an entry without opening any file.
5. `write-tree` and `commit-tree` turn the private index into a commit in the
   private store. `commit-tree` is plumbing: it runs no hook and updates no
   reference, so no branch can move as a side effect.

The tests fingerprint every file under `.git` and the whole working tree before
and after, and require the result to be byte-identical. Access time is
deliberately not claimed: reading a file updates it on many systems and no
application can prevent that.

## Why the worktree is not attached to the user's repository

`git worktree add` writes administrative state into the repository it runs
against — a `worktrees/<name>` directory inside `.git`. Pointing it at the
source would mutate exactly what this package promises not to touch. Instead a
private bare repository is created under the managed root, borrows the source
objects read-only through `objects/info/alternates`, and owns the snapshot
objects. All worktree bookkeeping lands there. A test asserts that
`.git/worktrees` never appears in the source.

## Hostile repository defence

A repository is untrusted content, and several Git configuration keys name a
program Git will execute. Two mechanisms handle this:

- The environment is built from empty: everything that redirects repository
  state, configuration, credentials, or transport is absent.
- Command-line `-c` overrides are passed on every invocation. These outrank the
  repository's own `.git/config`, so hooks, credential helpers, external diff,
  fsmonitor, signing programs, editors, pagers, submodule recursion, and every
  protocol are disabled at the highest precedence.

### The filter finding

Content filters cannot be disabled by a fixed list, because a filter *driver*
is named by `.gitattributes` — repository content — while its command comes
from configuration under a name that cannot be predicted in advance.

Adversarial testing showed this matters in practice: **`git diff-files`
re-hashes a working-tree entry whose stat information looks racily clean, and
re-hashing applies the clean filter.** A hostile repository could therefore get
a program executed through what appears to be a pure read. Reading the
documentation would not have revealed this; a fixture that armed a real filter
did.

The fix is to enumerate the repository's own filter, textconv, and merge driver
names first — listing configuration keys executes nothing — and pass an empty
command-line override for each. Every command that touches the source
repository carries those overrides.

The hostile fixture is a positive control: `assertHostileFixtureFires` proves
the armed hook and filter really do execute for ordinary Git, so the
"no marker appeared" assertions elsewhere are not vacuous.

## Path safety

`parseWorkspaceRelativePath` (from `@ai-dev-os/process-broker`) rejects
absolute paths, drive letters, UNC and device paths, traversal, control
characters, Windows reserved device names, trailing dots and spaces, alternate
data streams, excessive depth, and any component addressing administrative
state such as `.git` — case-insensitively and after Unicode normalization.

Before every side effect the path is re-resolved and each existing component is
inspected with a non-following stat. A symbolic link or a Windows junction
anywhere along the path is refused rather than resolved.

**Honest limitation.** Re-resolving immediately before use narrows the
check-to-use window but cannot close it against a process running as the same
user. That is precisely why the production gate requires an enforcing sandbox:
containment must come from something the workload cannot subvert.

## Snapshot lifetime

A snapshot commit lives in the private store, but its unchanged blobs and trees
are still borrowed from the source repository through alternates. If the source
is garbage-collected or deleted, borrowed objects can disappear. The snapshot
is valid only for as long as the source retains them; a caller needing a longer
guarantee must materialize the objects. This is recorded on the snapshot as
`borrowedObjectDirs` rather than left implicit.

## Cleanup

A directory is removed only after its resolved identity is confirmed to be
inside the managed root **and** an ownership marker written at creation is
found and matches. Cleanup is refused while a lease is active, is idempotent,
and an unmarked directory is left alone rather than deleted. Partial creation
is reconciled through the same checked path.

## Relationship to the process broker

Git is invoked directly here rather than through `@ai-dev-os/process-broker`.
That is deliberate: the broker supervises *untrusted workload* and demands a
grant, a policy decision, and an isolation backend before anything starts,
while this package runs *trusted infrastructure plumbing* with fixed argument
arrays in order to read the state that makes issuing a grant possible. Routing
the second through the first would be circular. Every hard rule is still
shared: argument arrays with no shell, a constructed environment, bounded
output, an enforced deadline, and process-tree termination on timeout.

## Not in this stage

No integration into the user's branch, no merge resolution, no remote
operation of any kind, no scheduler recovery loop. Target movement and
conflicts are *detected* and reported as evidence; acting on them belongs to
the later integration stage.

## Contract suite

`@ai-dev-os/workspace/testing` exports `runWorkspaceContractSuite` plus the
temporary-repository fixtures, including the hostile hook, filter, submodule,
remote, index-lock, symlink, and junction shapes.
