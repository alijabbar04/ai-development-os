# Stage 18 ANT-02 fresh validation and development-acceptance checkpoint

## Outcome

`ANT-02` is proven by one fresh, separately authorized, no-retry Anthropic
validation through the reviewed production-disabled application-vault path.
The canonical create-only receipt body and terminal sidecar committed, and the
exact named projection ran once. The committed validator returned
`ANT02_PROVEN`.

This closes Stage 18 development scope only. `developmentAccepted=true` is now
derived from the acceptance matrix. `PLN-02` remains incomplete,
`productionAdmitted=false`, and Stage 20A is eligible but was not started.

## Exact reviewed subject

- HEAD: `f90a779fce8c14cb6c4c3166ed89b0af5355b660`
- tree: `f4a0035c03150970f700435af64cd2bd4e0968e4`
- source parent: `bd26bc1cf8238c23406fc5e0a63fed046c988136`
- source tree: `9ef3a12c3434d3a838da02706413c9573f235aa5`
- manifest: 14,304 bytes, SHA-256
  `f296c931bd9fa924126c9ff39a518f1a3d438b28ba76dd33580e0743c8a1b57d`
- manifest aggregate:
  `0cb4729cc4211dca11ef1f166ccd4340ad82db4ba50310c6b5e97244fcbd1d66`
- baseline hosted CI: run `32818821252`, attempt 1, all seven jobs passed
- Fable baseline: PASS, zero must-fix, 19,718 bytes, SHA-256
  `46b5750d227815c08d6b41acd7dbf46941eebed286cb0a8658bd50b94bdcc585`
- Opus baseline: PASS, zero must-fix, 30,135 bytes, SHA-256
  `505fb7028c54e09c3d543052bf3e45a16128078d93928fd085b8a9cff1340f7a`

Both reviews bind only the reviewed source candidate; neither PASS is
transferred to this closure candidate.

## Fresh operation identities

- authorization reference: `stage18-ant02-20260825T102700848Z`
- packet / receipt ID:
  `4a83dbdf2bbbae2767d15872fc744f1bbfc155326b1f1e2a34077619d17c0d72`
- packet size: 2,034 bytes
- marker namespace SHA-256:
  `93a926d5775a953e724c93f88e5bbe82587dd3c64e8620a0d63757e8d191f467`
- receipt: 1,707 bytes, 38 fields, SHA-256
  `9f5083f92b5616fd9b34d28d9dd75b333514c9e74b9bc15914d4c27ae4ffe0b4`
- request: 116 bytes, SHA-256
  `0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a`

The new marker, receipt body, and terminal sidecar paths were each checked by
exact name and were absent before launch. No directory was enumerated. The
packet was consumed before credential resolution, as required by the reviewed
implementation.

The receipt evidence path is the repository's sole `.gitattributes` entry and
is pinned as `text eol=lf`. This preserves the projected canonical 1,707 bytes
on Windows checkouts rather than allowing `core.autocrlf` to materialize a
different 1,708-byte working-tree document.

## Result proved by the receipt

- One provider dispatch attempt was made.
- Dispatch count `1`; retry count `0`; fallback count `0`.
- Response received; HTTP 200.
- Accepted model echo: `claude-haiku-4-5-20251001`.
- Accepted content: exactly one text block containing exactly `OK`.
- Result: `valid` / `VALIDATION_OK`.
- Provider duration: 774 ms.
- Usage: 12 input tokens, 4 output tokens.
- Credential resolution count: 1. The credential was supplied only as the
  request-scoped Anthropic authentication required by the authorized dispatch;
  it was not displayed, exported, logged, projected, committed, or retained.
- Response-body retention: none.
- Production state: disabled.

The raw provider body and credential are not evidence and were never displayed,
logged, committed, or projected. The terminal receipt exists only because the
reviewed strict provider parser accepted HTTP 200, the exact model echo and
content shape, then the receipt body and sidecar both committed. UI copy was
used only to decide when normal close was safe; it was not acceptance evidence.

## Lifecycle

The reviewed host launched once, the Anthropic `Manage`, `Validate connection`,
and `Confirm and validate` controls were each invoked once, and a task-owned
guard prevented a second confirmation. The host was closed normally after the
terminal result and both receipt files were present. The launcher exited 0 and
the final reviewed-host process count was zero.

The exact named receipt projection ran once from `10:30:39.574Z` to
`10:30:39.711Z`. Its 1,707 output bytes have the same SHA-256 as the committed
receipt. No second projection, provider request, host launch, marker, packet,
credential access, or retry occurred.

## Acceptance derivation

| Row or state | Result |
| --- | --- |
| `AM-02` | proven |
| `INT-01` | proven |
| `ANT-02` | **proven** |
| `PLN-02` | incomplete; production-track |
| `developmentAccepted` | **true**; all development-blocking rows proven |
| `productionAdmitted` | false |
| Stage 20A | eligible, not started |

The earlier missing-envelope success remains `BLOCKED_EVIDENCE`; it is not a
source for any field in this proof. Frozen Phase A audit outcomes remain frozen
and `PLN-02` is not inferred from this operation.

## Validation and publication

The immutable Stage 18E-I manifest verifier remains pinned to reviewed HEAD
`f90a779fce8c14cb6c4c3166ed89b0af5355b660`, its exact tree and manifest
digest. The conditional repository gate permits only ancestry-preserving
descendants that retain that exact committed manifest blob. Because this
closure changes bytes beyond the reviewed candidate, its build explicitly
removes the live-validation candidate binding; only the exact reviewed HEAD can
emit that binding. Thus ordinary closure CI cannot accidentally make changed
runtime or documentation bytes eligible for another live validation.

The closure candidate must pass the focused acceptance/evidence tests, affected
package suites, root check, root coverage, audit, manifest verification, secret
scan, maintained packed-consumer gate, independent read-only review, non-force
publication, clean ref equality, and exact-head hosted CI before completion.
Final exact-head run identity is reported in the external completion handover;
embedding a run id in the commit that produced it would change that HEAD.
