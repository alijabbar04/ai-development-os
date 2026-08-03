# @ai-dev-os/repository-index

A deterministic, incremental map of one repository snapshot: file and directory
entries with content digests, evidence-based language classification, bounded
manifest and dependency extraction, and a lexical index with stable integer
scoring.

Depends only on `@ai-dev-os/domain` and `@ai-dev-os/artifacts`. It performs no
I/O of its own — no filesystem, no Git, no child process, no network, no
environment variables, no model calls.

## Boundaries

| Direction | What crosses it |
| --- | --- |
| In | `SnapshotReadPort` (injected), configuration, an `IndexClock`, an optional cancellation signal |
| Out | A `RepositoryIndex` value, or a typed failure |
| Never | Providers, gateway, telemetry, router, thinker, scheduler, API, desktop, persistence adapters, secret brokers |

Dependency direction is `repository-index -> domain + artifacts`. Nothing in
`domain`, `artifacts`, `workspace`, or `persistence` depends back on this
package.

## The snapshot read port

Everything the indexer can see arrives through one injected interface:

```ts
interface SnapshotReadPort {
  identity(): SnapshotIdentity;          // project, workspace, snapshot, revision, filesystem semantics
  list(): Promise<readonly SnapshotEntry[]>;   // authorized entries only
  read(path: string, maxBytes: number): Promise<Uint8Array>;
}
```

The Stage 8 workspace abstraction was not reused directly because it models
*mutable* worktree access bound to a process-broker capability grant, whereas
indexing needs an immutable, already-authorized view of a fixed revision with
no write surface at all. Expressing that as a port keeps the Stage 8
hostile-repository protections on the adapter side of the boundary, where they
belong.

Adapter obligations, which the contract suite enforces:

- `list()` returns only entries the caller may already read. The indexer
  applies configured exclusions **on top**; it never widens.
- `read()` must refuse anything `list()` did not report as a regular file, and
  must never follow a symbolic link or reparse point.
- Neither call may mutate the source repository.

**Hostile-repository boundary.** This package never reads `.git`, never runs
`git`, and never honours repository-local configuration. `.gitattributes`,
`.gitignore`, hooks, filter drivers, textconv programs, and merge drivers are
ordinary inert files: they are indexed as text if policy permits and have no
effect whatsoever on what gets indexed. Exclusions come from validated
configuration, never from the repository.

## Index identity and determinism

An index is a value, not a handle: deeply frozen, canonically serializable, and
identified by a SHA-256 fingerprint. Identity binds project, workspace,
snapshot, the exact source revision (or an explicit `no-revision` state), the
schema version, the algorithm versions, and the configuration fingerprint.

Two fields are deliberately **outside** the content fingerprint:

- `observedAt` — when the index was taken, not what it says.
- `tombstones` — what *used to* be there. An incremental sequence accumulates
  them; a full rebuild of the same final state has none. Covered separately by
  `tombstoneFingerprint(index)`.

### The full-versus-incremental guarantee

> A full build and an equivalent incremental sequence over the same final
> snapshot produce the same `fingerprint`.

This holds because both paths funnel through one assembly function, and because
each entry carries its own bounded term vector — the global lexical index is a
pure fold over those vectors, so unchanged files are never re-read yet the
postings are bit-identical either way.

The guarantee has one explicit exception, recorded in the index itself: when a
*global* bound is exhausted (`totals.limitsExhausted === true`) the two paths
reach the bound at different points and are no longer comparable.

Change sets are bound to the index they apply to by fingerprint, so one can
never be replayed against the wrong base.

## Path rules

Every path passes `canonicalizeRepositoryPath` once. Rejected, with a stable
reason code: absolute paths, drive letters, UNC prefixes, backslashes,
`.`/`..`/`~` segments, empty segments, NUL and other control characters,
invisible and bidirectional format characters, unpaired surrogates, alternate
data streams and Windows-forbidden characters, reserved device names, segments
that begin with a space or end with a space or dot, and anything over the
length/depth bounds.

