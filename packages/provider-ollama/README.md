# @ai-dev-os/provider-ollama

Native Ollama inference adapter and local capacity manager for AI Development
OS. It implements the Stage 5 `InferenceProvider` contract over Ollama's
native local HTTP API and adds the Stage 7 local-model machinery: a
digest-validated model catalog, capability normalization with provenance,
configurable role preferences with capability-aware local fallback, a
deterministic capacity semaphore, keep-alive/residency planning, and bounded
resource telemetry.

## Responsibility and dependency direction

This package depends only on `@ai-dev-os/domain` (validation, canonical JSON,
Stage 2 capability vocabulary) and `@ai-dev-os/providers` (the provider
contracts and operation machinery). It integrates with `@ai-dev-os/config`
structurally — `resolveOllamaConfiguration` consumes the Stage 6
provider-instance extension shape without importing the package. Nothing here
depends on concrete providers, workspaces, schedulers, routers, persistence,
or UI. Global local-versus-cloud routing, tool execution, and durable
scheduling belong to later stages.

## Native API surface

The transport reaches exactly six documented native endpoints, resolved from
a fixed table plus the validated loopback base URL (caller-supplied paths are
unrepresentable):

| Purpose | Endpoint |
| --- | --- |
| Installed models | `GET /api/tags` |
| Model details/capabilities | `POST /api/show` |
| Running models (telemetry) | `GET /api/ps` |
| Streaming chat | `POST /api/chat` |
| Load/unload (keep-alive) | `POST /api/generate` (empty prompt) |
| Compatibility/health | `GET /api/version` |

The native API (not the OpenAI-compatibility layer) is used because it
exposes model capabilities, digests, thinking controls, keep-alive, and exact
nanosecond duration/token counters that Stage 7 needs. Model-management
operations (`pull`, `delete`, `copy`, `create`, `push`) are deliberately
unreachable: the adapter can never download or remove model data.

## Loopback-only security

`parseOllamaEndpoint` accepts ONLY literal loopback endpoints:

- `http://` + an IPv4 address in `127.0.0.0/8`, written as plain dotted
  decimal without leading zeros, or
- `http://[::1]`,
- with an optional port, and nothing else.

Rejected: `localhost` and every DNS name (resolution/rebinding ambiguity),
`0.0.0.0`, `::`, IPv4-mapped IPv6 (`::ffff:127.0.0.1`), LAN and public
addresses, octal/hex/integer host tricks (`0177.0.0.1`, `2130706433`),
non-http schemes, URL user information, query strings, fragments, and base
paths. The raw string is validated by a strict grammar first and then
cross-checked against the WHATWG URL parser, so parser normalization cannot
launder an encoded host through validation.

The production transport uses `redirect: "manual"` and rejects any 3xx
status before a second request exists, consults no ambient proxy
configuration, sends no credentials, and reads error bodies only within a
16 KiB bound for classification (they are never propagated). Response header
sizes are bounded by the Node fetch implementation's own limits, not by this
package.

## Configuration

`createOllamaAdapterConfiguration` (defaults) / `parseOllamaAdapterConfiguration`
(strict) validate an immutable configuration:

| Field | Meaning | Default |
| --- | --- | --- |
| `instanceId` | Provider instance identity | required |
| `endpoint` | Literal loopback base URL | required |
| `requestTimeoutMs` | Absolute per-request bound (100–3 600 000) | 300 000 |
| `discoveryTimeoutMs` | Per discovery/health request (100–600 000) | 10 000 |
| `keepAlive` | `unload-immediately` \| `retain{durationMs}` \| `keep-loaded` | retain 5 min |
| `maxConcurrentOperations` | Global semaphore (1–64) | 2 |
| `perModelConcurrency` | `{model, limit}` list | `[]` |
| `capacityBudgetBytes` | Byte budget for admissions | null (off) |
| `capacitySafetyMarginBytes` | Reserve subtracted from the budget | 0 |
| `queueLimit` | Bounded admission queue (0–1000) | 16 |
| `admissionTimeoutMs` | Queue wait bound; null disables | 60 000 |
| `digestPins` | `{model, digest}`; mismatch makes the model ineligible | `[]` |
| `modelAllowlist` / `modelDenylist` | Explicit eligibility control | null / `[]` |
| `rolePreferences` | See below | `[]` |
| `capabilityOverrides` | Restrictive-only per-model denials/bounds | `[]` |
| `supportedClassifications` | Stage 2 classifications accepted | all five |

