# ADR 0035: Stage 18E-I candidate-bound Anthropic validation enablement

Status: Accepted

Date: 2026-08-23

Related: ADR 0027 (Stage 18 live boundary), ADR 0030 (effect
classification), ADR 0031 (diagnostic envelope), ADR 0032 (development
closure), ADR 0033 (application-owned credential vault), ADR 0034
(bootstrap-to-visible startup deadline)

## Context

Stage 18E-H could securely save an Anthropic credential in the application
vault, but its production composition always installed a disabled validation
port. The reviewed fixed Anthropic canary existed only under a testing entry
point. Enabling a later real attempt requires more than making that transport
reachable: the authority must be bound to an exact published candidate and
request, durable across restart, consumed before any possible dispatch, and
incapable of authorizing a retry or general inference.

This decision prepares that capability. It does not authorize or perform a
provider request, read a credential, or prove `ANT-02`.

## Decision

### 1. Extract one reviewed fixed-request implementation

The fixed live-canary implementation and diagnostic classifier move to the
stable `@ai-dev-os/provider-anthropic/validation` subpath. The existing
`./testing` paths re-export the same implementation, avoiding a second set of
request constants or validators. The package's normal production entry remains
refusal-only, and the validation runner still requires a scoped broker, exact
preflight decision, and one call to `runOnce`.

The validation subpath has one built-in direct HTTPS transport. Callers cannot
inject a production transport through that surface. It pins:

- `POST https://api.anthropic.com/v1/messages`;
- `anthropic-version: 2023-06-01`;
- model `claude-haiku-4-5-20251001`;
- body
  `{"model":"claude-haiku-4-5-20251001","max_tokens":4,"messages":[{"role":"user","content":"Reply with exactly OK."}]}`;
- 116 UTF-8 bytes and SHA-256
  `0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a`;
- four maximum output tokens, 65,536 maximum response bytes, a 15-second
  effect timeout, and a five-second entered-callback drain;
- standard commercial API retention (`standard-30-day` in the existing
  provider envelope), with no zero-data-retention claim.

There is no endpoint, version, model, proxy, redirect, SDK, or retry fallback.

### 2. Bind authority to the published candidate

The application build emits no candidate binding before the Stage 18E-I
manifest-only publication commit exists. At that exact commit, a build-time
verifier independently reconstructs the non-self-referential committed-blob
manifest and writes a canonical generated binding into
`dist/main/stage-18e-i-candidate-binding.json`. The binding contains the exact
final HEAD/tree, source commit/tree, manifest path and SHA-256, and subject
aggregate. A malformed, noncanonical, uncommitted, non-manifest-only, or
parent-drifted manifest cannot produce a published binding.

Generator, verifier, and binding writer independently pin the inventory base
to reviewed Stage 18E-H commit
`8fc438910c55988f33479136f67acc4bcf74a5de`; a manifest-provided alternate
base is refused and is never used as a reconstruction input.

At runtime, the host may read only the fixed canonical authorization packet at
`<appData>/<appName>/credential-setup/anthropic-validation/authorization/anthropic-validation.v1.json`.
The packet is schema-exact and binds the generated candidate, Anthropic slot
and `anthropic-default` application-vault `SecretRef` fingerprint, the fixed
request, retention and resource bounds, a bounded external authorization
reference, a new marker namespace, issuance and expiry no longer than 24
hours, one attempt, no retry, and the finite result vocabulary. Duplicate
keys, alternate serialization, oversized input, accessors, proxies, prototype
changes, symlinked files, and any binding substitution fail closed.

No environment variable, command-line argument, renderer state, or IPC field
can create or widen this authority.

### 3. Consume durably before secret resolution

After the main process rechecks the current credential identity and receives an
allowed provider-disclosure policy decision, the validation port prepares the
attempt by atomically creating a new marker with exclusive `wx` semantics. The
marker contains canonical nonsecret identifiers only. Only after that durable
operation may the policy-aware resolver receive the existing Anthropic
`SecretRef`.

