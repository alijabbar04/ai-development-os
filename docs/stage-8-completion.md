# Stage 8 completion report: workspace and process isolation

Status: Complete
Date: 2026-08-02
Branch: `feat/stage-8-workspace-process-isolation`
Base: `855a8030760e206020935693b7b6f46e1df6c4f0` (`v0.7.0-ollama-provider`)

## What was delivered

Two packages: `@ai-dev-os/process-broker` and `@ai-dev-os/workspace`.

The process broker decides whether a command may run, exactly what runs, and
how it is bounded. The workspace package reads a repository, captures an
immutable snapshot of it without modifying it, and hands out an isolated
worktree to work in.

The single most important outcome is not a feature. It is that **production
autonomous execution refuses to start**, because no built-in backend can
actually enforce the isolation the grant describes. That refusal is
implemented, tested, and documented as the correct behaviour rather than as a
gap to be worked around.

## The security gate, stated plainly

`createUnsafeDevelopmentBackend` is the only backend that runs commands. It
executes them as the invoking operating-system user, with that user's access to
the filesystem, the network, and their own credentials. It is named
`unsafe-development-current-user` — never `local`, `default`, or `native` — and
its descriptor, its exported limitation list, and its README all say so.

The Windows, Linux, and macOS backends are probe seams. Each reports precisely
which platform primitive is missing (`requires-native-job-object-and-restricted-token`,
`bubblewrap-not-installed`, `cgroup-v2-unavailable`,
`sandbox-exec-is-deprecated-and-not-a-supported-foundation`) and refuses to
spawn. None is classified `secure-enforcing`, and `parseBackendDescriptor`
rejects any descriptor that claims that classification without filesystem
isolation and process-tree control, so a backend cannot promote itself.

Implementing real enforcement needs native Win32 calls, or Linux namespaces
plus cgroups, or a supported macOS mechanism — each requiring native
dependencies or privileged installation that is out of scope here and that this
stage is explicitly forbidden from installing. Claiming otherwise would have
defeated the gate the stage exists to build.

## Two real defects found by adversarial testing

Both were found by fixtures that armed live attacks, not by reading
documentation. Both were fixed rather than documented around.

### 1. `git diff-files` executes a repository's clean filter

The snapshot design assumed that `diff-files --raw` never hashes working-tree
content, because the raw format reports an all-zero object identifier for the
working-tree side. That assumption is wrong. When an entry looks *racily
clean* — its stat data matches the index but the timestamps are too close to
trust — Git re-hashes the file to decide whether it really changed, and
re-hashing applies the clean filter. A hostile repository can therefore get a
program executed through what looks like a pure read.

A hostile fixture arming `filter.evil.clean` caught this: the marker file
appeared during the discovery phase, and its contents were a `cmd.exe` banner
fed the staged file's content.

Content filters cannot be disabled by a fixed list of overrides, because a
filter *driver* is named by `.gitattributes` (repository content) while its
command comes from configuration under a name that cannot be predicted. The fix
enumerates the repository's own `filter.*`, `diff.*.textconv`, and
`merge.*.driver` keys first — listing configuration keys executes nothing — and
passes an empty command-line override for each. Command-line `-c` outranks
repository configuration, so the driver becomes a no-op. Empirically verified:
with the override present, the filter does not run.

Every command that touches the source repository now carries those overrides.

### 2. `git merge-tree` conflict paths were parsed from the wrong section

Conflict detection read the section *after* the blank line in `merge-tree`
output. The actual format is: tree object id, then the conflicting paths, then a
blank line, then human-readable messages. The code was reporting
`Auto-merging tracked.txt` and `CONFLICT (content): ...` as file names. Fixed to
read the machine-readable section between the object id and the blank line,
verified against real `merge-tree` output.

### A third issue: a false-positive risk in the tests themselves

Building a hostile fixture uses ordinary Git, which legitimately triggers the
hooks and filters just armed. Left alone, that would make every "no marker
appeared" assertion pass or fail for the wrong reason. Markers are now cleared
after setup with a settle loop (a helper can outlive the command that started
it), and `assertHostileFixtureFires` is a positive control proving the armed
fixture still fires for ordinary Git. Without that control the suite would be
vacuous.

## How the source repository is left untouched

Verified by fingerprinting every file under `.git` and the entire working tree
before and after, requiring byte-identical results:

1. `GIT_OBJECT_DIRECTORY` sends new objects to a private store;
   `GIT_ALTERNATE_OBJECT_DIRECTORIES` keeps source objects readable, never
   written.
2. The user's index is **copied** to a private path — a file read, not a Git
   operation — preserving staged state exactly.
3. Working-tree bytes are read by this process and hashed with
   `hash-object -w --no-filters --stdin`; with no path attached, no
   `.gitattributes` entry applies.
4. `update-index --cacheinfo` records entries without opening files.
5. `write-tree` and `commit-tree` build the snapshot commit. `commit-tree` runs
   no hook and updates no reference, so no branch can move.

`git worktree add` is never run against the user's repository, because it writes
a `worktrees/<name>` directory into `.git`. A private bare repository under the
managed root borrows source objects read-only through `objects/info/alternates`
and owns the snapshot objects instead. A test asserts `.git/worktrees` never
appears in the source.

