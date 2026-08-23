# ADR 0033: Stage 18E application-owned credential vault and bounded credential-setup host

Status: Accepted

Date: 2026-08-19

Related: ADR 0019 (Windows-first production scope), ADR 0027 (Stage 18 live
boundary), ADR 0028 (Windows credential secret broker), ADR 0032 (Stage 18
development closure candidate integration)

## Context

ADR 0028 deliberately introduced an exact-reference, read-only Windows Credential
Manager broker. Its native authority is limited to `CredReadW` and `CredFree`, and
its `replace` and `revoke` capabilities remain false. It deferred credential
creation to a separately reviewed operator-owned procedure rather than adding a
second native mutation surface solely to unblock a canary. That decision remains
historically accurate and technically valid.

The external one-shot procedures used after ADR 0028 are evidence, not a
supportable application workflow. Stage 18 therefore still lacks an ordinary,
reviewable way for an operator to provision the existing `SecretRef` pipeline.
The natural long-term surface belongs to the Stage 21 desktop setup wizard, but
Stage 21 depends on the Stage 20 boundary and neither stage has started. Pulling
orchestration into a credential window now would blur that dependency and could
make a working setup screen look like Stage 21 evidence.

The architecture and UX dossiers prepared on 2026-08-19 were independently
reviewed. Their must-fix findings are incorporated here, including the
conflict-then-retry token repair, the single mutation implementation, the exact
policy composition for reads, removal of redundant Electron controls, and the
version-1 one-slot limitation. This ADR also applies the operator's final
reconciliation: no reveal or confirmation mask, no copy or export, ordinary paste
remains available, and clipboard clearing defaults on while remaining visible and
optional.

## Decision

### 1. Split designation and stage boundary

Establish two bounded designations:

- **Stage 18E — application-owned secret-vault broker**: the provider-neutral
  vault contracts, broker, document model, deterministic ports, and Electron
  storage adapter.
- **Stage 18E-H — bounded `apps/credential-setup` host**: a temporary Windows
  credential-entry surface and an explicit Stage 21 advance fragment.

Stage 18E-H does not begin or complete Stage 21. It imports no orchestration
package, exposes no HTTP/API/daemon surface, and is superseded rather than expanded
when `apps/desktop` is implemented in Stage 21. A functioning credential host is
not evidence for any Stage 21 gate.

No acceptance row changes as a consequence of either designation.

### 2. Keep ADR 0028's broker read-only

`@ai-dev-os/secrets-windows` is unchanged. No `CredWriteW`, `CredDeleteW`,
enumeration, wildcard, prefix, migration, or mutation capability is added. ADR
0028 remains the decision for credentials already represented by exact `keychain`
references.

Stage 18E is a complementary backend with a distinct reference type, storage
location, and authority boundary. This amends the practical consequence of ADR
0028's deferred setup procedure without falsifying its rationale or history.

### 3. Reuse `encrypted-file` schema version 1

The new vault uses the existing `SecretRef` variant:

```text
type:               encrypted-file
namespace:          provider
containerId:        app-vault.v1
entryName:          anthropic | openai | gemini | openrouter
expectedKind:       text
version:            null
providerInstanceId: the exact instance declared by the slot catalogue
```

No new variant is introduced and `SECRET_REF_SCHEMA_VERSION` remains 1. A broker
is bound to one exact canonical reference. The existing `keychain` form is not
reused because ADR 0028 already assigns it to Credential Manager. A second schema
would create overlapping identities and migration risk.

Version 1 supports exactly one credential per provider slot. The record key is
`slotId`; an attempt to bind a different provider instance fails closed. Supporting
multiple instances requires a later schema version whose key is
`(slotId, providerInstanceId)` and a separate decision.

### 4. AI Development OS owns an independent vault

The vault is an AI Development OS data set. It does not read, share, import,
migrate, or depend on AI Account Manager's data directory, vault, Electron
`Local State`, application identity, or credentials. Concept-level prior art is
acknowledged under its MIT licence, but the implementation is reconstructed
against this repository's contracts.

