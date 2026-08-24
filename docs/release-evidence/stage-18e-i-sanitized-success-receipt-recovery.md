# Stage 18E-I sanitized success-receipt recovery

Date: 2026-08-24

This runbook describes evidence interpretation only. It authorizes no provider
request, vault or credential access, marker change, metadata repair, deletion,
or retry.

## Invariants

- The consumed authorization marker is never cleared, renamed, rewritten, or
  reused as recovery.
- Missing provider-result fields are never inferred from packet limits, metadata,
  the marker, UI copy, or a synthetic fixture.
- Receipt recovery/projection is read-only. During the original active operation
  only, an exact success releases the secret callback and then starts a tracked
  receipt commit; host/UI response and close await that commit. No later recovery
  process creates a missing body or terminal sidecar.
- A provider-success/receipt-write failure remains evidence-incomplete forever
  for that attempt.
- A new provider attempt requires a new, separately bound authorization and new
  marker namespace after the repaired candidate is independently reviewed and
  exact-head green.

## State interpretation

| Receipt body | Terminal sidecar | Metadata | Interpretation | Safe action |
| --- | --- | --- | --- | --- |
| absent | absent | legacy Valid / `historical-missing` | Historical reduced result only | Preserve local Valid if applicable; do not claim `ANT-02`; do not retry |
| present, exact | absent | any | Crash or failure before terminal evidence commit | Treat as `RECEIPT_INCOMPLETE`; preserve bytes; do not synthesize a sidecar |
| absent | present | any | Corrupt/inconsistent evidence state | Treat as invalid; preserve for investigation; do not synthesize a body |
| present, exact | present, exact and matching | pointer absent because metadata write failed | Durable receipt exists independently | A separately authorized evidence session may project the pre-named receipt; do not mutate metadata automatically |
| present, exact | present, exact and matching | committed pointer matches | Committed future success receipt | Revalidate exact candidate and digest before using it as evidence |
| present or sidecar corrupt, oversized, noncanonical, non-file, symlinked, mismatched, or candidate-substituted | any | any | Invalid evidence | Fail closed; preserve state; no retry and no automatic cleanup |
| any | any | credential version rotated, removed, disabled, closed, or superseded | Attempt is historical, not current credential knowledge | Do not attach the result to the current credential |

Create-only conflicts are not repaired in place. Temporary sanitized files left
by a crash may be preserved for forensic inspection, but are not receipts and
must not be enumerated by the normal projection path. This version intentionally
has no delete, overwrite, rename, repair, import, or automatic reconciliation
command for receipt evidence.

## Read-only projection boundary

A later authorized evidence-closure session must already know the exact receipt
root, authorization-packet SHA-256 (the receipt ID), and repaired candidate
HEAD/tree/manifest aggregate. After building the exact candidate, the narrow
tool shape is:

```text
npm --prefix apps/credential-setup run project:anthropic-validation-receipt -- \
  --root <absolute-pre-authorized-receipt-root> \
  --receipt-id <64-lowercase-hex-authorization-packet-sha256> \
  --candidate-head <40-lowercase-hex-head> \
  --candidate-tree <40-lowercase-hex-tree> \
  --manifest-aggregate <64-lowercase-hex-aggregate>
```

The placeholders are deliberately not usable values. The tool must not be run
against operator state during ordinary build, test, review, or publication. It
reads only the named receipt and sidecar, writes no repository or application
state, emits the exact canonical receipt on stdout, and emits
`receipt-sha256=<digest>` on stderr.

## Availability residuals

Node's filesystem promises cannot be cancelled safely. Marker preparation is
awaited rather than raced against a timeout that could detach a late state
mutation. The host checks deadline/abort immediately after preparation and
therefore prevents late secret resolution or dispatch, but a stuck filesystem
operation can delay refusal and close.

Receipt persistence uses the same non-cancellation rule without retaining the
secret callback. An exact provider success must settle inside the effect
deadline. The resolver then releases `SecretMaterial`, the effect timer is
cleared, and receipt persistence is awaited to settlement before any terminal
host or renderer response. Close drains a commit already in progress. If close,
rotation, disablement, removal, or supersession occurs during that wait, no late
Valid metadata is attached to current credential knowledge.

On POSIX, parent directory handles are flushed after marker and receipt entry
creation. Node does not provide a portable proof of Windows parent-directory
fsync. Windows reopens and flushes the exact created target and verifies identity
before and after. A crash that loses a directory entry is consequently surfaced
as missing/incomplete receipt evidence, never promoted or regenerated. For the
one-shot marker itself, loss of the newly created directory entry after a sudden
power failure can instead make a later startup observe the authorization as
available. The running process never clears or retries the marker, but Node alone
cannot prove absolute crash-resistant no-retry on Windows. A future real attempt
must not rely on that stronger property without a separately reviewed native or
operational durable-marker control.

## Historical attempt

Credential validation succeeded, but the full ANT-02 evidence envelope was not
retained; the authorization is consumed and cannot be reused.

The historical attempt has no recoverable `durationMs`, `inputTokens`, or
`outputTokens`. Its reduced metadata remains explicitly insufficient. This
runbook does not change `ANT-02`, development acceptance, production admission,
or Stage 20A eligibility.
