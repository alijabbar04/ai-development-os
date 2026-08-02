# @ai-dev-os/providers

Provider-neutral contracts for the two ways AI Development OS consumes
models: **inference providers** (chat, reasoning, structured output, tool
use) and **coding-agent providers** (repository-operating systems such as
Claude Code). Includes the request/result envelopes, the streaming event
model, the operation machinery that enforces stream/result invariants, the
error and retry taxonomy, and the reusable contract suites at `./testing`.

No provider SDK, HTTP client, process library, or filesystem API is
imported anywhere in this package — it is pure contracts plus validation,
built on the Stage 2 domain vocabulary.

## The inference / coding-agent boundary

These are deliberately **two contracts, not one**. An inference call maps
messages to assistant output inside a request/response envelope; a coding
agent operates on a workspace under granted capabilities and produces
patches, test results, and artifacts. They share identity, capabilities,
health, trace metadata, usage/cost, errors, cancellation, and the event
envelope — but their requests, results, and event vocabularies are
separate, because pretending a repository-editing agent is a chat model
hides exactly the differences policy needs to see.

## Operation, streaming, and result semantics

`start(request)` returns a `ProviderOperation`:

```ts
const operation = await provider.start(request);
for await (const event of operation.events()) { ... }   // single-use
const result = await operation.result;                    // agrees with terminal
```

- Events carry `schemaVersion`, `operationId`, `sequence` (starts at 1,
  increments by exactly 1, no gaps or duplicates), a clock-supplied
  non-decreasing `occurredAt`, trace metadata, a finite `kind`, and a
  validated payload.
- **Exactly one terminal event** (`operation-completed` / `-failed` /
  `-cancelled`) ends every stream; nothing may follow it.
- `result` resolves on completion, rejects with a `ProviderError` on
  failure, and rejects with `CANCELLED` on cancellation — always in
  agreement with the terminal event. Draining the stream is not required:
  events are buffered (bounded at 10 000; exceeding it is a protocol
  violation), so backpressure from a slow consumer never stalls the
  provider. The result promise never causes unhandled rejections.
- Usage events are **cumulative snapshots**, never deltas; totals must be
  non-decreasing.

Two enforcement layers:

- `createOperationController` — adapters and fakes emit through it, so
  sequencing, single-terminal, and result agreement hold by construction.
- `guardProviderOperation` — consumer-side wrapper that re-validates every
  event and the result value, so **a transport-level success can never
  bypass validation** (the orchestrator always wraps adapter operations).
  Full stream/terminal/result agreement checking requires draining the
  stream; the result value alone is schema-validated regardless.

## Tool contracts

`ToolDefinition` (name, description, JSON-schema input contract, `ToolRisk`,
`ToolApprovalRequirement`, `ToolExecutionLocation`), `ToolChoice`,
model-generated `ToolInvocation`, and caller-provided `ToolResult` are all
validated value objects. Invocations appear only in assistant messages and
results only in tool messages; a result must answer a previously seen
invocation id. **Nothing in this package executes tools** — an invocation
is an explicit request handed to a later, policy-enforcing execution layer.

## Cancellation and deadlines

- `cancel()` is idempotent; the **first terminal outcome wins** every race
  (cancel after completion is a no-op; completion after cancel is dropped).
- `deadline` is an absolute canonical ISO instant: expired before start →
  `start()` rejects `DEADLINE_EXCEEDED`; expired mid-stream → terminal
  `operation-failed` with the same code.
- `close()` cancels active operations with reason `provider-closed`,
  settles them, is idempotent, and `start()` afterwards rejects
  `PROVIDER_CLOSED`.
- `AbortSignal` (structurally typed, no platform lib needed) is accepted as
  an integration mechanism mapping to `cancel("caller-aborted")`.
- `ProviderCapabilities.cancellation` declares `guaranteed`/`best-effort`/
  `none` so adapters can report when remote cancellation is uncertain.

## Capabilities and data policy

`ProviderDescriptor` is immutable: identity, locality, retention/training
behavior, supported Stage 2 data classifications, and instance
`ProviderCapabilities`. Models are Stage 2 `ModelCapabilities` wrapped in
`ModelDescriptor` with availability; **effective capability = instance AND
model** (`combinedCapability`). Requests carry a `DisclosureContext`
(classification, required locality, redaction flag, decision reference,
retention/logging restrictions); providers must reject classifications and
localities they cannot honor (`POLICY_DENIED`) — the fakes prove disallowed
data never gets in. Extensibility is only via bounded, namespaced,
validated `ProviderExtension` records that unknown providers must reject.

## Usage, cost, and budgets

Requests carry `EstimatedUsage` (estimates never mix with actuals); results
carry `ProviderUsage` (Stage 2 token categories + tool calls) and
`ProviderCost` (`providerReported` and `locallyComputed`, both Stage 2
integer-micro `Money`; both null = unknown). This is exactly what a later
scheduler needs to reconcile Stage 2 budget reservations.

## Errors and retries

`ProviderError` carries a stable code (21 codes from `INVALID_REQUEST` to
`INTERNAL_FAILURE`), a `RetryDisposition` (strategy, minimum delay,
provider retry-after, request reusability, may-still-be-running,
idempotency requirement), optional `RateLimitInformation`, operation and
trace ids, and a non-secret cause category. Details never contain keys,
headers, bodies, command output, paths, or environment values.
`defaultRetryDisposition` provides conservative per-code defaults; no retry
loop exists in this stage.

## Contract suites

`@ai-dev-os/providers/testing` exports `runInferenceProviderContractSuite`
and `runCodingAgentProviderContractSuite` (vitest is an optional peer).
Harnesses map named scenarios (`basic-text`, `single-tool-call`,
`deadline-mid-stream`, `malformed-stream`, `secret-probe`, ...) to a
provider + request pair; assertions are structural (stream/result
cross-consistency through the guard), never tied to model text — so the
same suites verify the Stage 5 fakes today and the concrete Ollama /
Claude Code / OpenAI adapters later.

## Security considerations

Every boundary is runtime-validated with the Stage 2 toolkit: finite
unions, bounded text, canonical JSON, prototype-pollution-safe records,
exact integers, canonical timestamps. Binary content travels as Stage 4
artifact references, never inline base64. Errors and observability records
(`ProviderOperationRecord`) never contain prompts, tool arguments, command
output, or artifact content. No console logging.

## Known limitations

- Full result/terminal agreement is verifiable only when the stream is
  drained (result values are schema-validated regardless) — documented on
  `guardProviderOperation`.
- The portable sampling surface is deliberately small (temperature, topP,
  seed, stop sequences, max output); everything else is a namespaced
  extension.