**Documented limitation:** access time is not claimed. Reading a file updates it
on many systems and no application can prevent that. Content, size, and
structure are what the tests pin down.

**Documented limitation:** a snapshot's unchanged blobs are borrowed from the
source through alternates. If the source is garbage-collected or deleted those
objects can vanish. The snapshot records `borrowedObjectDirs` so the lifetime
relationship is explicit rather than implicit.

## Honest limitations recorded in code and documentation

- **Executable digests are TOCTOU evidence, not a boundary.** On a same-user
  backend a process can replace the image between verification and execution.
  The check raises the cost and produces audit evidence; a secure backend's
  immutable mount is the enforcing mechanism.
- **Path validation cannot close the check-to-use window.** Re-resolving
  immediately before each side effect narrows it; only a sandbox that makes
  out-of-scope paths unreachable closes it.
- **Process-tree termination is best effort on both platforms.** A child that
  calls `setsid`, detaches, or is re-parented can survive. The result says
  `termination-unconfirmed` when the tree cannot be proven gone.
- **Environment values cannot be erased after spawn.** The operating system
  copies the block into another address space. Secrets are therefore resolved
  late, scoped to one invocation, and redacted from captured output.
- **Application-level counters are never presented as kernel enforcement.** The
  broker enforces only wall-clock and output bytes because it observes them
  directly; every other quota is reported `unsupported` unless a backend
  genuinely enforces it.

## Shell execution

Not representable. `parseProcessRequest` rejects `shell`, `command`, and
`commandLine` fields outright. On Windows `.cmd` and `.bat` shims are refused
because they require shell interpretation; a package manager is expressed as a
verified interpreter plus a pinned entry point. Adding shell execution later
must be its own finite action category, denied by default, separately approved,
supported only by a containing backend, and separately tested.

## Verification performed

All on Windows 11, Git 2.54.0.windows.1, Node v24.17.0, npm 11.13.0.

| Command | Result |
| --- | --- |
| `npm ci` | pass |
| `npm run check` (typecheck + test + build, all workspaces) | pass, exit 0 |
| `npm run test:coverage` | pass, gates met |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm pack --dry-run` (both new packages) | pass |
| Packed-tarball consumer smoke test | pass |

### Test inventory

| Package | Tests |
| --- | --- |
| `@ai-dev-os/process-broker` | 201 |
| `@ai-dev-os/workspace` | 107 |
| **Stage 8 total** | **308** |
| **Repository total** | **1,041 passing, 11 skipped** |

The 11 skips are unchanged from the Stage 7 baseline: 6 opt-in live Ollama
tests gated on `AI_DEV_OS_OLLAMA_LIVE_URL`, and 5 contract-suite scenarios whose
optional harness capabilities (reopen, corruption injection) do not exist for
in-memory adapters.

### Coverage

| Package | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| `process-broker` | 92.5% | 87.1% | 90.6% | 93.6% |
| `workspace` | 90.3% | 81.3% | 90.8% | 90.9% |

Both packages set the function threshold to 90 rather than 98, with the reason
recorded in the config: process-tree termination and link handling are
platform-split by construction — the POSIX process-group path cannot execute on
Windows and the Windows `taskkill` path cannot execute on Linux — so no single
host can cover both halves. Each is covered on its own platform by the CI
matrix. This follows the precedent already set by `@ai-dev-os/provider-ollama`.

## Test matrix covered

Temporary repositories: clean, dirty, staged, unstaged, deleted, type-changed,
untracked, ignored, detached HEAD, stale index lock, remotes, submodule
gitlinks, extra commits, target advanced/rewound/deleted, conflicts.

Hostile fixtures: hooks for nine events (both shell and Windows forms), clean
and smudge filters, textconv, external diff, fsmonitor, pager, editor,
credential helper, signing program, ssh command, upload-pack hook, a
`.gitmodules` with a command-injection `update` and an escaping path, path
traversal, symlink escape, Windows junction escape, `.git` administrative
paths, environment canaries, child-and-grandchild process escape,
signal-ignoring processes, unbounded output, cancellation races, and production
refusal.

## Correction to prior documentation

The Stage 7 roadmap entry said "128 Stage 7 package tests (122 deterministic +
6 opt-in live)". The measured figure is 136 (130 deterministic + 6 live). The
wording was objectively inaccurate and has been corrected, because later stages
reconcile totals against it. No other historical wording was changed.

## Explicitly not in this stage

No Claude Code or OpenAI adapter, no routing, no durable scheduling or recovery
loop, no project memory, no repository indexing, no application composition, no
HTTP API, no desktop UI, no plugin execution, no remote Git publication, no
automatic integration into the user's branch, no network proxy, and no package
installation orchestration.

Target movement and conflicts are *detected* and returned as evidence. Acting
on them is Stage 14's job. Lease records and hooks are returned for the Stage 12
scheduler to drive; this stage persists nothing.

## Next stage

Stage 9, the Claude Code coding-agent adapter, consumes the workspace grant, the
managed worktree, and the process broker delivered here. It can be developed
against the unsafe development backend, but shipping autonomous repository
execution to users requires a genuinely enforcing backend on each advertised
platform first.
