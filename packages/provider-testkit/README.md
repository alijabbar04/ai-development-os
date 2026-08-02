# @ai-dev-os/provider-testkit

Deterministic fake providers implementing the `@ai-dev-os/providers`
contracts, plus the manual scheduler and the standard scenario harnesses
that drive the reusable contract suites. Every provider behavior in the
system can be exercised with zero network access and zero paid tokens.

## Scripting model

Fakes are driven by **immutable script data** — no model inference, no
randomness, no shared mutable state:

```ts
import { createFakeInferenceProvider, createManualScheduler } from "@ai-dev-os/provider-testkit";

const provider = createFakeInferenceProvider({
  scheduler: createManualScheduler(),          // virtual time; no real sleeps
  script: {
    steps: [
      { kind: "usage", inputTokens: 10, outputTokens: 0 },
      { kind: "text", text: "streamed reply", chunkSize: 4 },
      { kind: "tool-call", toolName: "read-file", arguments: { path: "a.ts" } },
      { kind: "delay", ms: 60_000 },           // fires when tests advance the clock
      { kind: "usage", inputTokens: 10, outputTokens: 20 },
    ],
  },
});
```

Inference steps: `text`, `structured`, `tool-call`, `usage` (cumulative
snapshots), `warning`, `delay`, `fail`, `finish`, plus `rejectStart` and a
`rawStream` mode that emits arbitrary events verbatim for contract-negative
tests (sequence gaps, terminal/result mismatch) — proving that
`guardProviderOperation` catches misbehaving transports.

Coding-agent steps: `status`, `workspace-read`, `tool-proposal`, `output`,
`file-change` (proposed/applied), `patch`, `test-run`, `approval`, `usage`,
`warning`, `delay`, `fail`, `finish`; plus `unavailableWorkspaces`,
`grantedCapabilities`, and `rejectStart` provider options.

Identical scripts with identically seeded schedulers replay into
byte-identical event streams (sequential operation ids, virtual
timestamps) — verified by a replay test.

## Determinism

`createManualScheduler()` is a combined clock + timer queue: `wait(ms)`
resolves only when tests `advance(ms)` virtual time, which is how deadline
expiry, lease-style pauses, and cancellation races are tested without a
single real sleep. `createImmediateScheduler()` resolves waits on a
microtask while still advancing the virtual clock. Cancellation wakes
paused scripts immediately.

## Policy assertions and request capture

The fakes validate every request with the real contract parsers and then
enforce their declared policy surface: unsupported classifications →
`POLICY_DENIED` (before capture, proving disallowed data never reached the
provider), local-only disclosure on cloud instances → `POLICY_DENIED`,
undeclared capabilities → `UNSUPPORTED_CAPABILITY`, unknown extension
namespaces → `UNSUPPORTED_CAPABILITY`, unknown models →
`MODEL_UNAVAILABLE`. `capturedRequests` exposes the frozen validated
requests; `capturedSummaries()` gives secret-safe summaries (ids, model,
classification, counts — no content).

## Standard harnesses

`createStandardInferenceHarness()` and `createStandardCodingAgentHarness()`
implement every scenario the contract suites require and are how this
package runs both suites against the fakes. Concrete adapter packages
(Stages 7/9/10) implement the same harness shape over their real
transports and reuse the identical suites.

## Known limitations

- These are in-process fakes. The roadmap's process-level fake server /
  fake CLI harnesses arrive with the concrete adapters, where transport
  parsing exists to exercise.
- Fake cost reporting uses the Stage 2 pricing metadata of its model
  catalog (`locallyComputed`); `providerReported` stays null unless
  scripted.