Case and Unicode behaviour follow the snapshot's **declared** filesystem
semantics, not the host's, so the same snapshot indexes identically on Windows
and Linux. When two accepted paths would occupy one filesystem identity, the
index drops **both** and records a `path-collision` diagnostic — it never
silently picks a winner.

A rejected path is recorded only as a SHA-256 digest of its text. Echoing a
hostile path into diagnostics, logs, or a downstream context pack is exactly the
leak that record exists to prevent.

## Content handling

Binary detection runs *before* anything decodes: NUL bytes, known magic
prefixes, and a control-byte ratio over a bounded prefix. Only content that
survives is offered to a strict (`fatal: true`) UTF-8 decoder; a decode failure
is recorded as `invalid-utf-8` rather than lossily substituted. Truncation cuts
on a UTF-8 sequence boundary, so a multi-byte character is never split.

Generated and minified content is detected by marker comments, an over-long
line, or a high average line length. Such files keep their path, name, and
manifest evidence but contribute no body terms — otherwise one bundle dominates
every query.

Language classification is evidence-based and finite (`extension`, `file-name`,
`shebang`, or `none`). `unknown` is a real answer. Extension evidence outranks a
shebang because the extension is part of a path the caller already validated,
while a shebang is content a hostile repository controls freely.

Unsupported, binary, oversized, and unreadable files remain discoverable by
path and name. They are never presented as though they had been semantically
indexed.

## Supported manifest formats

The parser registry is finite and closed. There is no plugin mechanism and no
"guess the format" fallback; detection is by exact base name only.

| Format id | Files | What is extracted |
| --- | --- | --- |
| `npm-package-manifest` | `package.json` | name, version, private flag, workspace patterns, `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` |
| `npm-lockfile-v3` | `package-lock.json` (lockfileVersion 2–3) | recorded installs with resolved versions, workspace members |
| `typescript-project-config` | `tsconfig.json`, `tsconfig.*.json` | top-level keys only; project references are reported as unresolved |

Four states are kept distinct and never conflated: what a **manifest declares**,
what a **lockfile records**, what exists as a **workspace member**, and what is
**unresolved or unsupported**.

**Explicitly unsupported, by design:** executing any manifest, script, hook,
macro, template, or project generator; invoking a package manager or build
system to "resolve" anything; YAML, TOML, and every other format not in the
table; and any dynamic construct. A non-scalar dependency specifier is recorded
as `unresolved`, never guessed.

Defences applied to every document: a strict RFC 8259 structural scan that
rejects comments, trailing commas, single quotes, `NaN`/`Infinity`, and reports
**duplicate keys** (which `JSON.parse` would silently collapse — a manifest that
reads one way to a human and another to a parser is refused outright); then
`parseJsonText` from `@ai-dev-os/domain`, which rejects prototype-pollution
keys, exotic objects, cycles, and oversized payloads.

A partial result is only ever emitted alongside a diagnostic saying so.
`status` never reads `parsed` when anything was skipped.

## Lexical index and its limits

Fields are `name`, `path`, `symbol`, `manifestKey`, and `text`, weighted 12, 8,
6, 5, 1. Tokenization splits on non-word characters and on case/digit
transitions (`parseRepositoryIndex` also yields `parse`, `repository`, `index`),
using explicit code-point checks so behaviour cannot drift with the host
engine's Unicode tables.

Scoring is integer-only:

```text
idf(term) = floor(IDF_SCALE * (documents - documentFrequency + 1) / (documents + 1))
tf(count) = min(count, TF_CAP)
raw       = sum over matched (term, field) of idf * tf * fieldWeight
penalty   = 1 + floor(entryTermTotal / LENGTH_NORMALIZER)
score     = floor(raw / penalty)
```

**This is not BM25 and does not pretend to be.** What it guarantees is
stability: identical inputs produce identical integers on every platform. Ties
break on canonical path, never on iteration order.