Rejected inputs include unknown fields, prototype-pollution keys, inline
credentials or user-info in URLs, fragments/queries/paths, invalid durations
and unsafe integers, duplicate model rules, malformed digest pins, and a
safety margin that consumes the whole budget. Generation options are the
finite contract set (`temperature`, `topP`, `seed`, `maxOutputTokens`,
`stopSequences`); nothing else is forwarded.

Stage 6 integration: `resolveOllamaConfiguration({instanceId,
endpointBaseUrl, extensions})` reads the `ollama` namespace extension
(schema version 1) from a provider-instance configuration. The extension
value must not repeat `instanceId`/`endpoint`.

### Request extensions

Requests may carry extensions in the `ollama` namespace only:

- `think`: `true`/`false` or `"low" | "medium" | "high" | "max"` — maps to the
  documented `think` parameter. Boolean and level controls do NOT behave
  identically across families (e.g. gpt-oss requires levels and cannot fully
  disable its trace).
- `disclose-reasoning`: boolean (default `true`). When `false`, reasoning is
  never emitted as events and never appears in results, observations, or
  errors.

Unknown namespaces and keys are rejected, never ignored.

## Discovery, digests, and the catalog

`discoverOllamaCatalog` combines `/api/tags`, per-model `/api/show`, and
`/api/ps` into an immutable, name-sorted catalog. Each entry carries the
validated name, normalized sha256 digest, size, modified time, format,
family/families, parameter size, quantization, reported capability tokens,
normalized capabilities with per-field provenance, context length (from
`model_info` `<architecture>.context_length`), running flag, digest-pin
status (`none | matched | mismatched | unverifiable`), and stable
ineligibility reason codes. Templates, licenses, modelfiles, parameter
dumps, and token tables are never extracted or retained.

The catalog `fingerprint` is a sha256 over the canonical entries with the
volatile `running` flag removed: identical installed catalogs produce
byte-identical fingerprints regardless of server response ordering.

A configured digest pin that does not match makes the model ineligible
(`digest-mismatch`, retry `human-action`). Models with malformed digests,
missing `/api/show` details, no completion capability, or names outside the
domain `ModelId` grammar (e.g. registry names containing `/`) are catalogued
but ineligible, each with a stable reason code. Ollama does not echo digests
on chat responses, so digest identity is enforced at selection/start against
the latest catalog snapshot; this limitation is inherent to the wire
protocol.

## Capability normalization

Sources in conservative order: (1) explicit `/api/show` capability tokens
(`completion`, `tools`, `thinking`, `vision`, `embedding`), (2) validated
model metadata (context length), (3) versioned family knowledge
(`OLLAMA_FAMILY_KNOWLEDGE_VERSION`) used ONLY for the coarse Stage 2
rating/latency fields that Ollama does not report, (4) restrictive
configuration overrides. Capability probes are not implemented. Structured
output and streaming are derived from the completion capability because the
server enforces `format` grammars for every completion model. Unknown
capabilities stay unsupported; configuration can only restrict, never
manufacture, a capability. Per-field provenance (`reported | derived |
family-knowledge | configuration-restricted | unknown`) is recorded so later
routing can explain eligibility.

## Role preferences and local selection

