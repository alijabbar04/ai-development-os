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

Therefore Electron is pinned as `~43.4.1`, with runtime and peer floor
`>=42.4.1`. Electron 43's package tooling requires Node `>=22.12.0`, so that
floor is declared on the new adapter package without changing the repository's
existing root `>=22.9.0` contract for unrelated packages. Electron may appear only
as a peer dependency of the adapter and a development dependency where tests or
the host require it; it appears in no production `dependencies` block. Every
supported patch upgrade and every stable major must rerun safe-storage behavior,
custom-protocol, IPC, packaging, audit, and Electron smoke gates. Electron 44 is
evaluated when stable rather than adopted from beta.

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

“Clear the clipboard after saving” defaults on, remains visibly selectable per
save, and is remembered only after an intentional settings change. The application
never reads clipboard contents. If selected, main clears only after a confirmed
vault commit and reports the actual clear result. Copy explains that Windows
clipboard history and cloud synchronization may retain earlier entries.

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
