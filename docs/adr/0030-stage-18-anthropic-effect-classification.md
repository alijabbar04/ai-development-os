# ADR 0030: Stage 18 Anthropic canary effect classification

- Status: Implemented production-disabled diagnostic checkpoint; later no-retry
  attempt failed closed after a response was observed
- Date: 2026-08-15

## Context

The first authorized owned-reference Anthropic canary returned the finite code
`TRANSPORT_FAILURE`. That result was preserved and not retried, but the code was
too broad to identify whether a request was never dispatched, might have been
dispatched, received an HTTP response, or completed provider parsing before a
credential-callback or audit failure.

Deterministic inspection found a concrete classification defect. The Windows
credential broker intentionally converts every exception thrown by a secret
consumer into `CONSUMER_FAILURE` so arbitrary callback details cannot escape.
The canary previously performed transport and response parsing inside that
callback, then mapped the broker's finite error back to `TRANSPORT_FAILURE`.
Consequently an HTTP response error, malformed bounded response, material
callback failure, or broker outcome-audit failure could all become the same
transport code. This finding does not prove which path produced the historical
result and grants no retry authority.

## Decision

Keep the provider production-disabled and retain the existing one-attempt,
fixed-request canary. Add an orthogonal finite `failurePhase` field with exactly
four values:

- `pre-dispatch`: preflight, availability, or request construction refused
  before a request was submitted;
- `possibly-dispatched`: the request boundary was entered or submission was
  attempted, but no response was observed;
- `response-received`: an HTTP response or response stream was observed, even
  when its status, content type, size, JSON, model, text, or usage was invalid;
- `post-response`: the bounded response was accepted, but callback-result,
  broker outcome, clock, or final result processing failed.

Direct transport tracks submission and response observation locally and emits
only the finite code/phase pair. It retains no raw socket, header, body, or
exception detail in the public error.

Provider and response failures are projected into a small exact callback
outcome instead of being thrown through the secret consumer callback. The
credential broker can therefore dispose material and complete its audit before
the canary reconstructs the finite error outside the callback. A separate
`CALLBACK_RESULT_FAILURE` code represents a broker, audit, or result-projection
failure after the callback was entered; it is not relabeled as provider
transport failure. The returned callback outcome is treated as untrusted and
is exact-key, enum, and token-bound before use so an injected broker cannot
substitute arbitrary error fields.

Capture mutable option methods at construction and invoke them through
`Reflect.apply` rather than caller-shadowable `bind` methods. Keep the direct
network factory module-private to the testing implementation; the public
production provider remains refusal-only.

## Evidence and nonclaims

Deterministic tests cover preflight and availability refusal, request
construction, possibly-dispatched request failure, received-response stream and
HTTP failure, malformed response, public timeout, a callback-collapsing broker,
post-callback broker failure, substituted callback outcomes, redaction, and
response-byte zeroing. These tests use synthetic secret material and injected
transport only.

The 15-second effect deadline aborts the transport and starts a separate fixed
5-second callback-drain ceiling. A cooperative callback/broker must settle and
dispose before the public error returns. If an injected boundary remains
uncooperative beyond that drain, the public result is
`CALLBACK_RESULT_FAILURE`; its internal work may still be live and no disposal
or no-effect claim is made for that nonconforming boundary.

No credential availability read or credentialed Messages-create/canary request
was used to establish the deterministic source repair. One body-free
unauthenticated `HEAD /v1/messages` diagnostic established protocol
reachability without a key or request body. The historical
`TRANSPORT_FAILURE` remains ambiguous, its original durable attempt record
remains consumed, and no inference is made about whether that request reached
Anthropic.

After exact-head hosted validation and a separate read-only review of the
frozen launcher/bootstrap/wrapper closure, one later operator-authorized
attempt used a distinct authorization packet and durable marker. Exact
availability preflight passed, the attempt marker was atomically consumed, and
the public result was `TRANSPORT_FAILURE` with `failurePhase=response-received`.
This establishes only that a response was observed. It exposes no status,
header, body, credential, or raw error; it is not the required successful
proof, and it was not retried. Both attempt markers remain consumed. Any
further live attempt would require new explicit authority and is not authorized
by this decision.

`ANT-02` remains `incomplete`, `developmentAccepted` remains `false`, and
`productionAdmitted` remains `false`. This decision does not authorize a
further API-key read, live request, production provider registration, Stage 20
source, or any Account Manager or Stage 17 operation.

## Rejected alternatives

- Inferring the historical failure from current DNS/TLS reachability would
  confuse present reachability with past request evidence.
- Throwing provider errors through the secret callback would continue to make
  broker redaction destroy their classification.
- Passing raw errors, response bodies, headers, retry metadata, or native
  details through the broker would widen the disclosure surface.
- Retrying merely to learn the old failure would violate the consumed attempt
  boundary.