`selectOllamaModel(catalog, configuration, {role, requirements})` performs
deterministic, explainable, capability-aware LOCAL selection using the
shared role vocabulary (`planning`, `implementation`, `review`,
`documentation`, `testing`, `explanation`). A preference ranks exact model
names first, then families (never name substrings), and can require
reasoning/structured-output/tools/vision, minimum context, maximum size,
allowed quantizations, and a matched digest pin. The result contains the
selected identity and digest, matched role/preference rank, capability
evidence with provenance, every rejected candidate with sorted stable reason
codes, fallback status, and the catalog fingerprint. When nothing qualifies
it returns a structured `no-eligible-local-model` for the later router —
Stage 7 never routes to cloud providers.

## Provider lifecycle and streaming

`createOllamaProvider({configuration, transport?, scheduler?, observer?,
ollamaObserver?})` returns an `InferenceProvider` (descriptor: inference,
local, non-retaining, non-training) plus local extras (`refreshCatalog`,
`catalogSnapshot`, `runningModels`, `inspectHealth`, `selectModel`,
`capacitySnapshot`, `ownedModels`, `preloadModel`, `planResidency`,
`applyResidencyPlan`).

`start()` validates the request, checks the model's eligibility and
capabilities, enforces the deadline, acquires a capacity lease (cancellable
while queued via the start signal), performs the chat request, and returns
the operation once response headers arrive — so pre-stream failures (429,
missing model, refused connection) reject `start()` with their mapped codes.

Streaming uses a bounded incremental NDJSON parser (LF/CRLF, UTF-8 splits,
blank lines, per-record/aggregate/record-count bounds) and validates every
record: model identity must match the request, `message.content` becomes
`text-delta` (or `structured-output-delta` in structured mode),
`message.thinking` becomes `reasoning-delta` (when disclosure permits),
`tool_calls` become validated tool events. Exactly one `done` record must
terminate the stream; duplicates, records after it, truncation, malformed
JSON, invalid UTF-8, oversized lines, and mid-stream `{"error": ...}`
records become structured failures. Every operation stream is `operation-
started`, `message-started`, a zero usage snapshot, deltas, the final
cumulative usage snapshot, `message-completed`, then the terminal event —
sequences and timestamps enforced by the Stage 5 operation controller.

### Structured output

`structuredOutput.schema` maps to the documented `format` field (JSON Schema
mode; `{"type":"object"}` degenerates to plain JSON mode server-side). The
final accumulated text is parsed defensively (prototype-pollution-safe,
bounded at 256 KiB canonical); invalid JSON is a structured
`MALFORMED_RESPONSE` failure. No repair loop exists — repair belongs to the
later evaluation layer.

### Reasoning

Thinking output is emitted as `reasoning-delta` events, strictly separate
from answer text, and never merged into result messages, logged, placed in
health records, retained, or echoed in errors. With
`disclose-reasoning=false` it is fully suppressed. Reasoning token counts
are NOT reported by Ollama (thinking tokens are inside `eval_count`), so
`reasoningTokens` stays 0 rather than being invented.

### Tool calling

Bounded tool declarations map to the native `tools` array. Returned calls
must name a declared tool and carry object arguments within the contract
bounds, or the operation fails with `TOOL_PROTOCOL_FAILURE`. Ollama does not
provide call IDs, so deterministic IDs are derived from the operation ID and
call ordinal. `toolChoice` `"none"` omits tools; `"required"`/`"named"` are
rejected (`UNSUPPORTED_CAPABILITY`) because the server cannot enforce them.
Tools are never executed here.

### Content mapping

`system`/`developer` map to the wire `system` role (documented downgrade);
text parts join with blank lines; `json` parts render as canonical JSON;
assistant tool invocations map to `tool_calls`; tool results map to `role:
"tool"` messages with `tool_name`. `artifact`/`image-artifact` parts are
rejected (`UNSUPPORTED_CAPABILITY`) — Stage 7 has no artifact resolver, so
the descriptor reports `imageInput: false` even for vision models.

## Usage, cost, and telemetry

