# @ai-dev-os/context

Deterministic context selection and packing. Combines authorized
repository-index entries, memory records, and artifact references under explicit
budgets, and returns a fingerprinted pack in which every item is labelled
untrusted.

Depends on `@ai-dev-os/domain`, `@ai-dev-os/artifacts`,
`@ai-dev-os/repository-index`, and `@ai-dev-os/memory`. No filesystem, no
network, no environment variables, no model.

## Boundaries

| Direction | What crosses it |
| --- | --- |
| In | A request, sources (index + read port, memory entries, artifact references + port), a `ContextAuthorizer`, a `ContextClock`, a unit estimator, configuration |
| Out | A `ContextPack` value, or a typed failure |
| Never | Providers, gateway, telemetry, router, thinker, scheduler, API, desktop, persistence drivers, secret brokers |

Dependency direction is `context -> domain + artifacts + repository-index +
memory`. Nothing upstream depends back on it.

**Not a prompt compiler.** This package emits no system message, no role, and
no instruction. It produces a transport form and a structured pack; deciding
what a model is actually told — and estimating that model's real tokens — is
Stage 16's job.

## Trust boundary

Repository files, README prose, code comments, prior model summaries, artifact
excerpts, memory bodies, and the caller's own task description are **all
untrusted data**. `ContextCandidate.trust` and `ContextPackItem.trust` have
exactly one possible value, `"untrusted"`, because there is no retrieved
material that is trusted.

Three mechanisms make that stick, none of which is "hope the delimiter is
unusual":

1. **Length prefixes are authoritative.** Every rendered body is preceded by its
   exact UTF-8 byte count. A body containing `<<<ADOS-END>>>` cannot terminate
   its own block; a body containing `<<<ADOS-ITEM … trust=trusted>>>` cannot
   open a forged one. The contract suite includes a fixture that attempts
   exactly this, with a positive control proving a naive line-based reader *is*
   fooled by it while a length-aware reader is not.
2. **Trust and provenance are structural.** They are fields of the pack —
   source kind, digest, scope label, classification, disclosure, provenance,
   observation time — not prose inside the text.
3. **Poisoning is evidence, not an error.** Control characters, zero-width
   characters, and bidirectional overrides are stripped and counted;
   occurrences of frame markers are counted in
   `frameSentinelOccurrences` and reported as a diagnostic. The material stays
   available to a later stage that may want to reason *about* it — while never
   being executed or followed.

Nothing a candidate says can widen disclosure. There is no field through which
content could grant a capability, raise a classification, or claim
authorization.

## Determinism

`planContextPack` is a pure function. For the same candidates, budget,
configuration, and estimator it returns a byte-identical plan, and
`buildContextPack` returns a byte-identical pack fingerprint.

What makes that true:

- Candidates are sorted by (category priority, score descending, identity,
  digest) — every tie has a total order.
- Deduplication is by body digest, and the winner is first in that sorted
  order, not first in the input.
- Byte accounting is exact UTF-8 bytes; truncation cuts on a character
  boundary, so a multi-byte character is never split into a replacement
  character.
- The authorization fingerprint is taken over decisions **sorted by identity**,
  so the pack does not inherit source iteration order.
- No wall clock, no random identifiers, no locale comparison, no filesystem
  enumeration, no hash-map insertion order.
- `generatedAt` is excluded from the pack fingerprint; it records when the pack
  was made, not what it says.

## Budgets

Enforced simultaneously:

| Bound | Meaning |
| --- | --- |
| `maxTotalBytes` | Total UTF-8 bytes across all bodies |
| `maxTotalUnits` | Total estimator units (see below) |
| `maxItems` | Item count |
| `maxItemBytes` / `minItemBytes` | Per-item ceiling, and the floor below which truncating is pointless |
| `maxBytesPerSourceKind` | Per-source cap, so one kind cannot crowd out the rest |
| `categories[c].reservedBytes` | Bytes guaranteed to a category before anything competes |
| `categories[c].maxBytes` / `maxItems` | Per-category ceilings |
| `maxOmissions` / `maxDiagnostics` | Bounded reporting |

Selection runs in two passes: reservations first, in category priority order,
then the general pool. A candidate refused during the reservation pass is not
lost — only a refusal in the general pass is final. That is what lets a
low-scoring constraint keep its reserved bytes against a high-scoring
repository excerpt.

Category priority is `task`, `constraint`, `repository`, `memory`, `artifact`,
and is part of `CONTEXT_SELECTION_ALGORITHM_VERSION`.

### Units are not tokens

This stage does not know what a token is for any particular model and does not
pretend to. It counts **units**: the default estimator charges one unit per
three UTF-8 bytes, deliberately over-counting against the roughly four bytes
per token real tokenizers average, so a pack inside a unit budget fits inside
the equivalent token budget and never the reverse.

An estimator claiming `exact: true` is **rejected**. Exactness is a property
only a model-specific tokenizer has, and Stage 16 owns it. Injected estimators
are additionally checked for determinism, monotonicity, and a zero cost for
empty text — every budget decision depends on those.

## Provenance on every item

