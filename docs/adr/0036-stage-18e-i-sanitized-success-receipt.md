# ADR 0036: Stage 18E-I sanitized success receipt

Status: Accepted

Date: 2026-08-24

Related: ADR 0027 (Stage 18 live boundary), ADR 0030 (Anthropic effect
classification), ADR 0031 (diagnostic envelope), ADR 0032 (development
closure), ADR 0033 (application-owned credential vault), ADR 0035
(candidate-bound Anthropic validation)

## Context

The original Stage 18E-I candidate was published at commit
`b438ed13b7213640e6a637d173bfefcf697ca9b8`, tree
`e16992277457ae6e621d6579c6bbb1c186e9d1dc`, and subject aggregate
`a0932fb572b5fe1f70aec062bc37bd7784581682aabe39ab35a01768d7197e26`.
One separately authorized, candidate-bound Anthropic validation genuinely
succeeded. The request must not be repeated and its authorization marker
remains consumed.

The candidate nevertheless could not retain the complete success evidence. In
the original `apps/credential-setup/src/main/anthropic-validation.ts`,
`exactAnthropicValidationSuccess` independently checked the complete provider
envelope and then, at the promoting return, replaced it with only
`{"outcome":"valid","resultCode":"VALIDATION_OK"}`. The validation port
returned that reduction directly. Metadata persisted the same two semantic
facts plus ordinary credential/version bookkeeping. The exact `durationMs`,
`inputTokens`, `outputTokens`, and remaining success-envelope fields ceased to
exist before metadata recording.

Synthetic collision tests showed that distinct full success envelopes reduced
to the same durable state. The authorization packet contains limits rather than
observations, and the marker proves pre-dispatch consumption rather than the
provider result. The missing observations therefore cannot be inferred or
reconstructed.

The historical result is:

> Credential validation succeeded, but the full ANT-02 evidence envelope was
> not retained; the authorization is consumed and cannot be reused.

This is `BLOCKED_EVIDENCE`, not a failed credential validation and not an
`ANT-02` proof.

## Decision

### 1. Preserve the complete validated envelope until evidence commit

The application-level Anthropic validator now returns its exact immutable
projection of the complete provider success envelope. It does not reduce that
projection to `Valid` inside the validator. The validation port combines that
projection with independently verified authorization, candidate, policy,
one-dispatch, operation, and clock facts to construct a sanitized receipt.

The fixed request is unchanged: endpoint, API version, model, 116-byte body and
request digest, four-token output limit, 65,536-byte response limit, 15-second
effect timeout, five-second callback drain, direct HTTPS transport, and standard
commercial API retention all remain those of ADR 0035. Credential access remains
one callback-scoped `SecretMaterial.useText` operation. No general provider or
task route is enabled.

### 2. Use one flat, exact, bounded receipt

Receipt version `ai-dev-os.stage-18e-i.anthropic-success-receipt.v1` contains 38
allowlisted scalar fields:

- schema, receipt, digest-convention, and operation versions;
- a bounded non-credential operation ID;
- Anthropic slot and `anthropic-default` provider identity;
- exact candidate HEAD, tree, and manifest aggregate;
- authorization-packet SHA-256 and bounded external reference;
- SHA-256 of the marker namespace, never the namespace itself;
- authorization retention, attempt limit, retry policy, and
  `consumed-before-dispatch` state;
- provider-result schema, request fingerprint, endpoint, API version, model,
  retention, success status, and direct transport;
- exact bounded duration, input tokens, and output tokens;
- model-substitution, fixed-body, repository-source, credential-retention, and
  response-body-retention facts;
- policy-decision fingerprint and dispatch count;
- start and completion timestamps from the existing host clock; and
- terminal state `validated-success`.

The receipt contains no credential, authorization header, request or response
body, raw header, provider prose, credential ID, record token, secret-derived
value, private metadata, or clipboard fact. Its maximum canonical size is 16
KiB. Its digest convention is SHA-256 over canonical UTF-8 JSON followed by one
LF; the digest is stored in a separate terminal commit record and is not
self-referential.

An independent validator owns its own exact key list and constraints. It refuses
unknown or duplicate keys, proxies, accessors, arrays, abnormal prototypes,
unsafe numbers, out-of-range values, malformed hashes, noncanonical UTF-8/JSON,
invalid timestamps, a duration longer than its same-clock host interval, a host
interval at or beyond the 20-second effect deadline, oversized bytes, and
inconsistent fixed values. The
producer is a separate literal projection and does not consume the validator's
key table.

### 3. Make receipt commit precede UI and metadata reduction

The success sequence is:

1. verify the exact candidate-bound authorization;
2. atomically consume the marker before secret resolution;
3. resolve the existing `SecretRef` in one bounded callback;
4. make at most one fixed provider dispatch attempt;
5. produce and independently validate the complete success envelope;
6. construct the sanitized receipt candidate and return it from the callback;
7. await policy-aware resolver completion so the secret callback is released;
8. clear the satisfied effect deadline and independently validate the receipt;
9. create and flush the canonical receipt body;
10. create and flush a separate terminal commit sidecar binding receipt ID,
   SHA-256, and byte count;