There is no portable secret backup. Recovery is an explicit operator choice to
restore the immediately previous local generation, start over and re-enter, or
rebind metadata after an application-identity change. Ciphertext is bound to the
Windows user, machine/profile conditions, application identity, and Electron
OSCrypt state; loss of that state can make both primary and backup ciphertext
unrecoverable.

### 5. One atomic, versioned encrypted document

Schema version 1 is one strict, canonical JSON document at the application-owned
path `%APPDATA%/<AppId>/secrets/app-vault.v1.json`. It contains bounded metadata
and opaque ciphertext, plus an integrity digest over the canonical body. Bounds
are 32 records, 8,192 UTF-8 bytes per plaintext, and 1 MiB per document.

Writes use an exclusive temporary file in a private child directory on the same
filesystem, followed by flush, close, and atomic rename under a narrow in-process
serializer and exclusive lock file. Optimistic
revision comparison occurs inside the final write boundary. The previous valid
generation is retained as `.bak` for recovery.

An absent document is distinct from an unreadable, malformed, schema-ahead,
identity-mismatched, backend-mismatched, unknown-slot, backup-only, or
integrity-failing document. Normal create, rotate, revoke, and forget operations
never treat one of those states as empty and never overwrite it. Replacement is
available only through a separately named recovery operation bound to SHA-256
digests of the exact observed primary and backup bytes. The adapter preserves the
displaced primary, or an orphaned backup, under a bounded forensic filename before
the atomic recovery commit. There is no automatic quarantine, promotion, or
replacement path.

The manager obtains one revision-consistent snapshot from one primary read; it
reads the backup only when the primary is absent or corrupt. All four fixed slot
summaries in a ready snapshot carry that one document revision. Recovery tokens
are opaque, nonsecret observation tokens rather than authorization and must match
again inside the serialized, locked recovery boundary. Matching tokens do not make
an arbitrary rollback legal: backup restore is accepted only when the current
primary is corrupt/unknown-slot or absent with a valid backup. A readable primary,
schema-ahead document, backend mismatch, or identity mismatch refuses restore
without changing either primary or backup bytes.

Two consecutive decrypt failures for the same generation change that record to
`unrecoverable` while retaining its ciphertext and fingerprint evidence; a later
rotate explicitly replaces it with operator re-entry. Identity rebind is different:
it deliberately discards foreign-identity ciphertext and fingerprint fields and
retains only `unrecoverable` slot metadata in the newly bound document. A revoked
tombstone is removed only by the explicit, revision-bound `forget` operation.

Migrations are ordered, pure, forward-only transforms with gap detection. The
version-1 registry is intentionally empty because no behind-version document
exists, and the version-1 parser does not pretend to run a migration. Introducing
version 2 must add and connect the reviewed `1 -> 2` migration before parsing that
older format. Future migrations may transform metadata only; they must not decrypt,
export, or silently replace ciphertext. Downgrade is refused.

### 6. Async Electron `safeStorage`, no fallback

The Electron adapter uses only `isAsyncEncryptionAvailable()`,
`encryptStringAsync()`, and `decryptStringAsync()`. It waits for application
readiness, fails closed on temporary or persistent unavailability, and schedules
any `shouldReEncrypt` ciphertext-only commit through the same serialized write
path. Synchronous methods are not used. `setUsePlainTextEncryption` is never
called and there is no plaintext fallback.

Dependency evidence checked on 2026-08-19:

- Electron's official `safeStorage` reference recommends the async API and
  documents its non-blocking, key-rotation, and temporary-unavailability
  semantics: <https://www.electronjs.org/docs/latest/api/safe-storage>.
- npm package metadata reported `43.4.1` as the `latest` stable tag, published on
  2026-08-19.
- the official `v43.4.1` release includes further sandbox/window inheritance and
  custom-protocol fixes:
  <https://github.com/electron/electron/releases/tag/v43.4.1>.
- Electron supports only the latest three stable majors:
  <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>.

