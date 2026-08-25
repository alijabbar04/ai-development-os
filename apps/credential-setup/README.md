# Stage 18E-H credential setup host

This is a production-disabled Windows Electron host for the exact committed Stage
18E application-owned vault. It loads only the three packaged credential UI files
through `app-credential://entry/index.html`, has no renderer network capability,
and exposes no read, reveal, copy, export, ciphertext, generic IPC, shell, process,
or development-server surface.

## Bounded IPC reconciliation

The six reviewed `credential-vault:*` channel names are preserved. The accepted UX
requires flat primitive inputs that the earlier IPC draft omitted: ownership,
authorising label, per-save clipboard choice, opaque credential identity, current
record revision/token, and durable enable state. Those inputs are therefore a
bounded schema extension. Enable/disable shares the reviewed non-secret
`credential-vault:remove` mutation channel with a closed `action` discriminator;
it is not a generic dispatcher. Main rechecks the authoritative slot, revision,
identity, and record token before every action.

The validation success envelope is also extended with finite, nonsecret effect
facts: whether the provider request was dispatched, whether its absolute deadline
expired, whether the underlying credential/transport work has settled, whether
the result and Activity sentence were durably recorded, and whether the checked
version is still current, discarded, or unconfirmed. Once dispatch occurs, later
local failures cannot be presented as a pre-effect refusal and never cause an
automatic retry. A deadline response does not release the global validation guard
or host close drain while provider/secret work is still settling. If an exact
success effect settles before that deadline, the resolver first releases the
secret callback; main then awaits local receipt settlement outside the effect
deadline before returning anything terminal. The renderer does not abandon that
evidence phase, and host close drains an already-started receipt commit.

The UI may switch Normal/Developer presentation locally because the reviewed six
channels deliberately include no event or mode-setting channel. Developer facts
are finite nonsecret values already returned by `describe`; the independently
captured action sets are identical in both modes.

## Candidate-bound Anthropic validation

Live validation is unavailable by default. A build contains a usable candidate
binding only at the exact Stage 18E-I manifest commit, and the UI exposes
**Validate connection** only for Anthropic when a separately supplied canonical,
unexpired one-shot authorization packet matches that binding and the existing
application-vault `SecretRef`. The authorization is durably consumed before
credential resolution and possible dispatch. Existing, partial, or ambiguous
markers remain consumed across an observed orderly restart; there is no
application retry path. The Windows hard-power-loss qualification below applies
to the durability of a newly created marker directory entry.

The one possible request is fixed to Anthropic Messages API version `2023-06-01`,
model `claude-haiku-4-5-20251001`, and the synthetic phrase “Reply with exactly
OK.”, with four output tokens, 65,536 response bytes, a 15-second effect bound,
five-second callback drain, and standard commercial API retention. The stored
credential remains callback-scoped in main and is never displayed. No packet or
marker is shipped in the repository.

## Sanitized success receipts

The original Stage 18E-I one-shot validation later succeeded, but its complete
success envelope was reduced to `Valid` before durable evidence persistence.
Credential validation succeeded, but the full ANT-02 evidence envelope was not
retained; the authorization is consumed and cannot be reused. The missing
duration and token observations are not reconstructed, and the historical local
Valid state is explicitly labelled `historical-missing` for evidence purposes.

A distinct fresh operation on 2026-08-25 used the exact externally reviewed
receipt-capable candidate, a new authorization packet and marker namespace, and
the existing enabled owned Anthropic application-vault `SecretRef`. One provider
dispatch attempt was made; no retry or fallback occurred. The canonical body
and terminal sidecar committed before Valid reduction, and the exact named
projection ran once. Its 1,707-byte, 38-field receipt has SHA-256
`9f5083f92b5616fd9b34d28d9dd75b333514c9e74b9bc15914d4c27ae4ffe0b4`
and proves the fixed request, accepted pinned model and exact `OK` response,
774 ms duration, 12 input tokens, 4 output tokens, and no credential or response
body retention. This forward evidence proves `ANT-02`; it does not reinterpret
the historical `BLOCKED_EVIDENCE` attempt.

