# `@ai-dev-os/secrets-app-vault-electron`

This Windows-only Stage 18E adapter binds the pure application vault to Electron 43's asynchronous `safeStorage` API and to one fixed, atomically replaced file beneath `%APPDATA%/<AppName>/secrets`. Electron is a peer and development dependency, never a production dependency of the package graph.

The runtime floor is Electron `42.4.1`; development is pinned to the exactly reviewed runtime, `43.4.1`. The adapter declares Node `>=22.12.0`, matching Electron 43's tooling requirement while leaving the repository-wide floor unchanged. Construction is lazy and performs no Electron load merely because the package was imported. Every operation checks Windows, Electron readiness, and asynchronous encryption availability. There is no plaintext fallback.

Writes use an in-process queue, an exclusive inter-process lock, an exclusive temporary file, file flush, close, previous-generation backup, and atomic rename. The revision is re-read and the complete current document is parsed and integrity-checked while the lock is held. An unreadable primary is never quarantined, replaced, or silently treated as absent by a normal mutation.

Explicit recovery is a separate digest-bound atomic operation. It rechecks the exact observed primary and backup under the lock, preserves the displaced primary as `corrupt` or `identity-mismatch` evidence (or preserves an orphaned backup), then promotes the reviewed recovery document by atomic rename. Stale observations, stale `.bak` files during normal create, malformed requests, and partial recovery failures fail closed. These forensic copies remain local ciphertext bound to the same OSCrypt state; they are not exports or portable backups.

Electron `safeStorage` protects data using Chromium's OS cryptography. On Windows that is tied to the user/profile state held partly in Electron's `Local State`; copying only this JSON vault, changing application identity, or moving it to another user/machine is not a portable backup. The `.bak` file is only the immediately previous ciphertext generation and depends on the same OS key state.

Content protection, buffer zeroing, and encryption at rest are defense in depth. They do not defeat a same-user process, Windows Clipboard History, Cloud Clipboard, crash capture, swap, or all JavaScript string copies, and they do not constitute perfect erasure.

The production entry point exports only `createAppVaultManager`, `createAppVaultSecretBroker`, and Electron version-floor metadata. It constructs the asynchronous safe-storage and fixed-root filesystem ports internally; raw crypto or filesystem factories are not production exports. Injected bindings and the raw file port exist only under the declared `./testing` entry point.

The design was informed conceptually by the MIT-licensed [`ai-account-manager`](https://github.com/alijabbar04/ai-account-manager) source at commit `99be1cc6fa0fbbcfffcb4b7042d9bf0bf5ae0ae0`; no bundled runtime or application data was copied.
