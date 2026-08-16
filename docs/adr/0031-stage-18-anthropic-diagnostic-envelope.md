# ADR 0031: Stage 18 Anthropic canary diagnostic envelope

- Status: Implemented production-disabled diagnostic extension; no live attempt
  is authorized, performed, or implied by this decision
- Date: 2026-08-16

## Context

ADR 0030 added the orthogonal `failurePhase` field so a canary failure records
*where* an attempt stopped. The one repaired attempt it enabled returned
`TRANSPORT_FAILURE` at `failurePhase=response-received`. That establishes only
that an HTTP response was observed. It does not distinguish an expired or
revoked credential from a spend cap, an organization permission, a rate limit,
a withdrawn model, a malformed request, a provider outage, or a response the
canary could not parse. Every one of those outcomes is a development blocker
with a different remedy, and the operator cannot tell which one occurred.

The cause is structural rather than incidental. `projectTransportResponse`
rejected any response whose status was not exactly `200`, whose content type
was not `application/json`, or whose body fell outside `2..65536` bytes, and it
did so *before* reading anything else. The status was discarded at that point,
so a 401, a 402, a 429, a 500, and a 529 were indistinguishable in the public
result by construction.

The published taxonomy makes a better answer available. Anthropic documents an
exact error-type enum bound to specific HTTP statuses, a `request-id` response
header, a `retry-after` header on rate limits, a documented stop-reason enum
that includes `refusal`, and a server-sent-event `error` frame that can arrive
after a `200` has already been sent.

## Decision

Keep the provider production-disabled, keep the one-attempt fixed request
byte-for-byte unchanged, and keep the finite `code` and `failurePhase`
vocabularies exactly as ADR 0030 published them. Add a separately versioned,
additive **diagnostic envelope** carried on failures only, as
`AnthropicLiveCanaryError.diagnostics` and in that error's `toJSON()`.

The envelope has eleven fields and no free text:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Envelope version, currently `1`, independent of the result's `schemaVersion` |
| `category` | One of eighteen normalized causes, including `unknown` |
| `httpStatus` | Validated `100..599` integer, or `null` |
| `providerErrorType` | Allowlisted documented error type, `"unknown"`, or `null` |
| `providerErrorEnvelopeObserved` | Whether a syntactically valid error envelope was seen |
| `requestIdPresent` | Presence only; the identifier itself is never read |
| `retryAfterSeconds` | Validated `0..86400` integer, or `null` |
| `responseStreamBegan` | Whether a server-sent-event stream was observed |
| `stopReason` | Allowlisted documented stop reason, `"unknown"`, or `null` |
| `modelEcho` | Whether the payload echoed the pinned model; `null` if absent |
| `transportErrorKind` | Socket-failure family derived from the runtime error code |

Classification precedence is deliberate and fixed: a local cause outranks a
transport cause, transport outranks HTTP status, and status outranks the
response body. Each earlier signal is produced closer to this process and is
less susceptible to influence by the payload being classified. Concretely, a
`401` carrying a body that claims `overloaded_error` is reported as
`credential-unauthenticated` with the conflicting body observation still
recorded. A `200` carrying a stream `error` frame is classified from the frame,
because there the body is the only evidence of failure.

`unknown` is a first-class answer. An undocumented status such as `503` is
reported as `category: "unknown"` with `httpStatus: 503` rather than being
folded into a plausible-sounding family. The status still reaches the operator;
only the label declines to overreach.

### Classification never reads provider prose

`error.message` is attacker-influenceable and can echo request content. It is
never read, matched, or pattern-classified. Categories derive only from HTTP
status, allowlisted structured enum fields, allowlisted runtime error codes,
and local transport state.

This is a deliberate divergence from the readiness plan
(`stage-18-closure-plan.md` §A2), which proposed matching `error.message`
against an allowlisted pattern set in memory to separate a credit or billing
failure from a generic `400`, emitting only the resulting enum. That proposal
predates the documented `402 billing_error` type, which now makes the
distinction available from status and type alone, so the prose channel buys
nothing and costs a steerable classifier. A test asserts that a `500 api_error`
whose message names `authentication_error`, credit exhaustion, and
`rate_limit_error` is still classified `provider-internal-error`.

### Fail-closed and fail-soft are separated

The primary fields are fail-closed: a response whose shape, status, or body is
unusable still fails, and diagnostics never turn a failure into a success. The
optional diagnostic fields are fail-soft: a malformed `retry-after` normalizes
to `null` rather than invalidating the envelope, so a hostile transport cannot
blind the classifier to the status by corrupting a secondary field.

### Untrusted input handling