An existing marker of any shape, including an empty file or directory left by
a crash, is consumed. A failure before exclusive creation is a no-dispatch
precondition failure: it blocks the current process but does not falsely claim
that a marker exists. Once `wx` returns a handle, state becomes consumed
immediately; any later marker-write, sync, or handle-close uncertainty is
ambiguous and stays
durably consumed because even the empty or partial marker refuses eligibility
after restart. Two processes that loaded the same packet can produce at most
one successful claim. Restart does not reset a created marker. A claim is also
single-use in memory.

Cancel before confirmation sends no validation IPC, creates no marker, and
makes no request. Cancellation after consumption keeps the marker consumed.
Closing the host aborts every active validation controller and drains the
existing callback-scoped work boundary; it does not retry.

The controller and absolute deadline start before the first authoritative
vault read and remain authoritative through result persistence. If close or
the deadline wins during that first read, the read is drained but authorization
preparation and provider dispatch cannot begin. Each definitive metadata update
rechecks that the host is open, the attempt is not aborted, and the deadline
has not elapsed immediately before its atomic commit. A close or deadline that
wins before that commit cannot persist a definitive validation. After a
deadline, only the already-downgraded inconclusive attempt and Activity may be
recorded; close blocks every later metadata commit.

### 4. Preserve callback-scoped secret handling

The policy-aware application-vault resolver supplies `SecretMaterial` only
inside its callback. A narrow broker adapter makes that same material available
to the fixed canary without copying the plaintext into configuration. The
canary performs exactly one `SecretMaterial.useText` call directly around the
authorization header and HTTPS submission. Plaintext never enters renderer or
IPC state, environment, arguments, errors, diagnostics, metadata, evidence, or
the durable authorization/marker files.

The normal launcher removes inherited `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
and case-insensitive Electron, Node, .NET, CLR, and COMPlus control prefixes.

### 5. Expose one truthful UI action

Only an enabled, present Anthropic slot with a currently available bound packet
receives a **Validate connection** action. Other providers and unavailable,
invalid, expired, or consumed states receive no validation action. Normal and
Developer projections derive from the same authority; Developer mode adds only
bounded references and fingerprints.

The confirmation names Anthropic and the exact model, shows the fixed synthetic
phrase, four-token maximum, standard retention, no retry, hidden credential,
Cancel/no-consumption semantics, immediate Confirm consumption, and the 15+5
second bounds. Repeated activation is blocked in the renderer, session machine,
host reservation, atomic marker, and single-use claim.

### 6. Promote only an independently exact success envelope

The application independently projects every own data descriptor of the
canary result. `valid` requires schema 1; the pinned endpoint, version, model,
request fingerprint and standard retention; `success`; transport
`direct-anthropic-https`; bounded duration and usage; all no-retention and
fixed-body booleans; and the exact policy-decision fingerprint. Extra fields,
accessors, proxies, model substitution, `deterministic-fake`, `direct`,
`injected`, or unknown transport kinds cannot promote.

Authentication failure maps to `invalid`; billing or permission denial maps to
`unauthorized`; bounded network, timeout, rate-limit, and provider-availability
families map to `unreachable`; everything not safely classified remains
`ambiguous`. Provider prose is never consulted or returned. Inconclusive
attempts preserve prior definitive knowledge.

## Consequences and nonclaims

- The production host is still validation-disabled unless both the exact
  published binding and one valid external packet exist.
- The repository contains no authorization packet or attempt marker.
- Saving, rotation, enable/disable, removal, task execution, and other providers
  cannot consume or inherit this authority.
- The normal Anthropic provider remains production-disabled; no general
  inference or orchestration route is enabled.
- Synthetic transport proves deterministic behavior only and cannot prove
  `ANT-02`.
- `AM-02` and `INT-01` remain proven; `ANT-02` and `PLN-02` remain incomplete;
  `developmentAccepted=false`; `productionAdmitted=false`; Stage 20A remains
  ineligible.
