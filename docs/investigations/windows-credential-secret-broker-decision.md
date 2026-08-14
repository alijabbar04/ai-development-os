# Windows credential secret-broker decision

Date: 2026-08-14

Status: implementation decision for a production-disabled checkpoint

## Decision

Add `@ai-dev-os/secrets-windows`, a Windows-only `SecretBroker` that resolves
one exact allowlisted `keychain` reference from Windows Credential Manager.
The production package owns a small C/N-API boundary with only two operations:
exact-target availability and exact-target read. It exposes no enumeration,
write, replace, revoke, delete, version, registry, process, credential-file,
arbitrary-path, environment, browser, or network capability. The necessary file
load is one fixed package-relative native addon, loaded lazily at operation time;
no caller controls its path. A separate testing export accepts
an injected deterministic fake implementing the same two-operation port.

The native source is repository-owned. No native binary is committed, no
install/postinstall hook is added, and no third-party credential-management
library is accepted. The reviewed `@napi-rs/keyring` alternative was rejected
because its native surface includes credential enumeration and mutation;
`keytar` and shell/Python wrappers add still broader and less maintainable
authority. This workstation lacks a Windows SDK and native linker, so the exact
native build must be proved by the existing hosted Windows build environment.

## Binding and target

The factory accepts one parsed `SecretRef`. It requires type `keychain`, kind
`text`, and `version: null`; namespace, service, account, and optional provider
instance are bound exactly. A canonical JSON projection of those nonsecret
locator fields is SHA-256 hashed. The Credential Manager target is the bounded
form `AI-Dev-OS:v1:<namespace>:<digest>`. Raw account names, usernames, email
addresses, paths, separators, or arbitrary target strings never reach the
native boundary. The broker recomputes and exact-compares the submitted
reference before every backend call.

## Lifecycle, audit, and errors

The broker advertises only availability and text resolution. Policy evaluation
remains outside it in `createPolicyAwareSecretResolver`; the Anthropic adapter
constructs the exact secret-access policy request and requires a finite returned
decision fingerprint before invoking the transport callback. The provider's
prior disclosure decision and the separate secret-access decision are retained
as distinct bindings.

Attempt audit runs before native access. Outcome audit records backend/consumer
success or failure before the operation settles. Audit failures are finite and
fail closed. Native
results are projected into a closed status set and all other values become a
bounded backend-response error. Credential bytes are bounded, copied into
`SecretMaterial`, and the native/JavaScript transport copies are zeroed in
`finally`; callback disposal and close follow the existing broker contract.
Windows, Node, and JavaScript may retain unobservable implementation copies, so
the checkpoint does not claim perfect erasure.

The broker checks cancellation and absolute deadlines before and after native
access. Close prevents new work and waits for already-entered OS operations and
callbacks; it does not force-terminate an executing `CredReadW`. Errors,
inspection, JSON,
audits, and configuration projections contain only finite codes, counts, and
fingerprints—never target names, account names, native error text, or material.

## Validation boundary

Cross-platform tests use the injected fake and cover exact binding, policy
ordering, concurrency, cancellation, close, audit, error mapping, serialization,
and Anthropic composition without HTTP. Windows CI compiles the C/N-API source
with warnings as errors. A real Credential Manager write/delete test is omitted:
the production boundary intentionally has no mutation authority and this
checkpoint will not add a second native mutation surface solely for testing.
No real credential or provider call is part of this decision.
