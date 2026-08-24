# Stage 18E-I sanitized success-receipt threat model

Date: 2026-08-24

Scope: the future candidate-bound Anthropic validation success receipt, its
create-only local store, metadata pointer reconciliation, and isolated read-only
projection. This model does not authorize or perform validation.

## Assets and boundaries

The protected security claims are that a committed receipt corresponds to one
exact candidate, one consumed authorization, one fixed direct Anthropic dispatch
attempt, one independently validated success envelope, and one exact policy
decision; and that the receipt contains no credential or request/response
content.

The authorization marker remains the no-retry authority boundary. The provider
success envelope is an in-memory producer input. The receipt store is a separate
main-process evidence boundary beneath the application-data root. Metadata stores
only an exact receipt pointer and reduced outcome. The renderer receives only
the reduced outcome and truncated developer identifiers. The projection tool is
an offline, pre-named, read-only consumer.

Same-user compromise remains total. This design protects against parser,
composition, crash, ordinary race, and accidental disclosure failures; it does
not claim resistance to an attacker who can arbitrarily replace application
code, memory, and all same-user files while they are in use.

## Threats and controls

| ID | Threat | Control | Residual |
| --- | --- | --- | --- |
| SR-01 | The full success envelope is reduced before evidence commit | The application validator returns the full exact projection; the receipt commits before `Valid` reduction | A success from the original candidate was already reduced and cannot be repaired retrospectively |
| SR-02 | Two distinct success envelopes collide in evidence | Duration and input/output usage are exact receipt fields and the digest covers every canonical byte | SHA-256 collision is outside the operating threat model |
| SR-03 | Producer and validator drift together | Producer uses a literal projection; the receipt validator owns a separate exact key list and bounds; inverse tests mutate every promoting field | Both implementations remain in one repository and require independent review |
| SR-04 | Extra keys, accessors, proxies, polluted prototypes, duplicate JSON keys, unsafe numbers, or oversize input promote | Exact own data descriptors, ordinary-object prototype, finite safe-integer bounds, canonical byte equality, strict UTF-8, and 16 KiB maximum | Managed-runtime defects remain possible |
| SR-05 | Fake or injected transport creates evidence | Production wrapper rejects every runtime unknown key including `transport`; live canary separately pins its transport; receipt requires `direct-anthropic-https` and one observed dispatch | Compromise of production code is out of scope |
| SR-06 | Credential, authorization header, prompt/body, provider prose, private metadata, or record identity leaks | Flat scalar allowlist excludes those fields; leakage scans and planted synthetic canaries cover receipt, metadata, UI, errors, and projection | Crash/process memory during the bounded secret scope cannot be proven erased |
| SR-07 | A partial receipt is treated as committed | Canonical body is created first; a separate exact commit sidecar is created last and binds ID, digest, and byte count; reads require both | Windows parent-directory entry durability cannot be proven through Node |
| SR-08 | Existing evidence is overwritten or a second process claims the attempt | Temporary and final names use `wx`/hard-link create-only semantics; the authorization marker is independently exclusive and consumed first | A local denial-of-service can precreate conflicting names |
| SR-09 | Symlink, junction, reparse, or path traversal redirects evidence | Absolute bounded root; resolved child containment; root `lstat`/`realpath` checks; non-file and symlink refusal; opened-handle identity plus post-read named-path identity; no user-supplied filenames beyond fixed hashes | Node lacks a portable `openat`/directory-handle-relative API, leaving a narrower same-user TOCTOU residual after the final check |
| SR-10 | Metadata claims Valid while receipt is missing, cross-slot, changed-candidate, or changed | New live-valid results require a receipt pointer; each description verifies body, sidecar, digest, ID, Anthropic slot/provider, and current candidate HEAD/tree/aggregate; committed receipt state is invalid in non-Anthropic metadata | Legacy reduced Valid remains locally truthful but is labelled `historical-missing` and cannot prove `ANT-02` |
| SR-11 | Receipt success followed by metadata failure loses evidence | Receipt commit precedes metadata; isolated projection addresses the receipt by authorization digest and candidate | UI metadata may remain stale until explicit later reconciliation work; it is never reconstructed automatically |
| SR-12 | Receipt failure permits another provider request | Marker consumption precedes secret resolution and receipt work; every receipt failure is nondefinitive and retains consumed state | Recovery requires a newly authorized future attempt, not a retry |
| SR-13 | Rotation, removal, disablement, close, deadline, or supersession applies stale knowledge | Existing operation reservation, abort/deadline checks, authoritative record-token comparisons, commit predicates, and final applicability checks remain in force; close drains an already-started receipt commit without attaching late Valid metadata | A receipt already committed for the old attempt remains historical evidence, not current credential knowledge |
| SR-14 | Projection opens the vault, enumerates state, mutates a marker, or contacts a provider | The tool requires exact root/ID/candidate flags, reads two fixed files only, has no Electron, vault, clipboard, marker, directory-enumeration, HTTP, or task dependency | Supplying a real receipt root is itself an evidence-session action and requires appropriate authority |
| SR-15 | Invalid content type is treated as JSON | Media-type parameters are split and the base media type must equal `application/json`; JSONP, JSON-seq, problem+json, and text types fail | Syntactically malformed parameters after an exact base type are ultimately constrained by the strict body validator |
| SR-16 | A JavaScript caller bypasses TypeScript `Omit<..., "transport">` | The production composition boundary requires an exact ordinary object with exact own data keys and refuses `transport`, unknown keys, symbols, accessors, proxies, and abnormal prototypes | The live canary retains its independent transport-kind validation |
| SR-17 | Callback broker accepts a substituted secret-access context | Runtime assertions pin ref, provider, purpose, text access form, public callback classification, operation ID, exact authorization reference, policy fingerprint, signal, and cloud locality | Policy tables remain centralized rather than duplicated in the adapter |
| SR-18 | Pre-dispatch filesystem work times out but mutates later | No detached timeout wrapper is used; dispatch eligibility is rechecked immediately after awaited preparation and expiry fails closed | Non-cancellable Node filesystem work can delay refusal and host close; it cannot dispatch after expiry |
| SR-19 | Receipt IO continues after a terminal deadline/UI response while retaining the secret callback | Exact success returns only a sanitized pending receipt; the resolver releases `SecretMaterial`, the satisfied effect timer is cleared, and host/UI await non-cancellable receipt settlement before any terminal response; a deadline loser never starts receipt IO | Receipt settlement can extend operator-visible wait and close, but it has no credential and cannot mutate after the response |

## Marker durability qualification

Marker creation retains atomic `wx` semantics. The gate pins the marker
directory's real path and filesystem identity, compares the new path and opened
handle identities before writing, flushes, closes, and checks them again before
yielding a claim. POSIX additionally syncs the opened parent directory. On
Windows it reopens and flushes the exact marker file identity. The latter does
not prove parent-directory durability and is not described as doing so. Sudden
power loss can therefore lose the new directory entry and make a later startup
observe no marker; absolute crash-resistant no-retry is not proven without a
separately reviewed native or operational durable-marker control. Any observed
identity or durability uncertainty after `wx` is a consumed ambiguous outcome.

## Nonclaims

This model does not prove the historical success envelope, `ANT-02`, Stage 18
development acceptance, production admission, or task execution. It does not
authorize access to the real vault, credential, marker, metadata, clipboard, or
receipt root. No general telemetry, analytics, provider logging, export, or
renderer receipt API is introduced.
