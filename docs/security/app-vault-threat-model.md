# Application-owned credential vault threat model

Date: 2026-08-19

Scope: Stage 18E vault packages and the bounded Stage 18E-H credential-setup host.
Status: production-disabled. No real credential or provider operation is evidence
for this model.

## Security boundary

**DPAPI and Electron `safeStorage` do not protect against malicious software
already executing as the same Windows user.** On Windows the async safe-storage
key is protected through DPAPI. This separates users and normally machines; it
does not separate two processes running as the operator. Such a process can read
application files, invoke equivalent OS cryptography, inspect process memory, read
clipboard state, attach a debugger, or replace the application.

This is the same fundamental limit already recorded for the read-only Windows
Credential Manager broker. Content protection is also defence in depth, not an
authorization or confidentiality boundary.

Stage 18E removes routine disclosure paths: no plaintext on disk, configuration,
logs, errors, audits, exports, command lines, URLs, screenshots, diagnostics, or
renderer responses; no enumeration surface; no provider call on save; and no
long-lived secret object. It does not claim perfect erasure of JavaScript strings,
runtime copies, crash memory, or OS internals.

## Assets

| Asset | Sensitivity and treatment |
| --- | --- |
| Provider API-key plaintext | Highest; exists only in the active password field, one IPC request, encryption/decryption scope, and a policy-authorized callback. |
| Vault ciphertext | High; bounded, integrity-protected, atomic, and never silently replaced when unreadable. |
| Electron OSCrypt state | High; disclosure with ciphertext permits same-user decryption; loss can require re-entry. |
| Vault metadata | Low but sensitive operational data; strict allowlists prevent paths, ciphertext, salts, and key fingerprints from Normal-mode projection. |
| References and reference fingerprints | Nonsecret bounded identifiers; never an authority by themselves. |
| Validation outcomes | Nonsecret but potentially revealing; timestamped and never promoted to a standing “connected” fact. |

## Trust boundaries

1. **Renderer to preload:** renderer content is untrusted. The preload exposes only
   purpose-specific functions and no raw Electron object.
2. **Preload to main:** the primary enforcement boundary. Sender, exact top frame
   and origin, dedicated session, token, exact payload schema, bounds, and state
   legality are validated before work.
3. **Main to crypto/filesystem:** injected ports map all foreign failures to finite
   codes. The pure package has no filesystem, Electron, network, shell, or process
   authority.
4. **Broker to consumer callback:** every read has an allowed central
   `secret-access` decision; material is callback-scoped and owned buffers are
   zeroed best-effort.
5. **Application to other same-user applications:** not a security boundary.

## Threat register

