# `@ai-dev-os/secrets-app-vault`

This package implements the pure, Electron-free Stage 18E application vault. It binds the existing `encrypted-file` `SecretRef` to one compiled-in provider slot, validates a strict canonical document, and exposes a text-only `SecretBroker` plus a host-only manager. The package owns no filesystem, Electron, network, shell, or process-launch authority.

The vault distinguishes an absent document from an unreadable, integrity-failing, unknown-slot, schema-ahead, identity-mismatched, backend-mismatched, or backup-only document. Normal mutations use optimistic revisions and a shared per-storage serialization boundary. An unreadable primary is always refused and is never silently replaced.

Plaintext is confined to the `SecretBroker.withSecret` callback and temporary encryption/decryption operations. Owned byte buffers are zeroed on a best-effort basis. JavaScript strings, VM copies, swap, crash capture, and hardware memory are outside that mechanism, so this package does **not** claim perfect erasure.

The four-slot catalogue is closed source code rather than a credential enumeration facility. Production exports contain no reveal, copy, dump, list-all, or export operation. `describeSnapshot()` captures one primary revision and returns only fixed nonsecret slot metadata; the backup is read only when the primary is absent or corrupt. `describeSlots()` is the slot projection of that same snapshot, so it cannot mix four separately read revisions.

The manager exposes revision-bound `create`, `rotate`, `remove`, and revoked-tombstone `forget` operations. Recovery is separately explicit: `restoreBackup`, `startOver`, and `rebind` require SHA-256 observation tokens returned by `describeSnapshot`, recheck the exact primary/backup bytes in the serialized storage boundary, and fail on a stale observation. Tokens identify bytes; they are nonsecret and grant no read or rollback authority. Restore is legal only for corrupt/unknown-slot or backup-only state; ready, schema-ahead, backend-mismatched, and identity-mismatched primaries refuse it without changing bytes. A normal create never consumes an orphaned `.bak`.

Manager `close()` is idempotent and drains every metadata, credential, forget, and recovery operation that entered before closure; each per-slot broker also accounts for `describeRecord()`. The shared `SecretAuditRecord` vocabulary is emitted only for its exact broker verbs and is not overloaded to disguise lifecycle actions as `replace` or `revoke`. A future credential host must record validated lifecycle IPC actions in its separate nonsecret activity stream.

Two consecutive decrypt failures for one unchanged generation mark the record `unrecoverable` while retaining its ciphertext and fingerprint evidence; operator rotation can then replace it. Identity rebind is deliberately different: it nulls ciphertext and fingerprint fields from the foreign identity, preserves only unrecoverable slot metadata, and requires re-entry. The storage adapter is responsible for preserving displaced recovery evidence before committing any explicit recovery.

Schema version 1 has no behind-version format, so `APP_VAULT_MIGRATIONS` is intentionally empty and is not invoked by the version-1 parser. A later schema version must add and connect a reviewed contiguous migration before accepting the older document; migrations are deterministic metadata-only transforms and may not change ciphertext.

The production root exports the broker, manager, fixed catalogue/contracts, strict reference helpers, document inspection, and migration contract. Deterministic crypto/random/storage implementations and testing factories are available only from `@ai-dev-os/secrets-app-vault/testing`.

## Prior-art attribution

The architecture was informed by the MIT-licensed [`ai-account-manager`](https://github.com/alijabbar04/ai-account-manager) source at commit `99be1cc6fa0fbbcfffcb4b7042d9bf0bf5ae0ae0`. Concepts were independently reconstructed; bundled runtime code and application data were not copied or accessed.
