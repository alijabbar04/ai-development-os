# @ai-dev-os/memory

Durable-port, provenance-aware, scope-isolated memory: verified facts,
decisions, summaries, explicit user preferences, unconfirmed inferred
candidates, constraints, and tombstones.

Depends only on `@ai-dev-os/domain` and `@ai-dev-os/artifacts`. No filesystem,
no network, no environment variables, no database driver, no model.

## Boundaries

| Direction | What crosses it |
| --- | --- |
| In | A `MemoryStorePort`, a `MemoryAuthorizer`, a `MemoryClock`, a `MemoryIdSource`, configuration |
| Out | Entries, query results, metadata snapshots, audit events — or a typed failure |
| Never | Providers, gateway, telemetry, router, thinker, scheduler, API, desktop, concrete persistence drivers, secret brokers |

Dependency direction is `memory -> domain + artifacts`. Nothing in `domain`,
`artifacts`, `persistence`, or `policy` depends back on this package.

**Why ports rather than direct dependencies.** The Stage 6 policy broker's
request type requires provider descriptors and execution-trace metadata that
this stage has no business knowing, and importing it would pull the provider
contracts into a package that must not have them. The same is true of
`@ai-dev-os/secrets`, which depends on both. So authorization and secret
identity cross the boundary as narrow injected shapes:

- `MemoryAuthorizer` — a Stage 6 adapter satisfies it in a few lines.
- `SecretReferenceHandle` — exactly the pair `secretRefFingerprint(ref)` and
  `secretRefDisplay(ref)` produce, so a caller holding a real `SecretRef` can
  round-trip through it losslessly.

## Record variants

| Variant | Meaning | Confidence | Who may author it |
| --- | --- | --- | --- |
| `verified-fact` | Observed and digest-backed | no | user, tool, import |
| `decision` | A choice and its rationale | no | user, import |
| `summary` | A condensation of other material | yes | user, tool, model, import |
| `explicit-preference` | Something the user stated | no | user only |
| `inferred-preference-candidate` | An unconfirmed guess | yes (required) | tool, model |
| `constraint` | A warning or restriction to respect | no | user, tool, import |
| `tombstone` | A replicable deletion marker | no | user, tool, import |

Every record binds: a stable id and schema version; the full scope tuple; a
normalized subject and its digest; author class; provenance (capture method,
digest-bearing sources, recording component); a body; classification and
disclosure scope; creation and observation times from the injected clock; an
expiry; supersession and tombstone links; labels; a content digest; and a
fingerprint over all of it.

Records are **immutable**. Everything that can change later — confirmation
state, `supersededBy`, `tombstonedAt`, `revokedAt`, `version` — lives in the
entry state beside the record, so history cannot be quietly rewritten.

## Provenance and forgery

Author class and capture method are cross-checked, so a record cannot claim a
provenance its author could not have. A `model-suggested` author cannot claim
`user-entry`; a model cannot author an `explicit-preference` at all; a
`verified-fact` requires at least one source carrying a content digest.
Provenance sources and labels are sorted during validation, so two callers
supplying the same facts in different orders produce the same fingerprint.

## Confirmation, supersession, expiry, deletion

- An inferred candidate is stored `unconfirmed` and stays visibly unconfirmed
  until someone decides. A **rejected** candidate remains queryable as
  rejected — hiding it would make the same inference look new next time.
- **An inferred candidate can never supersede an explicit user preference.**
  Attempting it fails with `PRECEDENCE_VIOLATION`. The candidate is still
  storable as evidence; it simply cannot become the answer, and
  `resolvePreference` returns the explicit record even when a candidate for the
  same subject has been confirmed.
- Supersession is explicit and append-only: the replacement names its
  predecessor and the predecessor is marked, never edited away. Chains are
  depth-bounded.
- Expiry is evaluated against the injected clock. An expired record is
  excluded from queries and refuses reads with `EXPIRED`. It never falls back
  to an older version or a broader scope. Inferred candidates receive a
  default expiry (90 days) because an unconfirmed guess that never expires
  becomes indistinguishable from a fact.
- Deletion writes a **tombstone record**, not just a flag. Because the
  tombstone replicates, a stale replica carrying the pre-deletion state cannot
  resurrect anything. Re-appending a tombstoned id fails with `TOMBSTONED`
  unless the caller supplies an explicit, attributed
  `resurrection: { acknowledgeTombstone: true, decidedBy }`.

## Concurrency

- **Append** is idempotent by key: the same key with the same record returns
  the existing entry; the same key with a different record is
  `IDEMPOTENCY_CONFLICT`, never a silent overwrite.
- **State transitions** are compare-and-set on the exact version the caller
  read. A stale writer gets `VERSION_CONFLICT`.
