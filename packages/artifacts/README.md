# @ai-dev-os/artifacts

Immutable, provider-neutral artifact contracts for AI Development OS:
descriptors, digests, storage locations, provenance, and per-task-run
manifests. Depends only on `@ai-dev-os/domain`; performs no I/O and never
touches providers, databases, or the UI.

## Responsibilities

| Concept | Purpose |
| --- | --- |
| `ArtifactDescriptor` | Immutable metadata for one artifact: stable `ArtifactId`, safe display name, kind, logical role, media type, byte size, digest, data classification, location, provenance, parent references, creation time, schema version |
| `ArtifactDigest` | `sha-256`/`sha-512` lowercase-hex content digest with exact length checks |
| `ArtifactLocation` | Where bytes live: `content-addressed` (located by digest) or `workspace-file` (workspace id + validated relative path). Raw absolute paths are unrepresentable |
| `SafeRelativePath` | Branded, lexically-validated forward-slash relative path |
| `ArtifactProvenance` | Producer (`model`/`agent`/`user`/`system`) plus run/task/task-run/trace correlation ids |
| `ArtifactManifest` | The unique-id set of artifacts a task run produced or consumed |
| Typed narrowings | `InputArtifact`, `OutputArtifact`, `PatchArtifact`, `TestResultArtifact`, `LogArtifact` with `isX` guards |

## Invariants

- Every parse returns a deeply frozen value or throws the shared
  `ValidationError` from `@ai-dev-os/domain`; unknown `schemaVersion`s fail
  loudly rather than being reinterpreted.
- **No free-form metadata map.** Unrestricted filesystem paths and raw file
  contents cannot ride along inside descriptor metadata by construction.
- Display names exclude control characters, path separators, and
  Windows-forbidden characters, and cannot begin or end with a dot or a
  space — they are render-safe and can never be interpreted as a path.
- Parent references are bounded (max 64), unique, and never self-referential.
- Manifests are bounded (max 1000 artifacts) with unique artifact ids.
- A digest identifies content; matching a digest never makes content trusted.

## Path safety

`parseSafeRelativePath` rejects, among others:

- traversal: `..`, `.`, `a/../b`, `./x`
- absolute forms: leading `/`, drive letters (`C:`), UNC (`\\server\share`)
- backslashes anywhere (forward slashes only)
- empty segments (`a//b`), trailing separators
- control characters and `< > : " | ? *`
- segments starting with a space or ending with a space or dot
- Windows reserved device names (`CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`,
  case-insensitive, including with extensions)
- `~` segments, oversized paths (>1024 chars) and segments (>255 chars)

This is a **lexical** guarantee. Stores and workspaces must still
canonicalize and revalidate at use time against symlinks, junctions,
reparse points, and case folding, per the technical design.

## Example

```ts
import { createArtifactDescriptor, createArtifactManifest, parseSafeRelativePath } from "@ai-dev-os/artifacts";

const patch = createArtifactDescriptor({
  id: "artifact-7f3a",
  displayName: "task-12 implementation diff",
  kind: "patch",
  role: "output",
  mediaType: "text/x-diff",
  sizeBytes: 4_312,
  digest: { algorithm: "sha-256", hex: "…64 lowercase hex chars…" },
  classification: "proprietary-source",
  location: { type: "content-addressed", store: "local" },
  provenance: {
    producedBy: { type: "model", providerId: "provider-1", modelId: "coder-large" },
    runId: "run-42",
    taskId: "task-12",
    taskRunId: "attempt-3",
    traceId: "trace-42",
  },
  parents: ["artifact-11c0"],
  createdAt: "2026-08-02T10:03:21.000Z",
});

const manifest = createArtifactManifest({
  manifestId: "attempt-3-outputs",
  taskRunId: "attempt-3",
  artifacts: [patch],
  createdAt: "2026-08-02T10:03:22.000Z",
});
```

Serialization uses the canonical JSON helpers from `@ai-dev-os/domain`
(`toCanonicalJson` / `parseJsonText`); descriptors and manifests round-trip
losslessly through plain JSON.

## Verification

```
npm run typecheck -w @ai-dev-os/artifacts
npm run test -w @ai-dev-os/artifacts
npm run test:coverage -w @ai-dev-os/artifacts
npm run build -w @ai-dev-os/artifacts
```

The package's `pre*` scripts build `@ai-dev-os/domain` first so a clean
checkout always resolves its declaration files.