`prompt_eval_count`/`eval_count` map to input/output tokens exactly;
`cachedInputTokens` and `reasoningTokens` are 0 because the server does not
report them. Cost is the Stage 2 unknown-cost value (`null`/`null`) — no
monetary, CPU, GPU, queue, or memory figures are invented. Nanosecond
duration counters (`total_duration`, `load_duration`,
`prompt_eval_duration`, `eval_duration`) surface through the observability
hook converted to milliseconds and labelled as derived conversions.
`runningModels()` exposes `/api/ps` telemetry (loaded identity, digest,
size, VRAM size, expiry, context length); the reported loaded size is NOT
peak process memory.

Observations (`OllamaObserver`) cover discovery, health checks, admissions,
operations, and residency actions with bounded structural fields only;
standard per-operation records also flow through the Stage 5
`ProviderObserver`. No console logging exists in library code.

## Capacity manager

`createOllamaCapacityManager` enforces the global concurrency limit,
per-model limits, and the byte budget with its safety reserve. Waiters queue
strictly FIFO (deterministic, starvation-free by construction; a blocked
head blocks everything behind it — documented trade-off). Capacity is
evaluated when an entry reaches the head and resources free up, not
snapshotted at enqueue. Queue overflow (`queue-full`), admission timeout,
absolute deadline expiry, cancellation while queued, and close are all
structured rejections. Leases release idempotently; accounting can neither
underflow nor overflow; snapshots are immutable. A model whose size plus
margin exceeds the whole budget is rejected immediately as never-admissible.
Unknown model sizes reserve zero bytes and rely on the concurrency limits.

## Keep-alive, load/unload, and ownership

The configured keep-alive policy maps to the documented wire values
(`0`, `"<seconds>s"`, `-1`) on every chat/generate request. Residency
planning (`planOllamaResidency`) only ever unloads models this provider
instance OWNS (loaded through its own operations or explicit preloads),
never models with active leases or queued work, and never externally
observed models — Ollama cannot attribute a loaded model to a client, so
external models are reported as skipped (`not-owned`). Unloads run through
`POST /api/generate` with an empty prompt and `keep_alive: 0`; explicit
preloads use the configured keep-alive. `applyResidencyPlan` re-checks
active leases at execution time.

## Cancellation, deadlines, and close

Deadlines are enforced before start, while queued for capacity, and
mid-stream (a scheduler-driven race, deterministic under a manual clock).
Cancellation is idempotent, first-terminal-wins, aborts the HTTP response,
and always releases the lease; `close()` cancels active operations as
`provider-closed`, rejects new work, drains pumps, closes the capacity
manager and transport, and is idempotent. The stream and result always agree
(`guardProviderOperation`-compatible); no unhandled rejections escape.

## Error mapping

| Condition | Code (disposition) |
| --- | --- |
| Invalid configuration / unsafe endpoint | `INVALID_REQUEST` (never) |
| Redirect attempted / incompatible API route | `PROTOCOL_VIOLATION` (never) |
| Connection refused / mid-stream disconnect | `NETWORK_FAILURE` (delayed retry, may-still-be-running) |
| Request timeout / admission timeout | `TIMEOUT` (delayed retry) |
| Deadline passed (any phase) | `DEADLINE_EXCEEDED` (never) |
| Cancellation | `CANCELLED` (never) |
| Model missing / ineligible | `MODEL_UNAVAILABLE` (alternate-model) |
| Digest mismatch | `MODEL_UNAVAILABLE` (human-action) |
| Denied by allow/denylist or classification | `POLICY_DENIED` |
| Capability mismatch / unknown extension | `UNSUPPORTED_CAPABILITY` |
| Queue full / local overload / HTTP 502/503 | `PROVIDER_OVERLOADED` (delayed retry) |
| HTTP 429 | `RATE_LIMITED` (retry-after honored) |
| Malformed JSON/NDJSON/stream, truncation, duplicate terminal, model mismatch, invalid structured output | `MALFORMED_RESPONSE` |
| Undeclared tool / invalid tool arguments | `TOOL_PROTOCOL_FAILURE` |
| Server 5xx / mid-stream error record | `INTERNAL_FAILURE` |
| Use after close | `PROVIDER_CLOSED` |

