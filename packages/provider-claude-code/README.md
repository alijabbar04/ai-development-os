# @ai-dev-os/provider-claude-code

A Claude Code coding-agent adapter behind the Stage 5 `CodingAgentProvider`
contract. It probes the installed Claude Code CLI, runs it non-interactively
inside a Stage 8 managed workspace through the Stage 8 process broker, parses
its machine-readable stream, reconciles the workspace against what actually
changed, and reports usage, cost, and capacity without inventing anything.

Two rules shape the whole package:

- **The workspace is authoritative.** Nothing Claude says about files, commits,
  or tests is believed. Every reported change comes from Git plumbing run
  against the managed private worktree.
- **The operation settles once.** Success, refusal, failure, cancellation,
  deadline, and malformed output all run reconciliation and produce exactly one
  terminal event that agrees with the result promise.

## Production status

**Autonomous production execution refuses before the Claude process starts.**

Stage 8 ships no backend classified `secure-enforcing`. The Windows, Linux, and
macOS backends are honest probe seams that refuse to spawn, and the only backend
that runs anything is `unsafe-development-current-user`, which provides process
supervision and **no security containment**. The Stage 8 admission gate
therefore refuses every production-mode invocation, and this adapter does not
weaken, catch, retry around, or relabel that refusal. A test arms a start marker
in the fake CLI and proves the marker is never written in production mode, with
a development-mode positive control proving the marker genuinely fires.

Development mode runs, and every result from a non-`secure-enforcing` backend
carries a warning naming the backend and its security class.

## Responsibility and dependency boundaries

Depends only on `@ai-dev-os/domain`, `@ai-dev-os/artifacts`,
`@ai-dev-os/providers`, `@ai-dev-os/process-broker`, and
`@ai-dev-os/workspace`. It does not depend on the application, router,
scheduler, desktop, API server, or any concrete persistence or secret backend.

Everything else arrives as a narrow composition port: policy, artifact
persistence, workspace resolution, clock, scheduler, UUID generation, and
process execution. There is exactly one execution seam — `ClaudeExecutionPort`,
backed by `createBrokerExecutionPort` — and **no `child_process` call anywhere
in this package**, including the version probe.

## Configuration

`ClaudeAdapterConfiguration` is versioned, runtime-validated, and deeply frozen.
It covers the trusted executable descriptor, CLI compatibility floor, permitted
models and effort levels, turn and budget ceilings, deadlines, output and stream
bounds, diagnostic and patch limits, session-persistence policy, capacity
staleness, authentication classification, supported data classifications, and
endpoint classification.

Monetary caps are **integer micro-dollars**. The only floating-point number in
the money path is the one Claude reports, converted once and defensively at the
boundary; anything non-finite, negative, or unrepresentable is rejected.

Several things are unrepresentable rather than defaulted off — there is no field
that turns them on, so no configuration document can enable them:

| Rejected | Why |
| --- | --- |
| `apiKey`, `token`, `credential`, `apiKeyHelper`, … | Credentials never live in configuration |
| `args`, `argv`, `additionalArguments` | The adapter owns the complete argument vector |
| `shell`, `command`, `commandLine` | Shell execution is not representable |
| `bypassPermissions`, `permissionMode`, `autoMode` | Permission bypass is unrepresentable |
| `chrome`, `mcpServers`, `hooks`, `plugins`, `settings` | Ambient customization stays off |
| `advisor`, `fallbackModel`, `continue` | Not used by this stage |

`resolveClaudeConfiguration` consumes the Stage 6 extension array structurally
(`{ namespace, schemaVersion, value }[]`) without importing `@ai-dev-os/config`.
Foreign namespaces are skipped, the schema version is pinned, and an extension
may not restate identity or the executable. Runtime request extensions may only
tighten a configured limit, never widen one.

`claudeConfigurationFingerprint` is a canonical SHA-256 over the configuration's
meaning, excluding volatile health and capacity data. There is no secret to
exclude: the authentication mode is a category, not a credential.

## Executable discovery and compatibility

The composition layer names an **absolute path to a real image**. There is no
`PATH` lookup at spawn time, and link and reparse indirection is refused.

On Windows a `.cmd`/`.bat` shim is refused by both the configuration parser and
the process broker. If only a shim is installed, discovery returns a structured
unsupported result with installation guidance that contains no filesystem path.
A script entry point is reached the Windows-safe way instead: a trusted
interpreter image plus a pinned argument prefix.

