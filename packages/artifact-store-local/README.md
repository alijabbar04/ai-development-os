# @ai-dev-os/artifact-store-local

Local filesystem implementation of the `@ai-dev-os/artifact-store`
content-addressed byte store. Passes the shared adapter contract suite in
both durability modes on Windows and Linux.

## Usage

```ts
import { createLocalArtifactStore } from "@ai-dev-os/artifact-store-local";

const store = await createLocalArtifactStore({
  root: "C:/Users/me/AppData/Roaming/ai-dev-os/artifacts", // absolute; created if missing
  clock: injectedClock,          // optional
  idSource: entropySource,       // optional; 32 lowercase hex chars per call
  defaultMaxWriteBytes: 1 << 30, // default 1 GiB
  durability: "flush",           // default; or "fast"
});
```

## Storage layout (layout version 1)

```text
<root>/
  v1/<algorithm>/<hex[0..2]>/<full-hex>   committed objects
  tmp/w-<32 lowercase hex>.tmp            in-flight writes
```

Every path component is either a fixed literal or validated lowercase hex
from the digest parser, so physical paths contain no user input: no display
names, no traversal, no drive-letter or UNC injection, no case-folding
ambiguity, bounded lengths, and no collisions between algorithms. A future
layout change ships as `v2/` beside `v1/`, enabling offline migration.

## Security model

- The configured root must be an absolute, NUL-free, non-URI path; it is
  created, then **pinned** via `realpath` at open.
- Before promotion, the object's parent directory is created and its
  `realpath` is verified to remain inside the pinned root — a
  symlink/junction planted at a layout directory fails the write with
  `UNSAFE_FILESYSTEM_STATE` (covered by a junction test on Windows).
- Object locations occupied by non-files, and same-digest objects with a
  different size, are reported as `UNSAFE_FILESYSTEM_STATE`, never used.
- Caller-provided symlinks are never followed: callers cannot provide paths
  at all, only validated digests.
- Deletion resolves paths exclusively from validated digests and cannot
  escape the root.
- Temp files use exclusive create (`wx`) with injected 128-bit-hex names;
  repeated collisions abort rather than reuse a file.
- **Portable limitation:** the realpath containment check happens at use
  time; Node offers no portable way to close the remaining
  check-to-use window (no `openat`). An attacker who can swap directories
  inside the store root mid-operation already controls the data directory.

## Write, verification, and promotion

Writes follow the port's documented lifecycle: exclusive-create temp →
stream with incremental digest/size and live `maxSizeBytes` enforcement →
flush → expectation checks → containment check → atomic `rename` into
place. Failed writes always remove their temp file; a partially written
final object is never visible, because nothing is ever written at the final
path directly.

**Deduplication:** if the object already exists (size-checked), the temp is
discarded and the result reports `deduplicated: true`. Under a concurrent
identical write, `rename` may atomically replace a just-promoted identical
object (`MOVEFILE_REPLACE_EXISTING` on Windows, atomic rename on POSIX), so
two racing writers can each report `newlyStored`; the bytes are identical
either way, and different bytes can never collide because the path is the
verified digest. Windows `EEXIST`/`EPERM` rename refusals are re-checked
and treated as dedup. No process-wide mutex exists or is needed.

## Durability

| Mode | Behavior |
| --- | --- |
| `flush` (default) | `fsync` the temp file before promotion; after rename, best-effort `fsync` of the parent directory on POSIX (directory handles cannot be fsynced on Windows). After a crash, objects whose write completed have durable contents; the directory entry itself may be lost on power failure on Windows (and on POSIX only if the best-effort dir sync failed) — the object is then simply absent, never corrupt. |
| `fast` | No fsync; contents reach disk at the OS's discretion. Functionally identical, verified by a second contract run. |

Sudden process termination leaves at most orphaned `tmp/w-*.tmp` files.

## Temporary-file recovery

`cleanupTemporaryFiles({ olderThanMs })` removes only **regular files whose
names match the store's own strict format** (`w-<32 hex>.tmp`), aged
against the injected clock; everything else in `tmp/` is retained no matter
how old. Per-file failures are counted in the report rather than thrown;
only an unlistable temp directory raises `CLEANUP_FAILED`. Cleanup never
leaves `tmp/`. Startup cleanup is caller-driven (call it after opening).

## Windows/POSIX behavior

One code path serves both platforms: validated-hex paths sidestep
case-folding and reserved-name issues; `rename` is atomic-replace on both;
junction containment is enforced via `realpath`; directory fsync is
POSIX-only (documented above). Tests run per-test isolated temp roots and
are parallel-safe.

## Known limitations

- Check-to-use window on the containment check (documented above).
- Hard links inside the store are not created by the store; externally
  created hard links to objects survive `delete` of one name (standard
  filesystem semantics) — the retention service owns physical reclamation
  policy.
- No encryption at rest yet; the transformation boundary is the seam for
  the later encryption hook.