Therefore the credential host pins its development and peer runtime to exactly
`43.4.1`, and the adapter pins its development runtime to exactly `43.4.1`. The
reusable adapter retains its supported runtime peer floor `>=42.4.1`; that floor
does not select the host runtime. Electron 43's package tooling requires Node
`>=22.12.0`, so that floor is declared on the adapter package without changing the
repository's existing root `>=22.9.0` contract for unrelated packages. Electron
appears in no production `dependencies` block. Every patch or major change to the
exact host runtime must be intentional and must rerun safe-storage behavior,
custom-protocol, IPC, packaging, audit, and Electron smoke gates.

### 7. Read and write authority are deliberately different

Every credential read, including validation, passes through
`createPolicyAwareSecretResolver` and an allowed `secret-access` decision. No host,
manager, adapter, validation module, or recovery path reads or decrypts the vault
directly because the resolver is inconvenient. The broker is the only decrypting
component, and static policy enforces this composition.

Writes disclose nothing and cause no provider egress, so they are
operator-authorized rather than centrally policy-authorized. That authority is
narrow: a mutation is legal only when initiated by a validated IPC request from
the exact top frame of the credential window, using its main-minted session token,
in a legal session state. Any future non-UI writer requires a separate policy
decision. `broker.replace` and `broker.revoke` are the sole ordinary credential
save/remove implementation; the host manager delegates those operations and has no
decryption path. The separately named `forget`, restore, start-over, and rebind
operations are management-lifecycle transformations with their own source-state
guards, serialization, and optimistic observation checks.

The protected shared `SecretAuditRecord` vocabulary has only `availability`,
`resolve`, `replace`, `revoke`, and `close`. It records those broker operations
exactly. Management-lifecycle actions are not falsely reported as `replace` or
`revoke`; Stage 18E-H must record their validated IPC action in its separate,
session-scoped nonsecret activity stream before any such action is wired to UI.
Adding lifecycle verbs to the shared secret-audit schema would require a separately
reviewed protected-package change and is not smuggled into this stage.

The session token is session-scoped. A recoverable revision conflict returns to
editing and may retry with the same token and a freshly observed revision.
Concurrent submission is refused by state legality; a write after a successful
commit is refused as replay; the optimistic revision is the correctness backstop.

### 8. Bounded credential host

The Stage 18E-H renderer uses packaged local content over
`app-credential://entry/index.html`, a scheme registered with exactly
`{ standard: true, secure: true }`. It has a restrictive CSP including
`connect-src 'none'`, a dedicated non-persistent session, denied permissions,
navigation, windows, downloads, and unexpected attachment, and a window configured
with sandboxing, context isolation, no Node integration, and `webSecurity: true`.
Content protection is enabled as defence in depth and never described as a
guarantee.

The preload exposes one purpose-specific function per validated action and never
exposes raw `ipcRenderer`. Main validates sender, origin/frame, session state,
token, exact schema and bounds before work. There is no secret-returning IPC
channel.

Ordinary keyboard paste works through Electron's Edit menu role. There is no
reveal control, masked echo, copy, or export in either mode. The renderer clears
the password input synchronously before awaiting main; an interrupted response is
reported as unknown, not invented success or failure. The window and renderer
state are destroyed on completion or cancellation.

“Clear the clipboard after saving” has a fixed default-on value each time this
bounded host opens and remains visibly selectable for each save, rotation, or
re-entry. Version 1 has no persisted settings control and does not remember a
per-save opt-out. A future Stage 21 settings surface may introduce a separately
reviewed persisted preference. The application never reads clipboard contents. If
selected, main clears only after a confirmed vault commit and reports the actual
clear result. Copy explains that Windows clipboard history and cloud
synchronization may retain earlier entries.

Developer mode adds allowlisted nonsecret identifiers, fingerprints, finite codes,
and timestamps. It adds no authority or action. The host does not implement Stage
20 emergency-stop authority.

### 9. Save and validation are separate

Saving is local and never contacts a provider. A saved credential is described as
“Saved · not yet validated”, never connected or validated.