The probe runs `--version` **through the same execution seam** as a session. It
starts no session, sends no prompt, and cannot consume model usage.

The compatibility matrix (`COMPATIBILITY_MATRIX_VERSION = 1`) was written and
verified against **Claude Code 2.1.201** by reading that binary's own `--help`
output. A version newer than the validated ceiling reports
`newer-than-validated` and keeps the last validated capability set — a newer CLI
is assumed to still support what it supported, never to have gained something
the matrix has not seen.

One consequence worth stating plainly: **the 2.1 CLI has no `--max-turns` flag**,
so the matrix records `maxTurns: false` and the adapter enforces the turn
ceiling itself from the stream's own turn accounting rather than claiming a
CLI-enforced cap it does not have.

Required capabilities, without which the adapter refuses to construct an
invocation: print mode, stream-json output, verbose events, safe mode, tool
restriction, disallowed tools, `dontAsk` permission mode, strict MCP
configuration, Chrome disable, and session-persistence control.

## Safe invocation

A fixed argument vector, never a shell string:

```
--print --output-format stream-json --verbose --include-partial-messages
--safe-mode --no-chrome --strict-mcp-config --setting-sources ""
--tools <finite built-in set> --disallowed-tools <web,browser,task,mcp__*>
--permission-mode dontAsk
[--model <validated>] [--effort <validated>] [--max-budget-usd <integer micros>]
--session-id <uuid> | --resume <verified uuid>
[--no-session-persistence]
```

**Task instructions travel on stdin**, not in the argument list. That avoids
command-line length limits, quoting ambiguity, disclosure through the process
list, and any possibility of flag injection.

Every argument is either a literal from this package or a token already
validated against a pattern that cannot produce a leading `-` or a control
character, and a final assertion re-checks that invariant where the vector is
assembled.

`dontAsk` plus a finite `--tools` surface is the mechanism. `--allowedTools` is
deliberately **not** used: an allow-list of tool names is not by itself a tool
restriction, because it does not remove anything.

## Model and effort

A requested model is passed explicitly, validated against both the configured
allow-list and the observed capability profile, and cross-checked against what
the session reports. An alias legitimately resolving to a full identifier is
accepted (`fable` → `claude-fable-5`); anything else is a substitution and
fails with `MODEL_UNAVAILABLE`. **Opus never satisfies a request for Fable, and
the reverse never happens either.** The adapter reports facts; a later router
decides fallbacks.

**Fable versus advisor:** Claude Code distinguishes primary model selection
(`--model`, which accepts `fable`) from advisor selection (`--advisor`, where
Fable may not be available). Stage 9 does not use the advisor feature at all, so
the limitation does not apply here — but it is why `--advisor` is on the refused
list rather than merely unused.

## Permission and command-policy mapping

| Neutral request | Claude surface |
| --- | --- |
| `read-files` | `Read`, `Glob`, `Grep` |
| `edit-files` | adds `Edit`, `Write`, `NotebookEdit`; requires `workspace-write` in the grant |
| `git-commit` | grants no Claude tool; the commit is made by the workspace layer |
| `commandPolicy: none` | `Bash` removed entirely |
| `commandPolicy: allow-listed` | **refused** — see below |
| `commandPolicy: sandboxed` | `Bash`, only with the grant and an explicit backend acceptance |
| `networkPolicy: proxied` | **refused** — no shipped backend can enforce egress |

**Why allow-listed command policy is refused.** The neutral contract names
*executables*. A Claude Bash permission rule is a textual command-prefix glob
over a shell line, and a permitted prefix still admits pipelines, substitutions,
and chained commands. The two are not equivalent, and claiming they are would be
claiming enforcement that does not exist, so the adapter returns
`UNSUPPORTED_CAPABILITY` instead of approximating it.

**Network versus control plane.** Claude's own connection to its service is a
property of the execution backend, not an agent capability. `WebSearch`,
`WebFetch`, Chrome, and every MCP tool are denied, and the descriptor reports
`networkAccess: false`. A secure backend must eventually permit the approved
Claude endpoint while denying other egress; until one exists, proxied *agent*
network access is refused rather than pretended.

**Approvals.** Non-interactive execution can never resolve an approval by
prompting, so approvals are resolved structurally before launch. A conditional
policy decision terminates with `AUTHORIZATION_FAILED` rather than waiting. A
permission denial reported by the session is surfaced as an
`approval-requested` event with a matching `ApprovalDecision`, because a denial
*is* the resolution of an approval request under `dontAsk`. Tool arguments are
never surfaced: the proposed invocation carries argument **key names** only.

