# @ai-dev-os/provider-openai

OpenAI **Responses API** implementation of the Stage 5 `InferenceProvider`
contract.

The adapter is a thin, strict, fully injected boundary between the
provider-neutral contracts and one specific HTTPS API. It performs no
ambient I/O, reads no environment variables, opens no files, writes no
logs, and executes no tools.

- Re-verified on 2026-08-03 against the official OpenAI OpenAPI document
  (v2.3.0) and the
  streaming, background, structured-output, function-calling, data-controls,
  safety, and rate-limit guides.
- Every wire field, event name, status value, and error code in this package
  is copied from that document. Nothing is inferred from a model name.

---

## What it supports

| Capability | Status |
| --- | --- |
| Synchronous streaming (SSE) | yes |
| Non-streaming responses | yes (background polling path) |
| Text generation | yes |
| Structured output (`text.format` = `json_schema`) | yes, validated against the caller's schema |
| Custom function tools | yes, caller-executed only |
| Streamed function-argument deltas | yes |
| Usage reconciliation and cost | yes, integer-exact |
| Cancellation | synchronous abort and official background cancel |
| Background create / poll / cancel | yes |
| Background streaming with resume | yes, cursor-bound |
| `previous_response_id` continuation | yes, only when storage is authorized |
| Reasoning effort and summaries | yes, disclosure-gated |
| Image input | yes, only through an injected artifact resolver |
| Rate-limit and request-id capture | yes, as safe structural metadata |

### Deliberately not supported

Hosted tools (web search, file search, code interpreter, computer use,
hosted shell, remote MCP, image generation), audio modalities, Programmatic
Tool Calling, organization usage/cost and administration APIs, and arbitrary
upstream base URLs.

None of these are silently ignored. A hosted-tool request is refused before
any disclosure, and a hosted-tool stream event or output item **fails
closed** rather than being skipped — a dropped item could hide a tool call,
a refusal, a usage figure, or a storage side effect.

---

## The model catalog is data, not code

**This package ships no model identifiers, no context limits, and no
prices.** Model guidance and commercial facts change independently of this
adapter's wire contract. Baking a transient snapshot into code would produce
stale routing decisions and silently wrong bills.

Instead, the operator supplies a dated, provenanced snapshot:

The operator-provided record supplies the opaque model id, context and output
limits, capability evidence, effective interval, and any dated price slices.
The adapter validates and fingerprints that data; it does not fill in a
missing field from a model name.

Properties enforced by `parseOpenAiModelCatalog`:

- capability and limit facts require **provenance** (`evidence.source`, `observedAt`);
- entry and pricing intervals are non-overlapping, with an **exclusive** upper bound;
- selection is by effective instant, so a price change is a new slice, not an edit;
- the catalog carries an immutable **sha256 fingerprint** that is stable across
  key and entry ordering, and a supplied fingerprint that disagrees is rejected;
- configuration overrides are **restrictive only** — they can remove a
  capability or lower a limit, never grant or raise one.

Model ids appear only inside the catalog and the permitted-model list.
Nothing in the domain or routing layers embeds one.

---

## Endpoint policy

The only accepted upstream is the exact first-party server declared by the
OpenAPI document:

```
https://api.openai.com/v1
```

Arbitrary base URLs are **unrepresentable**, not merely validated: the
configuration selects a profile from a fixed table. Non-HTTPS schemes, URL
user information, alternate hosts, non-default ports, query strings,
fragments, alternate paths, and percent-encoded host tricks are all
rejected, and the WHATWG parser must agree exactly with the fixed profile.
Request URLs are built from a fixed route table plus a pattern-validated
response id, so no caller string ever reaches a URL. A 3xx is rejected
before any body is read or any second request is issued.

Curated additional upstreams are Stage 12's concern, not this package's.

---

## Retention is reported honestly

The adapter never claims Zero Data Retention because it sent `store: false`.

- `store` defaults to `false` and becomes `true` only when a policy decision
  explicitly authorizes persistence.
- **Background mode is a retention decision, not a transport detail.** The
  background guide states response data is "temporarily stored to disk for
  roughly 10 minutes to enable asynchronous execution and polling", and that
  Zero Data Retention projects run background requests with `store=false`
  while the data is *still temporarily retained*. Background therefore
  requires its own `temporaryServerStateAllowed` authorization, separate
  from persistence.
- `describeRetention()` reports the configured facts, including the
  temporary-storage window, whether a ZDR arrangement was **declared by the
  operator** (with source and date), and the declared abuse-monitoring
  window. A ZDR claim is only ever an operator declaration with provenance.