The host may expose an optional validation interface with a disclosed finite
outcome model, but live validation is disabled by default in this
production-disabled build. Validation is separately initiated, separately
disclosed, uses a stored credential through the policy-aware resolver, and is not
executed as part of this decision or implementation checkpoint. There is no hidden
validation, poller, automatic retry, or provider call on save.

### 10. Production and acceptance remain disabled

This decision changes no acceptance matrix row. In particular it does not prove
`ANT-02`, does not complete `PLN-02`, and does not alter
`developmentAccepted=false` or `productionAdmitted=false`. It does not enable
production, begin Stage 20/20A/21, authorize a real credential operation, or
authorize a provider call.

### 11. Implementation clarification after external review (2026-08-21)

The Stage 18E-H implementation uses the following exact interpretations. They
correct ambiguities found during external review without widening authority:

- The internal fixed slot identifier and provider instance are `gemini` and
  `gemini-default`; operator-facing copy says Google Gemini. The current bounded
  validation policy request also carries the internal provider identifier
  `gemini`. A future Stage 21 catalogue/provider integration must map that internal
  identifier explicitly if its canonical catalogue identifier is `google-gemini`;
  this checkpoint does not claim that mapping already exists.
- Informational badges retain both a visible text label and a visible boundary;
  colour is supplemental rather than the only state cue. Compact navigation keeps
  the accessible text “Production disabled” and shows the short visible text
  “Prod. off” instead of reducing the state to a bare dot.
- A provider attempt has one 10-second absolute deadline. The renderer waits up to
  12 seconds so the host can finish bounded secret cleanup and return a finite
  result; the extra two seconds do not permit another provider attempt.
- Nicknames are entry-time presentation metadata in version 1. There is no rename
  action while a credential is present. After removal, the existing state-bound
  re-entry path accepts corrected entry metadata together with the replacement
  credential; ordinary rotation cannot mutate those labels. A standalone rename
  control and authority remain an explicit Stage 21 gap.
- The ratified §7 paragraph above intentionally remains as the original reasoning.
  Its “session-scoped” Activity expectation is superseded by this dated
  implementation clarification: Activity is durable across host sessions in the
  strict presentation sidecar, bounded to the latest 50 nonsecret sentences, and
  unavailable rather than inferred empty if that sidecar cannot be read. This
  clarification changes no shared `SecretAuditRecord` vocabulary or protected
  package.
- Secret/metadata separation refuses direct and split containment plus a bounded
  set of common reversible disguises: NFKC compatibility forms, default-ignorable
  insertion, reversal, one-character printable ASCII shifts, and strict UTF-8
  base64, base64url, or hexadecimal encoding. The checks are bounded by the
  already-limited metadata fields. They reduce accidental persistence and simple
  renderer disguise; they do not claim to defeat arbitrary encoding chosen by a
  compromised renderer or code already running as the same Windows user.
- The host resolver binding exposes only `describeContainerBinding`, `resolve`,
  `evaluatePolicy`, and `close`. The broker and policy-aware resolver stay in the
  composition closure, so host consumers cannot bypass the policy-aware resolve
  operation through a raw property.
- The normal real-Electron smoke writes its preview only under its disposable
  temporary root. Updating the committed screenshot requires the exact named
  evidence-regeneration command; custom destinations and mixed modes are refused.
- The inherited Windows Credential Manager addon may be compiled and inspected for
  its exact export shape, but neither `availability` nor `read` is invoked by this
  checkpoint. The measured call count remains zero.

### 12. Production-host startup correction (2026-08-22)

The original production command delegated directly to Electron. On the repair
workstation, the allowlisted Electron runtime control `ELECTRON_RUN_AS_NODE` was
inherited and active. The pinned Electron executable consequently ran the built
entry as Node instead of entering the Electron application lifecycle. The one
authorized instrumented pre-fix launch returned without a visible window. No
bounded record was observable, and the Windows GUI launch route exposed no
captured exit code. Whether or which finite diagnostic phase executed is
unavailable; no phase or public code is inferred.

Read-only inspection and non-host synthetic probes established that first cause
without another real launch. The compiled entry executed under plain Node reached
the bounded `runtime-binding` failure and exited `1`, while a pinned-Electron
expression probe showed that the executable was operating in Node mode. No raw
control value or unrelated environment content was recorded.