For a future separately authorized attempt, main now preserves the complete
independently validated envelope until a flat, exact 38-field sanitized receipt
is committed beneath the fixed `success-receipts-v1` application-data root. The
receipt binds the repaired candidate, authorization digest/reference, hashed
marker namespace, request and policy fingerprints, direct transport, exact
duration/usage, one dispatch, timestamps, and terminal success. It contains no
credential, authorization header, request/response body, provider prose,
credential ID, record token, private metadata, or clipboard state.

The canonical receipt body is created and flushed first. A separate create-only
terminal sidecar then binds its ID, SHA-256, and byte count. Only both exact files
can return reduced `Valid` with a receipt pointer. Provider success followed by
any receipt failure becomes the finite nondefinitive **Receipt not saved** state;
the authorization stays consumed, no retry occurs, and prior definitive
credential knowledge is preserved. Committed pointer mismatch also fails closed
on restart.

The receipt is not exposed through renderer IPC. A later separately authorized
evidence session can use `project:anthropic-validation-receipt` to read one
pre-named receipt with exact candidate bindings. The tool neither enumerates the
receipt directory nor accesses the vault, credential, marker, metadata,
clipboard, Electron, task runtime, or provider. See ADR 0036 and the Stage 18E-I
receipt recovery runbook.

Marker creation remains exclusive `wx` and is verified against opened-handle and
directory identity before a claim is yielded. POSIX flushes the parent directory.
On Windows, Node cannot prove parent-directory fsync, so the exact marker is
reopened and flushed; no parent-directory durability claim is made. A sudden
power loss can therefore lose the new directory entry even though the target was
flushed, in which case startup could observe no marker and cannot prove the
attempt remains consumed. Absolute crash-resistant no-retry is not claimed for
that Windows failure mode; a future real attempt needs an operational or native
durable-ledger control before relying on that stronger property. Filesystem
promises are not wrapped in a detached timeout because they are non-cancellable;
expiry is rechecked after preparation and prevents any late dispatch in the
running process.

## Safety and project status

- Production is disabled. Live validation is disabled without the exact
  published candidate binding and a separately supplied valid one-shot packet.
- Electron is an exact-pinned development peer. `ensure:electron` explicitly
  restores and verifies the checksummed 43.4.1 runtime when its local dist is absent;
  the package does not rely on a nonexistent Electron lifecycle hook.
- Saving never invokes validation.
- Main refuses a nickname or authorising label that directly, compositionally, or
  through the reviewed bounded reversible forms represents the submitted
  credential. The strict at-rest metadata parser applies the same generic
  credential-shape rule to those forms.
- The production host constructs only the committed vault manager/brokers and a
  policy-aware resolver.
- Hosted Windows CI compiles and loads the inherited Credential Manager addon only
  to inspect its exact export shape. It invokes neither export and performs no
  Credential Manager lookup; the foundation's separately authorized native smoke
  is not rerun by this checkpoint.
- Deterministic validation and memory-vault ports exist only for tests and the
  disposable synthetic Electron smoke; fake transport cannot promote a live
  validation result.
- No installer, updater, provider login, credential export, or Stage 20/21 runtime
  capability is included.
- Clipboard clearing is fixed default-on for each host opening and remains a
  per-operation choice. This version has no persisted clipboard setting. Nicknames
  have no rename action while a credential is present; after removal, the existing
  identity-bound re-entry path accepts corrected entry metadata. A standalone
  rename control remains deferred to Stage 21.
- AM-02, INT-01, and ANT-02 are proven; PLN-02 remains incomplete;
  `developmentAccepted=true`, `productionAdmitted=false`, and Stage 20A is
  eligible but was not started.

## Screenshot evidence

`npm run smoke:real --workspace @ai-dev-os/credential-setup` writes its preview
only inside the reported disposable smoke root. It never updates tracked evidence.
After all renderer changes are final, the committed Stage 18E-H screenshot can be
updated only with:

```powershell
npm run regenerate:credential-host-evidence-screenshot
```

The wrapper accepts no custom destination and refuses extra, duplicate, or mixed
arguments. The evidence command still uses synthetic values and does not authorize
a provider call, Credential Manager access, or production activation.