The response payload is parsed under a strict byte bound, decoded, and routed
through the domain record guard, which rejects exotic prototypes, symbol keys,
accessor properties, and forbidden object keys. Unknown fields are ignored.
Parsing failures yield "no envelope observed" rather than an exception, and
diagnostic enrichment never throws. Byte length is read through the intrinsic
`Uint8Array` accessor because a payload can shadow `byteLength` with an own
property; that hazard was found by an existing repository guard during this
change and is now covered in the new module as well. Response bytes continue to
be zeroed on every path, and evidence is gathered before the bytes are cleared.

An envelope that crosses the secret-broker boundary is re-validated exactly like
provider input, because the broker may substitute or reshape a consumer's
return value.

## Evidence and nonclaims

Fifty-eight deterministic tests cover the eleven documented status and error
types, unknown future 4xx and 5xx types, undocumented statuses, socket failure
families (DNS, refusal, TLS, reset, unreachable), reset before and after
response headers, timeouts at each phase, streaming error frames, truncated
streams, malformed and oversized bodies, refusal, model mismatch, bounded
header projection, conflicting and duplicate structured fields, request-id
presence without the identifier, hostile getters, proxies, prototype poisoning,
symbol keys, broker failure before and after secret resolution, zeroization,
serialization round-trip, and adversarial property sweeps. Every redaction
assertion is paired with a positive control proving the sentinel was present in
the fixture. All tests use synthetic transports and synthetic secret material.

Guard discrimination was measured by reintroducing each defect:

| Defect reintroduced | Result |
| --- | --- |
| Read shadowed `byteLength` instead of the intrinsic | Existing zeroing guard fails |
| Let the response body outrank HTTP status | Conflicting-evidence test fails |
| Classify from `error.message` prose | Prose-contradiction test fails |
| Weaken the envelope validator's category allowlist | Mutation test fails |
| Remove envelope re-validation *or* diagnostics-aware outcome equality | Still refuses — the two guards are redundant |
| Remove *both* of those guards together | The forged `rate-limited` claim reaches the public error |
| Supply unallowlisted values directly to the classifier | Constructor normalization test fails |

The forged-broker vector therefore discriminates that pair rather than either
member; the validator is independently discriminated by the mutation test. This
is recorded rather than papered over, because a vector that still fails after a
guard is removed has stopped proving that guard.

The live request is unchanged and proven so by test: endpoint
`https://api.anthropic.com/v1/messages`, API version `2023-06-01`, model
`claude-haiku-4-5-20251001`, the 116-byte fixed body, request fingerprint
`0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a` recomputed
from the observed bytes, a four-token output cap, no streaming, tools, system
prompt, repository content, or user content, one dispatch per attempt, no
automatic retry on any classified-transient outcome, and refusal of a second
attempt after a diagnosed `529`.

Known limits, stated rather than implied:

- The canary's success contract does not inspect `stop_reason`. A refusal is
  classified as `provider-refusal` only because its content also fails the
  exact `"OK"` contract. This ADR does not change the success contract.
- `stop_details` is not projected. Its documented value set could not be
  verified from official documentation during this change, and an unverified
  allowlist would be a guess.
- Token usage is not projected into the envelope. It is absent on the failure
  paths this change exists to explain.
- Nothing here classifies the historical 2026-08-14 or 2026-08-15 attempts.
  Both remain consumed, ambiguous, and un-retried. Inferring their cause from
  this richer taxonomy would confuse present capability with past evidence.

## What this decision does not authorize

`ANT-02` remains `incomplete`, `developmentAccepted` remains `false`, and
`productionAdmitted` remains `false`. This change performs no live request,
reads no credential, touches no credential marker, and creates none. It does
not authorize an API-key read, a live attempt, production provider
registration, Stage 20 source, or any Account Manager or Stage 17 operation.

One consequence must be carried forward explicitly: changing the canary's
structured result changes the executed runtime closure. The readiness plan's
step-3 rule requires the wrapper, bootstrap, launcher, and runtime-closure
hashes to equal reviewed values, or a newly reviewed closure to be re-audited
read-only first. The canary launcher additionally validates its child's output
against its own allowlist. Therefore this branch is **not** a drop-in edit
ahead of a live attempt: before any future authorized canary run, the closure
must be re-audited read-only, the launcher's output validation must be
confirmed to accept the extended envelope, and a fresh authorization packet and
marker namespace must be issued. That work is outside this lane and was not
performed here.

## Rejected alternatives

- Widening the finite `code` enum instead of adding an envelope would break the
  exhaustive vocabularies ADR 0030 published and every consumer that switches
  on them.
- Adding diagnostics to the success result would change a frozen success
  contract to carry fields that only failures populate.
- Matching `error.message` against patterns would reintroduce a classification
  channel the provider's own payload can steer.
- Emitting the request identifier, retry headers verbatim, or any body excerpt
  would widen the disclosure surface that ADR 0030 deliberately closed.
- Retrying a classified-transient failure automatically would violate the
  one-shot attempt economy, which consumes an attempt on submission regardless
  of outcome.