The first repair candidate added a fixed launcher that removed only the proven
Node-mode control and then passed the compiled ESM entry directly to Electron.
The one authorized post-fix production-disabled launch consumed that candidate.
It produced one responsive Electron process but no renderer/GPU child and no
visible or accessibility-discoverable window; it emitted no bounded diagnostic
record and remained running past the bounded observation period. The launch was
interrupted once. The launcher then exited `1`, its task-scoped Electron child was
still present, and that exact child was terminated. No normal ready state, normal
close, clean self-shutdown, or finite phase/code was observed or inferred.

That consumed confirmation led to a synchronous CommonJS/package-root correction
that preserved privileged-scheme ordering and deterministic application-root
binding. Its later, separately authorized production-disabled launch created
three Electron processes, but after 67.6 seconds the responsive main process
still had window handle `0`, no visible or accessibility-discoverable window, and
no bounded diagnostic. The route was interrupted once; its exact remaining
six-process task tree was verified and terminated. All three named persistent
files remained absent, and no credential-capable action occurred.

A disposable Electron `43.4.1` lifecycle matrix then tested the leading
top-level-await hypothesis. A direct ESM package main with module-level awaited
readiness did deadlock. In contrast, both awaited and detached ESM startup reached
readiness and created a window when entered through the candidate's synchronously
completing CommonJS package main and dynamic import. The candidate's CJS-to-ESM
top-level await therefore did not cause the consumed 67.6-second failure.
Package-root controls established the actual cause: Electron evaluates its
package main with `require.main === module` false. The guarded CommonJS entry
never invoked startup, while an otherwise identical unconditional entry reached
readiness and created a window, exactly reproducing and resolving the responsive,
diagnostic-free, handle-`0` host state.

The current local correction uses a minimal unconditional
`startup-bootstrap.cjs` package entry and a
separate testable `startup-bootstrap-runtime.cjs`. The runtime validates exact
Electron `43.4.1`, fixes the application name, synchronously registers the
privileged `app-credential` scheme, and invokes asynchronous startup exactly once.
The fixed no-argument launcher validates that package main and passes the
application package root as Electron's sole argument, with a fixed working
directory. Using exact ASCII folding, it removes inherited `ELECTRON_` and
`NODE_` control namespaces plus `GOOGLE_API_KEY`, then fixes
`NODE_ENV=production`; it spawns without a shell. It accepts no forwarded
arguments and provides no development URL, storage override, debug-mode option,
or retry. The packed wrapper consumes the exported start result and does not
invoke startup twice.

The diagnostic boundary exposes only schema version `1`, the fixed operation
`credential-host-startup`, one reviewed phase, one reviewed public code, and
`terminal: true`. Foreign, hostile, inherited, accessor-backed, proxy, cyclic, or
otherwise unknown failures collapse to `STARTUP_FAILED`; raw messages, stacks,
paths, command lines, environment content, causes, and object serializations are
never emitted. It emits at most one JSON line, preserves exit code `1`, and uses a
hard process fallback only when no safe application exit exists or application
exit itself fails. Success is silent. A fixed, non-configurable 30-second
watchdog starts before asynchronous startup, tracks only the last reviewed phase,
is unreferenced, and is cleared at `surface-ready` or terminal failure. Expiry
emits one `STARTUP_TIMEOUT` record through the same one-terminal, one-exit
boundary. No environment, command-line, alternate-deadline, or retry route exists,
and late failure cannot emit or exit twice.

After exhaustive pre-launch gates and independent review, the candidate froze at
aggregate `2c7df08478a2688d6409cc7d83acf119d00214c0c8d153f9100d2ad52c7b2e30`.
Its one authorized production-disabled launch used exactly
`npm --prefix apps/credential-setup start`. Within the first 10.005-second
observation, Electron exposed one responsive accessibility window titled
`Credential setup — AI Development OS`. Its normal overview showed four provider
cards, zero saved credentials, production and live validation disabled, no
password/edit field, and no credential dialog. No action control was invoked.
The exact window then closed through `Alt+F4`; the route session completed, zero
task processes remained, all three named credential-state files remained absent,
and the frozen aggregate was unchanged. No numeric route exit code was retained,
so none is inferred. No credential, provider, clipboard, Windows Credential
Manager, Account Manager private-state, production, or network-validation action
occurred, and the launch authorization is consumed.