- `describe().retainsData` is true whenever this instance *can* cause the
  upstream to hold content — durable persistence or the background window —
  even though individual requests still send `store: false`.
- `previous_response_id` continuation resolves only against a **stored**
  response, so it is gated on the same authorization and is disabled by
  default. Otherwise the caller must replay inputs explicitly.

---

## Security properties

**Credentials.** The API key is a Stage 6 `SecretRef` resolved through the
policy-aware flow immediately before the request, scoped to the callback
that establishes the connection, and never stored, returned, logged, or
placed in configuration, errors, observations, fingerprints, or tests. The
resolver evaluates the `secret-access` decision *before* touching any secret
backend, so a denial provably performs no broker resolve — and because the
port is invoked only at request time, no HTTP call has been made either.
Configuration containing key-shaped material is refused outright.

**Ordering.** Disclosure authorization runs before artifact reads, before
credential resolution, and before any byte of network traffic. Unsupported
content is rejected before any of them, so a request that cannot be served
discloses nothing.

**Error hygiene.** Upstream bodies are read under a byte bound and reduced
to their machine `type`, `code`, and `param` fields. Raw payloads,
generated text, prompts, tool arguments, request headers, URLs, and API
keys never reach an error, an event, or an observation. Offending data never
appears in a bounds violation.

**Safety identifiers.** `safety_identifier` is produced by an injected
privacy-preserving source. The bundled implementation derives a salted
HMAC-SHA-256 over an opaque subject: bounded to the documented 64
characters, stable, non-reversible, and never a raw email or username. It
is an abuse-monitoring correlator, **not an authentication credential**, and
nothing accepts it as one.

**Resume tokens.** A raw response id is not a capability. Every background
handle carries a fingerprint binding it to the provider instance, request,
model, classification, and policy decision that created it, plus an expiry.
A forged, borrowed, or expired id is refused before any request. Replayed
events after a reconnect are deduplicated by sequence number, a cursor gap
fails closed, and the terminal response is reconciled exactly once — usage
comes from the terminal snapshot, never accumulated from deltas.

---

## Streaming

A bounded incremental SSE parser handles arbitrary byte splits (including
UTF-8 sequences split across chunks, decoded with `fatal: true`), LF and
CRLF, multi-line `data:` fields, comments, and unknown fields, under hard
line, event, aggregate-stream, and event-count bounds.

Semantic events are mapped from the exact dotted `type` values in the
OpenAPI `ResponseStreamEvent` union — `response.output_item.added`,
`response.output_text.delta`, `response.function_call_arguments.done`, and
so on. Reasoning deltas are kept separate and are surfaced only when policy
explicitly allows disclosure.

**Unknown event types fail closed.** An unrecognized event may be a hosted
tool call, a new usage carrier, a refusal variant, or a storage state
change, and this adapter refuses rather than assuming an addition is
harmless. Only an explicit allowlist of documented informational events
(content-part brackets, annotations, reasoning-part brackets) is ignored,
and those are counted in observations. An additive API change therefore
requires an adapter update — a deliberate trade of forward-compatibility
for the guarantee that nothing meaningful is silently dropped.

---

## Usage and cost

OpenAI reports `cached_tokens` as a detail of `input_tokens` and
`reasoning_tokens` as a detail of `output_tokens`. The Stage 2 token
categories are **disjoint**, so the projection subtracts:

```
domain.inputTokens       = input_tokens  - cached_tokens
domain.cachedInputTokens = cached_tokens
domain.outputTokens      = output_tokens - reasoning_tokens
domain.reasoningTokens   = reasoning_tokens
```

Contradictory usage (cached above input, reasoning above output, a total
that does not equal `input_tokens + output_tokens`, negative or non-integer
counts) is rejected rather than reported.

Cost is computed with `BigInt` from the price slice effective at the
operation's instant, rounded up per category, and refused if it would
overflow the safe monetary range. With no effective slice the cost is
reported as **unknown** with a warning; it is never guessed. Cache-write
tokens add a charge only when the snapshot declares a dedicated
cache-write rate — billing them at the input rate would double count, since
the API already reports them inside `input_tokens`.

---

## Injected ports

Everything external is a port. Nothing is ambient.

| Port | Purpose |
| --- | --- |
| `CredentialPort` | resolve the API key for one call |
| `DisclosurePort` | authorize disclosure, persistence, and temporary server state |
| `ArtifactResolverPort` | read authorized image bytes |
| `SafetyIdentifierPort` | derive `safety_identifier` |
| `OpenAiScheduler` / `JitterSource` | clock, cancellable delay, deterministic jitter |
| `IdSource` | operation and tool-call ids |
| `OpenAiTransport` / `FetchLike` | HTTP boundary |
| `ProviderObserver` / `OpenAiObserver` | structured telemetry |