## Streaming and event translation

A bounded incremental UTF-8 NDJSON decoder handles arbitrary byte boundaries,
split multi-byte characters, LF and CRLF, blank lines, and a final record with
no trailing newline. stdout and stderr stay separate. Invalid UTF-8 is a
failure, not a replacement character.

Bounds are enforced while decoding rather than after buffering: per-record
bytes, total stream bytes, and record count each stop the parser at the limit.
No error ever contains the offending line.

Records fail closed when they could change completion, permission, usage, tool,
file, or cancellation semantics and are not understood — an unknown top-level
record type, an unrecognized assistant content block, a duplicate terminal
result, a record after the terminal, a mismatched session id, non-monotonic
usage, or a self-contradicting result. An unknown *informational* `system`
subtype produces a bounded compatibility warning instead.

A `system` subtype proving an ambient hook or plugin ran, or an init record
listing a loaded MCP server or plugin, is a hard failure: the session that ran
was not the session that was authorized.

**A zero exit is transport success only.** Without the documented terminal
result record the operation fails with `MALFORMED_RESPONSE`.

Events map onto the Stage 5 coding-agent vocabulary through the Stage 5
operation controller, so sequences start at 1 and increment by exactly one,
timestamps come from the injected clock, usage snapshots are cumulative, exactly
one terminal event exists, the result settles without draining the stream, and
unread buffering stays bounded. Hidden reasoning is acknowledged and discarded;
it never reaches answer, status, diagnostic, or command text.

## Workspace reconciliation

Before launch the adapter resolves the workspace by id and verifies the lease,
the grant, the base revision, and that the root is a managed private worktree
rather than the user's source tree.

After **every** terminal path it re-inspects the workspace and computes the
actual added, modified, deleted, and renamed files through
`@ai-dev-os/workspace`. Each path is checked against the request prefixes, the
grant's writable prefixes, administrative state, hostile shapes, and link or
reparse escape — the last against the live filesystem, not only against what Git
recorded, because a junction created after staging would not appear as a symlink
entry.

A violation fails the operation even when the session reported success.
Violations are reported as counts by category and never as paths. A partial edit
left behind by a failed or cancelled run is detected and **preserved**, so the
later scheduler can retry, continue, or dispose of it.

A commit is created only from verified state — capability granted,
reconciliation clean, changes present — through the workspace layer's safe
commit facility, which runs no hook, signing program, editor, or credential
helper. `resultRevision` comes from that verified commit; a hash printed in
Claude's output is ignored.

## Artifacts

Produced through the provider-neutral artifact interface: a canonical patch (from
the reconciled workspace, never from a message), a bounded command log (tool
names, target paths, and argument **key names** only), redacted diagnostics from
stderr, a machine-readable test report, and session metadata when policy permits.
Raw transcripts are never persisted. If persistence is denied, the adapter still
returns a valid result and writes the content nowhere else.

**Test results require machine-verifiable evidence.** Claude saying "all tests
passed" produces nothing. Structured `testResults` appear only when a strict
machine-readable report exists at the configured workspace path; a malformed
report yields null rather than a guess.

## Session persistence and resume

Sessions are ephemeral by default: `--no-session-persistence` is sent unless
continuation was explicitly requested **and** policy, configuration,
authentication mode, and retention all permit it.

`--continue` is never used. It resolves against the current directory rather
than a verified lineage, so it can silently attach an attempt to the wrong
conversation.

Resume accepts only this adapter's own opaque token. The token carries the
session id and expiry; the provider instance, project, workspace, snapshot
lineage, model, effort, and configuration fingerprint are bound into digests the
verifier recomputes from the context it is resuming into. A token therefore
cannot be edited to point at another project, workspace, or model, and it
discloses none of them. Policy is checked before the token is parsed at all.

## Usage, cost, and capacity

Token categories map onto the Stage 2 disjoint vocabulary: Claude's
`input_tokens` plus `cache_creation_input_tokens` become `inputTokens` (cache
creation is billed as input), `cache_read_input_tokens` becomes
`cachedInputTokens`, and `reasoningTokens` stays **zero** because this surface
does not report one. Usage snapshots are cumulative and reconciled, never
summed, so partial-stream and terminal values cannot double count. A snapshot
that goes backwards fails the operation.

**Cost semantics are explicit:**

