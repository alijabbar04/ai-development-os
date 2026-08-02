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
- A child environment constructed from empty, never inherited.
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
spawn the broker resolves the path, refuses link and reparse indirection,
checks the file type, verifies the digest, and binds the normalized executable
and argument digest into the policy subject.

**Honest limitation.** On a same-user backend the digest check is
time-of-check/time-of-use only. A process running as the same user can replace
the image between verification and execution. The check raises the cost of
substitution and produces audit evidence; it is not a boundary. A secure
backend supplies an immutable mount or backend tool reference, and *that* is
the enforcing mechanism.

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

## Contract suites

`@ai-dev-os/process-broker/testing` exports `runProcessBrokerContractSuite` and
`runSandboxBackendContractSuite`. Any future secure backend is held to the same
behaviour as the unsafe development backend it replaces.

## Coverage note

The function-coverage threshold is 90 rather than 98 because process-tree
termination is platform-split by construction: the POSIX process-group path
cannot execute on Windows and the Windows `taskkill` path cannot execute on
Linux. Each is covered on its own platform by the CI matrix. This follows the
precedent set by `@ai-dev-os/provider-ollama`.