| Field | Meaning |
| --- | --- |
| `sourceKind`, `identity`, `digest` | What it is and how to refer to it. `digest` hashes the candidate body **as offered** and is the deduplication key; when `truncated` is true the packed `body` is a prefix of what that digest describes, just as `sourceDigest` describes the full source rather than the excerpt |
| `classification`, `disclosure`, `scopeLabel` | Its sensitivity, and an opaque digest of its owning scope — never the scope identifiers |
| `provenance` | Locator, the source digest the producing stage recorded, and the origin fingerprint (index, memory record, or artifact) |
| `observedAt` | When the source was observed, from an injected clock |
| `score`, `scoreComponents` | The relevance the retriever supplied, and its breakdown |
| `byteContribution`, `unitContribution` | Exactly what it cost |
| `truncated`, `extractionRange` | Whether it was cut, and which lines it covers |
| `trust`, `frameSentinelOccurrences` | Structural trust label and poisoning evidence |

## Omissions

Every excluded candidate is reported with its identity, digest, and one reason:
`budget-bytes-exhausted`, `budget-units-exhausted`, `budget-items-exhausted`,
`category-allocation-full`, `per-source-cap`, `item-too-large`,
`duplicate-digest`, `policy-denied`, `classification-ceiling`, `expired`,
`tombstoned`, `scope-mismatch`, `source-digest-mismatch`, `artifact-unresolved`,
`source-unavailable`, `empty-after-sanitization`, or
`unconfirmed-candidate-excluded`.

**No omission carries any part of the body it names.** The manifest is bounded,
and truncating it sets `omissionsTruncated` — a silently short manifest would
read as "nothing else was dropped".

## Policy and privacy

Authorization is one decision per candidate, taken **before** any body reaches
the plan. Deny-by-default is enforced here: a denial, a conditional decision, a
thrown authorizer, or a malformed response all refuse. An authorizer that is
*unavailable* aborts the whole assembly with `AUTHORIZATION_UNAVAILABLE` rather
than denying item by item, because a pack assembled while policy was down would
look complete when it is not.

Source integrity is verified rather than assumed. A repository excerpt read in
full whose bytes disagree with the digest the index recorded is discarded with
`source-digest-mismatch`; the same holds for an artifact served under a digest
that does not describe it. Serving content under a digest that does not match is
how a swapped file reaches a prompt while appearing verified.

Memory is filtered by lifecycle before anything else: tombstoned, revoked, and
expired records are omitted, and an unconfirmed inferred candidate is excluded
unless `includeUnconfirmedCandidates` is explicitly set. A withheld,
artifact-backed, or secret-referencing memory body is never inlined.

The caller's task description is a candidate like any other. It is classified at
the configured ceiling — overstating rather than understating its sensitivity —
and it authorizes nothing.

**Packs are returned, never written.** There is no sink parameter and no write
method. Persisting assembled context is a disclosure decision for the caller
and an explicitly authorized artifact sink. `summarizeContextPack` produces a
bounded, body-free audit record: counts, digests, and reasons only.

## Composing with Stage 6 configuration

As with the other two Stage 14 packages, `@ai-dev-os/config` is not imported.
Configuration arrives through Stage 6's extension mechanism at the call site,
under the recommended namespace `context`:

```ts
const extension = findExtension(resolved.configuration, "context");   // Stage 6
const configuration = extension === undefined
  ? DEFAULT_CONTEXT_CONFIGURATION
  : unwrap(parseContextConfiguration(extension.value));
```

`ConfigExtension.value` is already canonical, frozen JSON that Stage 6 has
screened for inline secrets, and `parseContextConfiguration` validates it
against this package's own schema. Neither side gains a dependency on the other.

## Public API

```ts
createContextPacker({ authorizer, clock, configuration?, estimator? })
buildContextPack({ request, sources, authorizer, clock, configuration?, estimator?, signal? })
planContextPack({ candidates, configuration, estimator, deniedIdentities?, priorOmissions?, priorDiagnostics? })
collectContextCandidates({ request, sources, configuration, now })

contextPackFingerprint(pack)   summarizeContextPack(pack)   renderContextPack(pack)
parseContextConfiguration(value)   withContextOverrides(base, overrides)
parseContextRequest(value)   parseContextCandidate(value)   parseContextBudget(value)
conservativeUnitEstimator   validateEstimator(estimator)
createProjectContextAuthorizer(...)   denyAllContextAuthorizer
```

Expected outcomes — invalid configuration or request, a rejected estimator, an
unsatisfiable budget, an unavailable authorizer, cancellation, a closed packer —
are `ContextResult` failure variants, not exceptions.

`@ai-dev-os/context/testing` exports the reusable packer contract suite plus
deterministic fixtures, including armed poisoning and frame-forging payloads.

## Verification

```
npm run typecheck -w @ai-dev-os/context
npm run test -w @ai-dev-os/context
npm run test:coverage -w @ai-dev-os/context
npm run build -w @ai-dev-os/context
```

All tests are offline and deterministic under a manual clock. Nothing needs a
credential, a network connection, or a model.