| Authentication mode | `total_cost_usd` maps to |
| --- | --- |
| API key, cloud provider, enterprise gateway | `cost.providerReported` (a real charge) |
| Personal subscription login | `UNKNOWN_COST`; the figure travels only as an observation |

A subscription figure is an API-equivalent estimate for work billed a different
way. Presenting it as a charge would be false, and the neutral cost contract has
no field for the distinction, so the cost is reported unknown.

Capacity observations come only from a **host-supplied** Claude status document
(the documented status-line JSON). This package never scrapes terminal output,
never reads or edits the user's global Claude settings, and never installs a
collector. Missing quota data is `unknown`, never zero; a reset time that was
not observed is `null`; and an observation past its staleness window reports
`stale` rather than claiming to be current. Refreshing a quota figure consumes
no model usage.

## Cancellation and lifecycle

Cancellation propagates through the abort signal to the process broker and its
process-tree termination. It is idempotent, the first terminal outcome wins
every race, and pre-start, mid-stream, post-edit, and during-reconciliation
cancellation are all covered.

The result settles as soon as cancellation wins; adapter-owned cleanup
(reconciliation, observation) finishes in the background, and `close()` waits
for it. `close()` prevents new starts, cancels active operations as
provider-closed, is idempotent, and does not delete unrelated workspace state.

The unsafe backend cannot prove a process tree is gone, so the descriptor
reports `cancellation: "best-effort"` and a run whose tree could not be
confirmed terminated carries that evidence in its warnings and observation.

## Authentication boundary

Anthropic's published position is that products built on Claude should use
API-key authentication and must not offer Claude.ai login or route Free, Pro, or
Max subscription credentials on a user's behalf. This adapter respects that as a
mechanism, not just a note:

- It never reads, parses, copies, exports, logs, serializes, or returns a Claude
  credential file, OAuth token, session cookie, API key, or credential-helper
  output.
- There is no "paste your Claude subscription token" field or contract.
- Credentials never appear in argv, prompts, configuration, artifacts, logs,
  errors, event payloads, fingerprints, or test snapshots.
- Secret-backed environment bindings carry only a reference fingerprint and are
  resolved by the Stage 8 secret resolver after policy approval, immediately
  before process creation.
- A personal installed-CLI login is refused unless the caller passes an explicit
  development-canary opt-in, and it is never a distributable mechanism.

There is a mechanical consequence worth knowing: the process broker builds the
child environment from an empty baseline rather than inheriting the caller's
environment. After admission it supplies a fresh broker-owned session home as
`HOME` on POSIX or `USERPROFILE` on Windows; the opposite name,
`HOMEDRIVE`/`HOMEPATH`, and XDG profile redirectors are absent for this adapter.
Requests cannot override those names as ordinary or secret bindings. This stops
the CLI's default home lookup from discovering the invoking user's installed
OAuth login, while an explicitly authorized API-key binding is still resolved
after policy approval and supported.

That environment boundary is not filesystem isolation. The unsafe development
backend still runs as the invoking user and can open any absolute path that user
can open. A personal installed-CLI login therefore remains an explicit local
development canary outside the distributable authentication modes; the live task
canaries require an API key.

If authentication cannot be supplied without crossing the boundary, the adapter
returns `AUTHENTICATION_FAILED` with safe metadata and human-action retry
guidance.

## Observability

Structured, bounded observations cover the probe outcome and tier, operation
start and terminal category, requested versus observed model and effort,
permission profile category, tool counts, changed-file count, artifact
categories, backend id and security class, usage totals, cost-known versus
cost-unknown, capacity status, latency, retry category, cancellation and
deadline category, reconciliation outcome, and termination confirmation.

Prompts, source code, patches, secret values, environment bindings,
authentication identifiers, full user paths, raw Claude events, raw stderr, tool
arguments, hidden reasoning, and transcripts are absent by construction — no
field of any observation can hold them. There is **no console logging anywhere
in this package**. An observer that throws is contained, and the thrown value is
deliberately not inspected so a hostile observer cannot use its own exception as
a channel.

## Testing

`npm test` runs 255 deterministic tests plus 7 opt-in live canaries that are
skipped without an explicit opt-in.

The fake CLI is a **real executable**, reached through a trusted `node` image
plus a pinned script argument — no `.cmd` shim and no shell — driven through the
real process broker over the real unsafe development backend, against a real
managed private worktree of a real temporary Git repository.

Fixtures that arm hostile behaviour include positive controls proving the
fixture genuinely fires in the corresponding unsafe condition, so a "no marker
appeared" assertion is never vacuous.

### Live canaries