Focused source tests, a disposable Electron lifecycle probe, packed-runtime
validation, a fresh root check, and one fresh complete root coverage run exercise
the correction, including synchronous bootstrap order,
package-root identity, guarded-versus-unconditional entry behavior, watchdog
timeout/cancellation, hostile binding reads, failure terminality,
sandbox/context isolation, production-disabled state, and custom-protocol
renderer loading. The required real visible-ready confirmation and every
post-confirmation local gate passed. Final independent current-byte review also
passed with zero must-fix findings. The correction remains an uncommitted,
unpublished candidate with status `READY_FOR_PUBLICATION`; the authorized
source/evidence commit, manifest-only child, non-force push, and exact-head CI
remain to be performed.
No additional real launch is authorized. The correction grants no credential,
clipboard, provider, Windows Credential Manager, Account Manager, production, or
retry authority.

## Consequences

### Enabled

- The existing provider-neutral secrets contract gains an independently testable,
  write-capable backend without changing `@ai-dev-os/secrets`,
  `@ai-dev-os/policy`, `@ai-dev-os/provider-anthropic`, or
  `@ai-dev-os/secrets-windows`.
- A bounded Windows host can eventually accept an operator paste without a bespoke
  launcher, while remaining replaceable by Stage 21.
- Storage corruption, revision conflict, temporary encryption unavailability,
  key rotation, and secret-lifetime behavior can be tested through deterministic
  ports without Electron or a real credential.

### Costs and limitations

- Same-Windows-user compromise remains out of scope. DPAPI and `safeStorage`
  separate users and machines; they do not protect against code already running as
  the operator.
- Electron becomes a patch-tracked development/peer dependency with a large
  transitive surface.
- JavaScript strings and runtime/OS copies cannot be proven erased. The design uses
  callback scope, bounded lifetime, owned-buffer zeroing, and explicit nonclaims.
- Version 1 permits one key per provider slot.
- Loss of OSCrypt/application identity can require re-entry; neither the retained
  generation nor a forensic copy is a portable backup.
- `apps/credential-setup` is intentionally temporary.

### Recovery, rollback, and migration

- Recovery uses the last fully validated primary. If that is unavailable, the
  manager describes only state and digest-bound choices: restore a valid retained
  generation, start over from corrupt/unknown-slot or backup-only state, or rebind
  an identity-mismatched document. Neither startup nor a normal mutation silently
  promotes or replaces bytes, and every explicit recovery preserves displaced
  evidence before commit.
- A valid retained generation is restorable only from corrupt/unknown-slot or
  backup-only state. Observation digests are concurrency tokens, not rollback
  authority; a ready, schema-ahead, backend-mismatched, or identity-mismatched
  primary refuses restore byte-for-byte.
- A restore preserves ciphertext and therefore still depends on the same Windows
  OSCrypt state. Repeated decrypt failure retains the failing ciphertext in an
  `unrecoverable` record; identity rebind instead nulls foreign ciphertext as an
  explicit destructive choice and requires re-entry.
- Rolling back application code never downgrades, deletes, rewrites, or exports a
  newer vault. Older code refuses schema-ahead documents. Because production is
  disabled, rollback may also stop constructing the host and adapter while leaving
  encrypted bytes untouched.
- Existing Credential Manager entries remain independent and are neither migrated
  nor deleted. Account Manager state is never a migration source.

### Explicit rejections

Plaintext fallback, synchronous `safeStorage`, secret export, persisted or returned
key fragments, hidden validation, automatic provider calls, store enumeration,
portable encrypted backup, Credential Manager mutation, shared application vaults,
environment-controlled production vault paths, and orchestration imports in the
bounded host are rejected.