Errors never contain prompts, generated or reasoning text, tool arguments,
raw response bodies, headers, URLs beyond the endpoint name, environment
values, or backend stack traces; server error messages are dropped after
bounded classification.

## Health

`health()` returns the contract `ProviderHealth`; `inspectHealth()` returns
the richer snapshot (`healthy | degraded | overloaded | unavailable |
incompatible | closed`, endpoint family, reachability, API compatibility,
server version, installed/eligible/running counts, digest mismatch count,
capacity utilization, catalog age). Health evidence is structural only.

## Testing

- `test/helpers/fake-ollama-server.ts` — deterministic loopback-only fake
  server (scripted catalogs, streams, holds, disconnects, hostile payloads;
  structural request summaries only; sockets destroyed on close).
- The full Stage 5 inference contract suite runs against the adapter through
  the fake server (`test/contract.test.ts`); the two contract-negative
  scenarios (`malformed-stream`, `terminal-mismatch`) use an explicit
  event-tampering wrapper because the adapter's controller cannot itself
  emit invalid streams.
- Focused suites cover loopback enforcement, NDJSON/wire hostile input,
  discovery/selection determinism, capacity semantics, and adapter
  behaviors. All deterministic tests run on virtual time (no sleeps).
- Live tests (`test/live.test.ts`) are opt-in via
  `AI_DEV_OS_OLLAMA_LIVE_URL` (literal loopback, verified before
  connecting) with an optional `AI_DEV_OS_OLLAMA_LIVE_MODELS` allowlist.
  They never pull/delete/create models, never write to the repository,
  never execute tools, use fixed harmless prompts with low output limits
  and bounded deadlines, and skip honestly when a capability or model is
  absent.

## Example

```ts
import {
  createOllamaAdapterConfiguration,
  createOllamaProvider,
} from "@ai-dev-os/provider-ollama";
import { createInferenceRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";

const provider = createOllamaProvider({
  configuration: createOllamaAdapterConfiguration({
    instanceId: "ollama-local",
    endpoint: "http://127.0.0.1:11434",
    rolePreferences: [
      { role: "planning", families: ["deepseek2", "qwen3"], requireReasoning: true },
      { role: "documentation", families: ["gemma3"] },
    ],
  }),
});

const selection = await provider.selectModel({ role: "planning" });
if (selection.status === "selected") {
  const operation = await provider.start(
    createInferenceRequest({
      requestId: "req-1",
      modelId: selection.model,
      messages: [{ role: "user", parts: [{ type: "text", text: "Outline the plan." }] }],
      disclosure: parseDisclosureContext({
        classification: "internal",
        requiredLocality: "local-only",
        redactionApplied: false,
        decisionRef: null,
        retentionAllowed: false,
        loggingAllowed: false,
      }),
      trace: createTrace("trace-1"),
      extensions: [{ namespace: "ollama", key: "think", value: true }],
    }),
  );
  for await (const event of operation.events()) {
    // text-delta / reasoning-delta / usage-update / ...
  }
  const result = await operation.result;
  void result;
}
await provider.close();
```

## Known limitations

- Digest identity cannot be re-verified per chat response (not on the wire).
- Reasoning/cached token splits are not reported by the server; those
  categories stay 0.
- `imageInput` is disabled until an artifact resolver exists (Stage 8+).
- `toolChoice` `required`/`named` cannot be enforced by the server.
- Ollama cannot attribute externally loaded models, so residency planning
  skips them (`not-owned`) instead of unloading.
- Cancellation is best-effort: aborting the HTTP response stops local
  generation promptly, but the server may finish an in-flight token batch.
- The strict-FIFO queue lets a large admission at the head delay smaller
  ones behind it (deterministic and starvation-free by design).
- An authenticated local gateway (non-loopback) is out of scope for Stage 7
  and would require new, explicitly reviewed endpoint validation.