Symbols are extracted with bounded regular expressions over declaration-shaped
text. That is pattern matching, not parsing: it can miss symbols and can match
inside a string literal. Every such result is labelled `symbol` so a consumer
knows how it was obtained.

Supported query kinds are `terms`, `exact`, `prefix`, and `path`. Every query
takes a result limit and a candidate bound, honours cancellation, and reports
`truncated`. Every hit carries its source digest, score components, language,
and truncation flags.

**Deliberately absent:** embeddings, vector search, learned ranking, language
servers, AST evaluation, and provider-specific token estimation.

## Bounds

Configuration is schema-versioned, runtime-validated, deeply frozen, and
fingerprinted together with the algorithm versions. Enforced bounds cover file
count, per-file bytes, total bytes, indexed text bytes, terms per entry,
distinct terms, postings per term, manifest bytes, dependencies per manifest,
diagnostics, and processing time. Exhausting a bound is always visible: a
diagnostic plus `totals.limitsExhausted`.

Exclusion matching is three finite forms — exact path, directory prefix, and
lowercase base-name suffix — not a glob language whose cost is unbounded.
Defaults exclude version-control metadata, build output, vendored trees, and
credential-shaped files (`.env`, `id_rsa`, `*.pem`, `*.key`, `*.p12`, …) so a
stray key is never read in the first place.

### Composing with Stage 6 configuration

This package deliberately does not import `@ai-dev-os/config`: doing so would
make a low-level index depend on the whole application configuration graph, and
Stage 6 would then have no way to depend on anything here. The seam is
composition at the call site, using Stage 6's own extension mechanism:

```ts
const resolved = resolveConfiguration(layers, { clock });          // Stage 6
const extension = resolved.configuration?.providers               // or any
  .flatMap((instance) => instance.extensions)
  .find((entry) => entry.namespace === "repository-index");

const configuration = extension === undefined
  ? DEFAULT_REPOSITORY_INDEX_CONFIGURATION
  : unwrap(parseRepositoryIndexConfiguration(extension.value));
```

`ConfigExtension.value` is already canonical, frozen JSON that Stage 6 has
screened for inline secrets, and `parseRepositoryIndexConfiguration` validates
it against this package's own schema. Neither side gains a dependency on the
other, and the recommended extension namespace is `repository-index`.

## Public API

```ts
createRepositoryIndexer({ configuration, clock })
buildRepositoryIndex({ readPort, configuration, clock, signal? })
updateRepositoryIndex({ readPort, priorIndex, changeSet, configuration, clock, signal? })
queryRepositoryIndex(index, query)

parseRepositoryIndexConfiguration(value)      // result variant
withRepositoryIndexOverrides(base, overrides) // result variant
repositoryIndexConfigurationFingerprint(configuration)

parseRepositoryIndex(value)                   // full runtime validation
parseRepositoryIndexChangeSet(value)
repositoryIndexFingerprint(index)
tombstoneFingerprint(index)
```

Expected outcomes — invalid configuration, invalid change sets, snapshot
mismatch, cancellation, port failure, invalid queries — are returned as
`RepositoryIndexResult` failure variants, not thrown. `parseRepositoryIndex`
throws the shared `ValidationError` from `@ai-dev-os/domain`, because a stored
index that fails validation is a corruption, not a routine outcome.

`@ai-dev-os/repository-index/testing` exports the reusable contract suite plus
the in-memory snapshot fixture, which records every read so a test can prove
which files were and were not touched.

## Verification

```
npm run typecheck -w @ai-dev-os/repository-index
npm run test -w @ai-dev-os/repository-index
npm run test:coverage -w @ai-dev-os/repository-index
npm run build -w @ai-dev-os/repository-index
```

The package's `pre*` scripts build `@ai-dev-os/artifacts` (and transitively
`@ai-dev-os/domain`) first, so a clean checkout always resolves declarations.
All tests are offline, deterministic, and driven by a fake clock; none needs a
credential, a network connection, or a model.