Opt-in, never run by default, never consume Claude usage without an explicit
opt-in:

```bash
# Probe only (consumes no model usage):
AI_DEV_OS_CLAUDE_LIVE_EXECUTABLE=/absolute/path/to/claude \
AI_DEV_OS_CLAUDE_LIVE_OPT_IN=i-understand \
npm test

# Task canaries additionally require an API key:
AI_DEV_OS_CLAUDE_LIVE_API_KEY=sk-ant-... \
AI_DEV_OS_CLAUDE_LIVE_MODEL=claude-fable-5 \
npm test
```

Canaries run in a disposable temporary repository the harness creates — never
the AI Development OS worktree, never the user's repository. Turns, budget,
output, changed files, and deadlines are capped; no remote is created; the
user's global Claude configuration is never read or modified; and the test names
say the backend is unsafe.

## Example

```ts
import { createProcessBroker, createUnsafeDevelopmentBackend, UNSAFE_BACKEND_ID }
  from "@ai-dev-os/process-broker";
import {
  createBrokerExecutionPort,
  createClaudeAdapterConfiguration,
  createClaudeCodeProvider,
  createClaudeWorkspaceHandle,
} from "@ai-dev-os/provider-claude-code";

const configuration = createClaudeAdapterConfiguration({
  instanceId: "claude-code-1",
  executable: {
    toolId: "claude-code",
    executablePath: "C:/Users/you/.local/bin/claude.exe",
    platform: "win32",
    architecture: "x64",
    expectedDigestHex: null,
    immutableReference: null,
    containmentRoot: null,
    pinnedLeadingArguments: null,
  },
  permittedModels: ["claude-fable-5"],
  permittedEffortLevels: ["high"],
  maxTurns: 8,
});

const workspace = createClaudeWorkspaceHandle({ runtime, record, lease, grant, paths });

const provider = createClaudeCodeProvider({
  configuration,
  execution: createBrokerExecutionPort({ broker, configuration, grant, lease, /* … */ }),
  workspaces: { resolve: async (id) => (id === record.workspaceId ? workspace : null) },
  artifacts,
  policy,
  backend: {
    backendId: UNSAFE_BACKEND_ID,
    securityClass: "unsafe-development",
    commandExecutionAllowed: false,
  },
});

const operation = await provider.start(request);
for await (const event of operation.events()) {
  // operation-started, status-update, tool-call-started, output-chunk,
  // file-change-applied, patch-produced, usage-update, warning, terminal…
}
const result = await operation.result;
```

## Security considerations

Proven by the test suite: no shell string is constructed; no `.cmd`/`.bat` is
accepted on Windows; instructions, model ids, and resume tokens cannot inject
flags; file paths cannot escape the managed worktree; MCP tools and Chrome are
absent; ambient hooks, plugins, skills, agents, commands, settings, and memory
are disabled; `bypassPermissions` and auto mode are unrepresentable;
`allowedTools` is not mistaken for a restriction; production refusal happens
before spawn; a denied session never reaches secret resolution; secrets stay out
of argv, output, errors, artifacts, observations, and fingerprints; cancellation
reaches the broker; partial edits are detected; Claude-reported changed files
and commit ids cannot override reconciliation; the source repository stays
byte-for-byte unchanged with no remote; unknown state-changing records fail
closed; model substitution is detected; subscription estimates are not labelled
as billed cost; and missing quota data stays unknown.

## Known limitations

- **No containment.** No shipped backend is `secure-enforcing`; production
  execution refuses, and development mode has no security boundary.
- **`commandPolicy: "allow-listed"` is unsupported** and returns
  `UNSUPPORTED_CAPABILITY` rather than a weaker glob approximation.
- **`networkPolicy: "proxied"` is unsupported** until a backend can enforce
  egress.
- **Turn limiting is adapter-side**, because the 2.1 CLI has no `--max-turns`.
  A turn ceiling is enforced by aborting the run, not by the CLI refusing.
- **Test results need a workspace report** at the configured path; Claude's
  narrative is never accepted as evidence.
- **Subscription cost is never reported as a charge**, so cost is unknown under
  a personal login.
- **Capacity requires a host-supplied snapshot**; nothing is collected
  automatically, and absent data stays unknown.
- **Reasoning is discarded**, not surfaced, because the neutral coding-agent
  contract has no disclosure-checked channel for it.
- **The executable digest check is time-of-check/time-of-use** on a same-user
  backend, as Stage 8 documents; it is audit evidence, not a boundary.
