# @ai-dev-os/artifact-store

Provider-neutral contracts for content-addressed artifact **byte** storage:
the `ArtifactByteStore` port, structured errors, content keys, the byte-stream
contract, the transformation boundary, and the reusable adapter contract
suite. The local filesystem implementation lives in
`@ai-dev-os/artifact-store-local`.

## Responsibilities and non-responsibilities

**Owns:** how bytes are written, verified, addressed, read, transformed,
deleted, and cleaned up.

**Does not own:** artifact descriptors, manifests, classifications, and
locations (persisted by the Stage 3 layer); reference counting, reachability,
retention, and garbage collection (a later metadata/retention service);
providers, routing, scheduling, UI, and SQLite. The byte store never updates
persistence records, never logs artifact content, and never exposes
filesystem handles.

**Coordination boundary:** pairing a byte write with a descriptor write is
the caller's job and is **not** a distributed atomic transaction. The
supported order is: write bytes → persist the descriptor referencing the
returned key. If the descriptor write fails, the orphaned bytes are
unreachable-but-present until a retention service reclaims them; that is the
conservative failure mode by design.

Dependency direction: `artifact-store-local → artifact-store → artifacts →
domain`. The only platform module this package uses is `node:crypto` (for
digests) — it has no filesystem dependency.

## Content keys and digest semantics

A `ContentKey` **is** the `ArtifactDigest` contract from
`@ai-dev-os/artifacts`: `{ algorithm: "sha-256" | "sha-512", hex }` with
exact-length lowercase hex, validated before any use (`INVALID_CONTENT_KEY`
otherwise). Digests are computed by the store from the actual streamed
bytes — source-stream claims are never trusted — and a matching digest never
makes content *trusted*, only *addressable*: verified reads re-hash on every
use.

## Stream abstraction

Byte streams are `AsyncIterable<Uint8Array>`, chosen deliberately:

- runtime-neutral — no Node stream types in the port;
- both Node `Readable` and Web `ReadableStream` already satisfy it;
- pull-based, so backpressure is inherent and single-use is structural;
- trivially testable with async generators.

Chunks are strictly validated (`INVALID_STREAM` for anything that is not a
`Uint8Array`). Helpers: `bytesToStream`, `collectBytes` (bound is
mandatory — unbounded buffering is deliberately not offered),
`contentKeyOfBytes`, `createIncrementalDigest`.

## Write lifecycle (implemented by adapters)

1. Create an isolated temp file with exclusive-create semantics.
2. Stream chunks, incrementally hashing and counting; enforce
   `maxSizeBytes` while the stream is live (`SIZE_LIMIT_EXCEEDED`).
3. Flush and close the temp file.
4. Check `expectedSizeBytes` (`SIZE_MISMATCH`) and `expectedKey`
   (`DIGEST_MISMATCH`).
5. Atomically promote to the content-addressed location, deduplicating
   against concurrently promoted identical content.
6. Return a frozen `WriteResult { key, sizeBytes, location, deduplicated,
   artifactId }`; remove the temp file on every failure path.

A partially written final object is never visible.

## Reads

`openRead(key, { verify })` fails at open for missing objects
(`OBJECT_NOT_FOUND`). With `verify`, corruption is reported **at stream
completion** (`OBJECT_CORRUPTED`) — bytes already yielded must be discarded
when the stream throws; callers needing pre-verified bytes use
`readBytes(key, { verify: true, maxBytes })`, which buffers within an
explicit bound before returning. Corrupted content is never silently
repaired.

## Deletion semantics

`delete(key)` operates on validated content keys only and is idempotent
(`false` when absent). Deletion by artifact id is intentionally
unimplementable here: one content object may back many descriptors, so
reference counting and reachability belong to the metadata/retention layer.
No automatic garbage collection exists.

## Transformation boundary

`ArtifactTransformation` is a named stream pipeline producing **new**
content — sources are never overwritten (content addressing makes in-place
mutation unrepresentable). `transformArtifact(store, key, t)` reads
verified, pipes, writes, and returns the new object's result; pipeline
failures surface as `TRANSFORMATION_FAILED` without leaking content. Raw
source bytes never leave the process.

`createLiteralRedactionTransform({ literals, replacement })` redacts
**explicitly supplied literal strings only**, matched as exact UTF-8 byte
sequences with a sliding window (matches split across chunk boundaries are
found). Binary content passes through except exact byte matches; other text
encodings are not matched. This is deliberately not generic secret or PII
detection.

## Error model

Stable codes: `INVALID_CONFIGURATION`, `STORE_CLOSED`,
`INVALID_CONTENT_KEY`, `OBJECT_NOT_FOUND`, `SIZE_LIMIT_EXCEEDED`,
`SIZE_MISMATCH`, `DIGEST_MISMATCH`, `OBJECT_CORRUPTED`,
`UNSAFE_FILESYSTEM_STATE`, `WRITE_INTERRUPTED`, `INVALID_STREAM`,
`TRANSFORMATION_FAILED`, `CLEANUP_FAILED`. Details carry digests, sizes,
counts, and OS error codes only — never paths, payloads, or source content.
Errors thrown by a caller's own source stream propagate unchanged.

## Contract suite

`@ai-dev-os/artifact-store/testing` exports
`runArtifactStoreContractSuite` (vitest is an optional peer dependency).
Adapters provide a harness (store, manual clock, optional reopen /
corruption / temp-file capabilities) and get ~30 behavioral tests: empty
objects, multi-chunk round-trips, expectation successes and failures,
mid-stream size enforcement against an endless source, dedup, concurrent
identical and different writes, source failure cleanup, verified-read
corruption detection, deletion idempotence, hostile keys, close semantics,
in-flight-write draining, reopen, stale-temp cleanup with an injected clock
(no sleeps), transformation behavior, and secret-leakage checks.

## Example

```ts
import { contentKeyOfBytes } from "@ai-dev-os/artifact-store";
import { createLocalArtifactStore } from "@ai-dev-os/artifact-store-local";

const store = await createLocalArtifactStore({ root: dataDir });
const result = await store.write(providerOutputStream, {
  maxSizeBytes: 50_000_000,
  artifactId: descriptor.id,
});
// Persist the descriptor referencing result.key / result.location afterwards
// (Stage 3 artifact metadata store) — coordination is caller-owned.
```

## Known limitations

- No reference counting, retention, export tooling, or encryption in this
  stage; the transformation boundary is the seam where encryption plugs in
  later.
- Redaction is literal-rule-based only, by explicit design.