- **Entry and audit event are written atomically** by `MemoryStorePort.apply`.
  This is a hard requirement on adapters: if state could advance without its
  event, the store could lose provenance silently.
- The audit observer runs **before** the write. An unauditable change is not
  made at all — the operation returns `AUDIT_FAILURE` and nothing is stored.

## Scope isolation and privacy

A record belongs to exactly one `(userId, organizationId, projectId,
workspaceId)` tuple. There is no wildcard and no nearest match. The storage key
is derived from the whole tuple with length-prefixed components, so no
combination of identifiers can be re-spelled into another scope's key, and the
store additionally re-checks scope equality on every read as defence against a
misbehaving adapter.

Authorization is **two-phase**:

1. A scope gate runs *before* the record is loaded, asking about the least
   sensitive classification and metadata only. This is why an unauthorized
   caller cannot distinguish "no such record" from "not allowed".
2. Once the record is in hand it is re-authorized against its actual
   classification, and that decision governs body disclosure.

Anything other than an explicit, well-formed `allowed` refuses the operation: a
denial, a conditional decision, a thrown authorizer, a malformed response. An
`allowed` decision may still withhold bodies, in which case every body becomes
`{ kind: "withheld", reason: "unauthorized" }` while metadata remains visible.

### What is deliberately never stored

- **Raw credentials.** Bodies are scanned for PEM and OpenSSH keys, JWTs, AWS
  key ids, vendor key prefixes, bearer and basic credentials, connection
  strings with passwords, assignments to credential-named fields, and
  high-entropy mixed-class tokens. A match is refused with
  `SECRET_MATERIAL_REJECTED`; store a `secret-reference` body instead.
- **Large or raw content.** Bodies are bounded, sanitized text; anything
  substantial lives in the artifact store and is referenced by
  `artifactId` + digest.
- **Permissions of any kind.** There is no grant, capability, role, provider
  eligibility, or approval field. A record that *says* "the user has granted
  access" is a string. Content cannot widen disclosure, and there is no
  `public` member of `DisclosureScope` at all.
- **Content in the audit journal.** Events carry ids, fingerprints, kinds, and
  timing — never a subject, body, or label — so the journal can be read by a
  caller not authorized to see the records.
- **Content in snapshots.** `MemorySnapshot` has no body field in its type.

Control characters, zero-width characters, and bidirectional overrides are
stripped from every stored body and locator, so a record can never carry a
forged frame boundary into a later prompt.

## Composing with Stage 6 configuration

This package does not import `@ai-dev-os/config`; that would make a low-level
store depend on the whole application configuration graph and close off any
future dependency in the other direction. The seam is composition at the call
site through Stage 6's extension mechanism, with the recommended namespace
`memory`:

```ts
const extension = findExtension(resolved.configuration, "memory");   // Stage 6
const configuration = extension === undefined
  ? DEFAULT_MEMORY_CONFIGURATION
  : unwrap(parseMemoryConfiguration(extension.value));
```

`ConfigExtension.value` is already canonical, frozen JSON that Stage 6 has
screened for inline secrets, and `parseMemoryConfiguration` validates it against
this package's own schema.

## Public API

```ts
createMemoryStore({ port, authorizer, clock, idSource, configuration?, auditObserver? })

store.append(...)            appendMemoryRecord(store, ...)
store.read(...)
store.decideCandidate(...)   confirmMemoryCandidate(...) / rejectMemoryCandidate(...)
store.supersede(...)         supersedeMemoryRecord(store, ...)
store.tombstone(...)         tombstoneMemoryRecord(store, ...)
store.query(...)             queryMemory(store, ...)
store.snapshot(...)          memorySnapshot(store, ...)
store.resolvePreference(...)
store.events(...)
store.close()

createMemoryRecord(input)    parseMemoryRecord(value)    memoryRecordFingerprint(record)
parseMemoryConfiguration(value)  memoryConfigurationFingerprint(configuration)
createInMemoryMemoryStore()  createScopedAuthorizer(...)  denyAllAuthorizer
```

Expected outcomes are `MemoryResult` failure variants, not exceptions.
`MemoryError` is reserved for adapter defects. Error details carry only
primitive summaries — never a body, a subject, or an adapter's own message.

`@ai-dev-os/memory/testing` exports the reusable port contract suite plus
deterministic fixtures (manual clock, counting id source, scope tuples, and
armed hostile payloads).

## Verification

```
npm run typecheck -w @ai-dev-os/memory
npm run test -w @ai-dev-os/memory
npm run test:coverage -w @ai-dev-os/memory
npm run build -w @ai-dev-os/memory
```

All tests are offline and deterministic, driven by a manual clock and a
counting identifier source. Nothing needs a credential, a network connection,
or a model — and an ordinary test that did would be an architectural defect.
