# @ai-dev-os/process-broker

Validated process-execution contracts, sanitized environments, quotas,
process-tree cancellation, and pluggable sandbox backends.

This package decides **whether** a command may run, **exactly what** runs, and
**how it is bounded**. It does not decide what a command should do — that
belongs to the coding-agent adapter — and it deliberately does not pretend to
provide isolation it cannot enforce.

## What it guarantees

- An executable plus an argument array. There is no command-string API and no
  option that turns one on.
- A child environment constructed from empty, with no ambient caller bindings
  inherited.
- Output captured within hard byte bounds, on separate streams.
- A wall-clock deadline the broker enforces itself.
- Exactly one terminal outcome per process, whatever races occur.
- A production gate that refuses to run autonomously without an approved,
  genuinely enforcing isolation backend.

## What it explicitly does not guarantee

The shipped backends do not isolate anything. `createUnsafeDevelopmentBackend`
runs the workload as the invoking user with that user's full access to the
filesystem, the network, and their own credentials. The Windows, Linux, and
macOS backends are honest probe seams: they report precisely which platform
primitive is missing and refuse to spawn. None of them is classified
`secure-enforcing`, so production mode refuses all of them.

That refusal is the intended behaviour. Running autonomously against a hostile
repository on a machine with no sandbox is the thing this stage exists to
prevent.

## Child profile and environment

After admission, the backend prepares an empty session scratch area. The broker
adds deterministic locale and temporary-directory values and, when the backend
provides a session home, exposes exactly one platform home name: `HOME` on POSIX
or `USERPROFILE` on Windows. It does not copy the invoking user's home;
`HOMEDRIVE`, `HOMEPATH`, and the opposite platform home name remain absent. The
unsafe Windows backend also prevents Node's native spawn path from silently
reintroducing `HOMEDRIVE` and `HOMEPATH` from the parent process.

Requests cannot bind `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, or the XDG
home/config/cache redirectors as either ordinary or secret variables. Trusted
composition may separately provide broker-owned config/cache directories. An
explicit permitted API-key binding is supported and is resolved only after
policy approval.

This profile redirection prevents a CLI's default home lookup from discovering
the invoking user's installed-login files. It is not filesystem isolation: the
unsafe backend still runs as the invoking user and can open any absolute path
that user can open. Only a genuinely enforcing backend can make out-of-scope
profile paths unreachable.

## Shell execution

Not represented. A string handed to a shell is a different and materially more
dangerous action than an executable plus arguments: it reintroduces quoting,
metacharacters, and command substitution on every argument. If shell execution
is ever added it must arrive as its own finite action category, denied by
default, separately approved, supported only by a backend that can contain it,
and separately tested.

On Windows this is why a `.cmd` or `.bat` shim is refused outright. A tool like
npm is represented as a trusted `node.exe` plus the verified CLI entry point,
using `pinnedLeadingArguments`.

## Executable identity

A `TrustedToolDescriptor` names an absolute path — never a `PATH` lookup — with
an optional expected digest, containment root, and platform. Before every
spawn the broker resolves the path, enforces the descriptor's executable-link
policy, checks the file type, verifies the digest, and binds the normalized
executable and argument digest into the policy subject.

When a containment root is present, the broker canonicalizes the executable and
root independently and performs a path-component-aware comparison. The root must
resolve to an ordinary directory; a missing or unreadable root is
`EXECUTABLE_UNAVAILABLE`, while a non-directory or linked root is
`EXECUTABLE_UNSAFE`. `allowLinkIndirection` applies only to the executable and
never permits a symlink or junction as the containment-root entry. An executable
link target must still remain inside the canonical root.

**Honest limitation.** On a same-user backend the filesystem and digest checks
are time-of-check/time-of-use only. A process running as the same user can replace
the image or path objects between verification and execution. The checks raise
the cost of substitution and produce audit evidence; they are not a boundary. A
secure backend supplies an immutable mount or backend tool reference, and *that*
is the enforcing mechanism.

## Quotas

Each backend declares, per dimension, whether it `enforced`, `observed`,
`estimated`, or `unsupported` that quota. Production admission accepts only
`enforced`. The broker itself enforces wall-clock duration and output bytes,
because it observes them directly; CPU, memory, disk, process count, and
network belong to the operating system and are reported unavailable when the
platform cannot deliver them. Application-level counters are never presented as
kernel enforcement.

## Process-tree cancellation

Cancellation targets the whole tree. On POSIX the child is started in its own
process group and the group receives `SIGTERM` then `SIGKILL`; on Windows the
tree is stopped with `taskkill /T /F`. Both are conveniences, not containment:
a child that calls `setsid`, detaches, or is re-parented can survive, and the
returned outcome says `termination-unconfirmed` when the tree cannot be proven
gone. A secure backend is expected to own the tree with a Job Object or a PID
namespace instead.

## Usage

```ts
import {
  createProcessBroker,
  createUnsafeDevelopmentBackend,
  createTrustedToolDescriptor,
  createProcessQuotas,
  createProcessRequest,
} from "@ai-dev-os/process-broker";

const backend = createUnsafeDevelopmentBackend({ sessionRoot });
const broker = createProcessBroker({
  backend,
  mode: "development", // "production" refuses this backend
  policy,              // bridges to @ai-dev-os/policy
});

const result = await broker.execute({
  request: createProcessRequest({
    /* ids, tool, args, quotas, trace */
  }),
  grant,
  lease,
  workspaceRoot,
  workingDirectory,
  workspacePaths,
});
```

A zero exit code means the transport succeeded, nothing more. Task success
still requires validating what the command actually produced.

### Long-lived duplex sessions

`openDuplexSession()` performs the same executable verification, normalized
policy evaluation, grant and lease checks, workspace binding, backend
admission, environment construction, quota enforcement, production refusal,
and process-tree supervision as `execute()`. It differs only after spawn:
stdin stays open for bounded `write()` calls, and separate stdout/stderr chunks
are exposed as a bounded async event stream.

Writes are serialized. Their promises resolve when the backend accepts the
bytes, providing backpressure. Per-message, queued-write, and cumulative-write
bounds are enforced before copying; write-after-close is a structured error.
Output events split at a configured byte limit and are retained only within
both event-count and queued-byte bounds. Crossing a queue or output bound
terminates the process and can never produce success.

Call `closeStdin()` when the protocol is finished, `terminate()` to cancel, or
`close()` to end the session. Each is idempotent and the first terminal outcome
wins. Closing the parent broker closes every active duplex session before the
backend is released.

## Contract suites

`@ai-dev-os/process-broker/testing` exports
`runProcessBrokerContractSuite`, `runDuplexProcessSessionContractSuite`, and
`runSandboxBackendContractSuite`. Any future secure backend is held to the same
behaviour as the unsafe development backend it replaces.

## Coverage note

The function-coverage threshold is 90 rather than 98 because process-tree
termination is platform-split by construction: the POSIX process-group path
cannot execute on Windows and the Windows `taskkill` path cannot execute on
Linux. Each is covered on its own platform by the CI matrix. This follows the
precedent set by `@ai-dev-os/provider-ollama`.