| ID | Threat | Controls | Residual |
| --- | --- | --- | --- |
| AV-01 | Compromised credential renderer captures a paste | Packaged local content, restrictive CSP with `connect-src 'none'`, sandbox, context isolation, no Node, no navigation/window/download/permission surface, short-lived dedicated window | Compromise during paste can observe that entered value; same-user compromise remains total |
| AV-02 | Forged IPC from another frame/window/session | Exact known `WebContents`, top-frame and URL equality, dedicated session identity, timing-safe token comparison, exact operation schemas, legal-state gate | Compromise of the legitimate renderer already holds its own session authority |
| AV-03 | Prototype pollution, proxy, getter, symbol, or hostile object graph | Own-data-descriptor projection, plain/null prototype only, exact string key set, no accessors, flat primitive bridge records | Electron/contextBridge implementation defects require prompt patching |
| AV-04 | Replay or double submission | Session-scoped token plus `submitting` illegality, `committed` replay refusal, server-held optimistic revision inside the final write boundary | A recoverable conflict intentionally keeps the same token valid for retry |
| AV-05 | Navigation or remote renderer substitution | Fixed custom URL, three-file allowlist, normalized traversal check, no dev-server/environment branch, navigation/redirect/window denial | Application binary replacement is inside the same-user limit |
| AV-06 | Renderer exfiltration | CSP `default-src 'none'` and `connect-src 'none'`, no network API in UI, no shell/external URL bridge, no service worker or webview | A second same-user capability can exfiltrate outside the renderer |
| AV-07 | Secret returned after save | No read/reveal/copy/export/mask response; password node cleared synchronously before awaiting and window destroyed; no key-shaped DOM attributes or state | Browser/runtime memory may retain implementation copies temporarily |
| AV-08 | Clipboard residue | Ordinary native paste only; no clipboard read/watch; visible default-on clear happens only after confirmed commit and reports actual result; history/cloud limitations disclosed | Current clipboard can change between paste and clear; Windows history/cloud may retain earlier items |
| AV-09 | Plaintext fallback or blocking encryption | Windows-only operation guard, readiness and async-availability gates, async methods only, static ban on `setUsePlainTextEncryption` and sync methods | Temporary OS/key-provider unavailability prevents operations |
| AV-10 | Lost or changed OSCrypt/application identity | Container binding checked before decrypt, finite identity/decrypt states, two-failure retry bound, retained-ciphertext `unrecoverable` state, and explicit identity rebind that nulls foreign ciphertext | Ciphertext may be genuinely unrecoverable and re-entry may be required |
| AV-11 | Corrupt vault overwritten as empty or healthy vault rolled back | Absent and unreadable are distinct; strict exact parser and digest; normal mutations refuse; restore/start-over are separately named, exact-observation-bound and source-state-bounded operations that preserve displaced evidence before commit | Explicit start-over intentionally replaces the active corrupt state after preserving a forensic copy |
| AV-12 | Torn or lost write | Exclusive temp in a same-filesystem private child directory, bounded name retries, flush, close, atomic rename, previous-generation backup, cleanup on failure | Media and OS-level failure remain possible |
| AV-13 | Concurrent lost update | Per-container in-process serializer, exclusive lock file, stale-lock bounds, one captured-revision metadata snapshot, optimistic revision checks, and digest-bound recovery observations rechecked at final write | Stale-lock recovery has a bounded race; revision or byte digest remains the correctness backstop |
| AV-14 | Schema confusion or downgrade | Exact keys at every level, safe-integer and size bounds, closed enums, canonical serialization, ordered forward-only migration registry with gap detection, schema-ahead refusal | New schema versions require new review and fixtures |
| AV-15 | Slot/provider-instance aliasing | Closed four-slot catalogue, exact `encrypted-file` binding, construction-time instance match, one-slot/one-key version-1 statement | Multiple keys for one provider slot are unsupported until a schema bump |
| AV-16 | Unauthorized read | Broker is the sole decryptor; all host/provider reads route through `createPolicyAwareSecretResolver`; denied/conditional decisions prove zero storage access; static import/call policy | A trusted consumer can copy the immutable text inside its authorized callback |
| AV-17 | Unauthorized write | Manager can be constructed only in the credential host; every mutation originates in a validated legal IPC session; broker `replace`/`revoke` are the sole ordinary credential save/remove implementation and emit secret-audit attempt/outcome | Lifecycle actions use separate guarded manager paths and require a nonsecret host activity event; any future non-UI writer needs a separate policy decision |
| AV-18 | Secret-bearing errors, audits, logs, snapshots, or diagnostics | Fixed finite messages and codes, no causes/paths/native text, safe audit projection, redacted inspection/serialization, nonsecret SHA-256 recovery observation tokens, planted canary tests across artifacts | Process crash dumps during a short plaintext scope may contain memory |
| AV-19 | Use after callback or close | `SecretMaterial` disposal, owned-copy zeroing, broker and manager active-operation accounting, idempotent close drains metadata, credential, forget, and recovery work and refuses from inside an active callback | Perfect erasure cannot be proven in managed runtimes |
| AV-20 | Hidden provider activity | Saving has no probe/network dependency; validation is a separate disclosed opt-in action, disabled by default; stored read goes through policy; finite outcomes and no hidden retry | A later separately authorized validation necessarily transmits the key as authentication |
| AV-21 | Validation result applied to a replaced/removed key | Dispatch identity binds slot and credential fingerprint; late mismatched results are dropped; mutation actions are disabled while a check is active | Engine-side races still produce a disclosed discarded result |
| AV-22 | Devtools, capture, diagnostics | Devtools disabled, crash upload absent, content protection before show, renderer-side leakage assertions | Screen photography and same-user debugging remain possible; content protection is not a guarantee |
| AV-23 | Dependency vulnerability or package drift | Supported patched Electron pin, lockfile, audit, peer/dev-only placement, static imports, packed-consumer tests, exact-head CI | Electron has a continuing advisory cadence and must be upgraded promptly |
| AV-24 | Coupling to another application's secret state | No Account Manager path, identity, vault, `Local State`, IPC, import, or migration; source-policy checks | An operator may independently store the same key in two products |
| AV-25 | Working UI misread as acceptance | Production-disabled construction, no acceptance edits, explicit Stage 18E-H/Stage 21 boundary and nonclaims | Human misreading cannot be eliminated; repeated exact state is required |

## Recovery invariants

- A missing document may be created. An unreadable, integrity-failing,
  unknown-slot, identity-mismatched, backend-mismatched, schema-ahead, or
  backup-only state refuses every normal mutation.
- The retained backup is recoverable ciphertext, not a portable backup and not an
  automatic source of truth.
- `describeSnapshot` captures one primary revision and reads a backup only for an
  absent or corrupt primary. Recovery actions are explicit and bound to digests of
  those exact bytes; a stale observation fails as a conflict.
- Restore, start-over, and rebind preserve the displaced primary or orphaned backup
  before the atomic commit. Restore is legal only for corrupt/unknown-slot or
  backup-only state; a healthy primary cannot be rolled back merely by presenting
  matching digests. Start-over is legal only for corrupt/unknown-slot or
  backup-only state. Identity mismatch permits only rebind; backend mismatch and
  schema-ahead have no destructive action.
- The first decrypt failure remains retryable. A second consecutive failure for
  the same generation records `unrecoverable` while retaining ciphertext and
  fingerprint evidence. Identity rebind is a distinct explicit action that nulls
  foreign-identity ciphertext and requires re-entry; neither case fabricates
  absence.
- A revoked record remains a tombstone until an explicit revision-bound `forget`.
- Rollback never performs a downgrade or deletes a vault. Schema-ahead is refused.
- Account Manager and Credential Manager are not migration sources.

## Accepted residual risks

1. Same-user compromise is total.
2. A renderer compromised during the paste can see that value.
3. OSCrypt loss can require re-entry.
4. Managed-runtime and crash-memory copies cannot be proven erased.
5. Clipboard history/cloud synchronization are outside the application's control.
6. Content protection is defence in depth only.
7. Electron requires continuous patch tracking.
8. Version 1 supports one credential per provider slot.

## Nonclaims

This threat model does not prove a real credential save, provider validation,
`ANT-02`, Stage 18 acceptance, production admission, or Stage 21. It authorizes no
credential, clipboard-history, Account Manager, historical launcher, or provider
operation.