11. only then return the reduced `Valid` result with the receipt ID and digest;
12. recheck credential applicability and commit metadata/UI projection.

Receipt persistence is outside the secret callback and is never raced against a
timeout: Node filesystem promises are not cancellable. Once the provider effect
has settled before its absolute deadline, the host and renderer await evidence
settlement before returning a terminal response, and host close drains an
already-started commit. A provider effect that loses the deadline race never
starts receipt persistence.

The receipt ID is the authorization-packet SHA-256. Files are addressed exactly
as `<receipt-id>.receipt.json` and `<receipt-id>.commit.json` beneath the fixed
private `success-receipts-v1` root. The store never enumerates the directory.
Both files use create-only temporary-file write, file sync, and same-filesystem
hard-link promotion. A receipt is committed only when the independently exact
terminal sidecar and canonical receipt body agree.

On POSIX, the default durability barrier flushes the parent directory. Node does
not expose a portable, provable Windows parent-directory fsync contract. On
Windows the implementation reopens and flushes the exact newly linked target.
This is a stronger target-file barrier, not a claim of parent-directory
durability. Missing either body or sidecar therefore remains explicitly
incomplete after a crash.

### 4. Fail provider-success/local-evidence disagreement closed

A provider success followed by receipt validation, write, sync, close, link, or
terminal-sidecar failure becomes the finite nondefinitive outcome
`evidence-incomplete` / `EVIDENCE_RECEIPT_UNAVAILABLE`. It does not imply that
the credential is invalid, does not establish `ANT-02`, and cannot restore or
retry the consumed authorization. Existing definitive credential knowledge is
preserved under the established race rules.

New valid metadata must carry a committed receipt ID and SHA-256. Legacy valid
metadata is parsed as `historical-missing`, preserving local credential truth
without converting it into evidence. On every description, a committed pointer
is re-read through the exact receipt store and must match the Anthropic slot,
provider instance, and exact current candidate HEAD/tree/manifest aggregate;
missing, corrupt, cross-slot, changed-candidate, mismatched, or incomplete
receipt state projects nondefinitively as evidence-incomplete.

Receipt success followed by metadata failure does not destroy the receipt. A
later evidence session may project that pre-named receipt independently, but the
application does not regenerate metadata or infer the missing full envelope.

### 5. Keep evidence projection isolated and read-only

`project-anthropic-validation-receipt.mjs` accepts one absolute receipt root,
one exact receipt ID, and exact candidate HEAD/tree/manifest aggregate. It reads
only the two pre-named bounded files, validates their identity and canonical
bytes, emits the unchanged canonical receipt to stdout, and emits its SHA-256 to
stderr. It performs no enumeration, credential or vault access, marker or
metadata mutation, Electron launch, provider access, task execution, or retry.
It is not exposed over renderer IPC.

### 6. Preserve conservative one-shot marker semantics

Exclusive `wx` creation remains the consumption boundary. After `open`, the gate
immediately becomes consumed, pins the real marker-directory path and filesystem
identity, compares path `lstat` to opened-handle identity before the write,
flushes the handle, and rechecks identities after close. POSIX flushes the parent
directory; Windows reopens and flushes the exact marker identity. Any
post-creation uncertainty yields `AUTHORIZATION_AMBIGUOUS` and no claim object.
It never restores eligibility.

The Windows target-file flush does not prove persistence of the newly created
directory entry across sudden power loss. If that entry is lost, a later startup
can observe no marker and cannot prove consumed state. The running application
has no retry path, but absolute crash-resistant no-retry requires a separately
reviewed native or operational durable-marker control and is not claimed here.

Node filesystem promises are not cancellable. Wrapping marker preparation in a
timeout would leave a detached `mkdir`/`open`/`sync` capable of mutating state
after a refusal. That design is rejected. Existing expiry and abort checks occur
immediately before and after preparation, so a slow operation can delay refusal
or close but can never enable late dispatch. This availability limitation is
recorded rather than hidden.

## Recovery and consequences

- A body without a valid terminal sidecar is incomplete and never promotes.
- A sidecar without a body, a digest/length/candidate disagreement, a non-file,
  or a corrupt/oversized document is invalid and never promotes.
- Create-only conflicts never overwrite prior evidence.
- Software restart never regenerates lost result fields or clears an observed
  marker; the Windows hard-power directory-entry residual above remains.
- Rotation, removal, disablement, closure, deadline, or supersession prevents a
  late result from updating current credential knowledge; any already committed
  receipt remains historical evidence for its consumed attempt only.
- A new attempt requires a new separately reviewed candidate-bound authorization
  and a new marker namespace. This ADR does not create either.
- The original successful result remains unprovable. The repair only makes a
  future separately authorized success retainable.

Project truth is unchanged: `AM-02` and `INT-01` are proven; `ANT-02` and
`PLN-02` are incomplete; `developmentAccepted=false`;
`productionAdmitted=false`; Stage 20A is ineligible.