`createPolicyBrokerDisclosurePort` and `createPolicyAwareCredentialPort`
compose the first two against the Stage 6 policy broker and policy-aware
secret resolver, without depending on any concrete secret backend.

---

## Configuration sketch

```ts
const selectedModelId = operatorCatalog.entries[0].modelId;
const configuration = createOpenAiAdapterConfiguration({
  instanceId: "openai-primary",
  apiKeyRef,                       // Stage 6 SecretRef, text kind
  permittedModels: [selectedModelId],
  catalog: operatorCatalog,
  supportedClassifications: ["public", "internal"],
});
```

Conservative defaults: `store: never`, background disabled, continuation
disabled, reasoning disclosure off, parallel tool calls off, safety
identifier required, `https://api.openai.com/v1`.

Request-scoped `openai` extensions may only **tighten**: select a permitted
reasoning effort, turn reasoning disclosure off, decline background, decline
persistence, or lower the output bound. Widening any of these is rejected.

---

## Testing

`npm test` runs 321 hermetic tests with no network, no TLS, and no real
sleeps — an injected `fetch` serves scripted JSON and SSE bodies with
controllable byte chunking, and all timing runs on a manual clock.

Coverage gates: 90% statements / 80% branches / 90% functions / 90% lines.

The reusable Stage 5 inference contract suite runs against this adapter in
`test/contract.test.ts`.

### Live canary (opt-in, budget-capped)

Skipped unless **all** of these are set — there is deliberately no default
model or price, because choosing one implicitly could bill an account for a
model the operator never approved:

```
AI_DEV_OS_OPENAI_LIVE=1
AI_DEV_OS_OPENAI_LIVE_API_KEY=...
AI_DEV_OS_OPENAI_LIVE_MODEL=...
AI_DEV_OS_OPENAI_LIVE_INPUT_MICROS=...
AI_DEV_OS_OPENAI_LIVE_OUTPUT_MICROS=...
AI_DEV_OS_OPENAI_LIVE_MAX_COST_MICROS=...
```

It preflights the worst-case cost against the ceiling before spending
anything, caps output at 16 tokens, sends a fixed harmless prompt with no
repository content, and records neither the key nor generated text. When it
is skipped, a companion test asserts that fact so a green run is never
mistaken for live verification.

---

## Known limitations

1. **No shipped model facts.** Context windows, output caps, and prices must
   be supplied. Without a catalog entry the model is `MODEL_UNAVAILABLE`;
   without a price slice the cost is explicitly unknown.
2. **Additive API events require an update.** Unknown stream events fail
   closed by design.
3. **`stop_sequences` and `seed` are refused**, not dropped: the Responses
   API exposes neither, and silently ignoring them would misrepresent the
   result.
4. **Structured output is validated against a documented JSON Schema
   subset.** Keywords outside that subset are reported as unenforced in the
   result warnings rather than silently ignored.
5. **`health()` performs no network probe.** A real probe would need a
   credential and would bill the account; transport failures surface through
   operations instead.
6. **Cache-write pricing is unmodelled upstream** (see below).
7. **Organization usage/cost APIs are not implemented.** Ordinary inference
   accepts only its request-scoped API-key port; the package exposes no admin
   credential field or implicit organization-metrics call.
8. **Create and cancel POSTs are single-attempt.** Automatic retries are
   limited to bounded, caller-identical GET polling/resume requests. A
   transient create/cancel failure is surfaced with retry disposition rather
   than risking duplicate remote state on an undocumented assumption.

## Proposed upstream contract changes

Two small gaps in the Stage 2/5 contracts forced local workarounds. Both are
additive and backward compatible.

1. **`TokenUsage` has no cache-write category.** The API reports
   `input_tokens_details.cache_write_tokens` as a required field, but Stage 2
   token categories cannot represent it. It is currently carried only in
   observations and in the cost calculation. *Proposal:* add an optional
   `cacheWriteTokens` to `TokenUsage`, and `cacheWriteMicrosPerMillionTokens`
   to `ModelCostMetadata`.

2. **`DisclosureContext.redactionApplied` is a boolean.** The Stage 6 policy
   broker matches against specific `RedactionKind`s, so a boolean cannot say
   *which* transformations ran, and guessing would let an unredacted prompt
   satisfy a redaction rule. `createPolicyBrokerDisclosurePort` therefore
   takes an explicit `transformationsApplied` hook, defaulting to "none".
   *Proposal:* replace the boolean with
   `appliedTransformations: readonly RedactionKind[]`, which subsumes it.
