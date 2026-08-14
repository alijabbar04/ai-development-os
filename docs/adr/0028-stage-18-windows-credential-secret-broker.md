# ADR 0028: Production-disabled Windows credential secret broker

Status: Accepted

Date: 2026-08-14

## Context

The Stage 18 Anthropic provider already requires a scoped `SecretRef` and orders
provider disclosure policy before its credential and transport ports. The
provider-neutral secrets package already supplies exact references,
callback-scoped material, safe errors/audits, and a policy-aware resolver. It
did not have a secure persistent Windows adapter, so no operator-owned API key
could be represented without adding ambient environment/file/browser authority.

The checkpoint must not run Anthropic, inspect existing credentials, enable
production, or expose general credential-management capability. The generic
`keychain` reference is sufficient; a second reference schema would create
overlapping identities and migration risk.

## Decision

Add `@ai-dev-os/secrets-windows`, bound to one exact allowlisted `keychain`
reference. It supports text availability/read only. Interface-mandated
`replace` and `revoke` calls are audited and return `UNSUPPORTED_OPERATION`;
versions are unsupported. The production entry is Windows-only at operation
time but safe to import elsewhere. Tests use an injected two-operation fake.

Use Windows Credential Manager generic credentials. A repository-owned C/N-API
addon exports only asynchronous `availability(target)` and `read(target)` and
calls only `CredReadW`/`CredFree`. There is no native or JavaScript list,
enumerate, write, delete, rename, prefix, wildcard, registry, process,
credential-file, environment, browser, network, or fallback path. The one file
load is a fixed package-relative `../build/Release/ai_dev_os_windows_credential.node`
module loaded lazily on the first operation; no caller controls it. The native binary is generated
only by an explicit Windows build, never committed, and has no install hook;
the package pins `gypfile: false` so npm cannot synthesize one from `binding.gyp`.

Maintained third-party keyring bindings were rejected because their native
surface also exposes enumeration and mutation. Archived `keytar`, Python/shell
wrappers, environment variables, files, browser sessions, CLI authentication,
DPAPI files, and a child helper were rejected for broader authority, weaker
lifetime/process isolation, or maintenance/build provenance. Credential Manager
is the smallest compatible user-scoped persistent facility.

## Exact target and authority binding

The accepted reference must have:

- schema version 1 and type `keychain`;
- exact configured namespace, service, account, and provider instance;
- `expectedKind: "text"` and `version: null`;
- only the existing bounded identifier grammar and exact own data keys.

The target projection is canonical JSON over schema version, namespace,
service, account, expected kind, and provider instance. Its SHA-256 digest forms
`AI-Dev-OS:v1:<namespace>:<digest>`. The 64-hex digest is the collision-resistant
binding; raw account, service, provider instance, user/email, and path text do
not appear in the target. The native boundary independently validates the fixed
prefix, namespace grammar, length, delimiter count, and lowercase digest.

Configuration and methods are captured into immutable projections. Every call
parses and exact-compares the supplied reference and context before audit/native
access. Proxies, symbols, accessors, hostile prototypes, unknown keys,
unsupported reference forms, target substitutions, context/provider drift,
versions, and byte-kind requests fail closed.

## Policy and Anthropic composition

`createPolicyAwareSecretResolver` remains the only production composition: it
validates subject digest, locality, complete execution trace,
operation/provider/task/trace scope, classification, and approval evidence,
then requires an allowed central `secret-access` decision before calling the
broker. `createPolicyAwareAnthropicCredentialPort` projects the already-
authorized provider request into that resolver. Operation, provider, task, and
trace fields originate independently in the provider request; `projectId` has
no provider-request field and is therefore trusted from the injected exact
`policyRequestFor` projection rather than claimed as independently bound. The provider's
disclosure-decision fingerprint remains bound in `SecretAccessContext`; the
separate secret-access policy result is independently fingerprinted.

The existing provider performs disclosure authorization first. The resolver
performs secret-access authorization second. Only then does the broker read;
only inside `SecretMaterial.useText` does the credential port pass an immutable
text copy to the already-bounded provider transport callback. No key is stored
in provider configuration, state, events, results, or observations. The public
provider factory remains literal production-disabled.

## Lifetime, cancellation, close, audit, and errors

The native async worker copies a bounded credential blob, overwrites the Win32
blob, and frees it. Node copies the bounded result; the broker validates UTF-8,
copies into `SecretMaterial`, and zeroes its native/result and material-input
buffers. `SecretMaterial` makes one further scoped copy and zeroes it after
`useText`; its owned bytes are zeroed after the outer callback. Immutable
JavaScript strings and runtime/OS copies cannot be proven erased, so no perfect
erasure claim is made.

Cancellation and absolute deadline are checked before and after the local OS
operation. The Win32 call is not force-terminated once executing; late material
is zeroed and never reaches the callback. Close rejects new work, is idempotent,
and waits for entered OS/callback work. Concurrent exact reads own separate
buffers.

Attempt audit precedes backend access. Outcome audit records success,
not-found, denial, failure, unsupported operation, callback failure, and close.
An attempt-hook failure guarantees zero backend access. Audit records contain
only a reference fingerprint and bounded operation/context metadata. Clock and
hook failures map to `AUDIT_FAILURE`.

Native results map to the finite statuses `ok`, `not-found`, `access-denied`,
`unavailable`, `malformed`, and `failure`; unknown shapes fail as
`MALFORMED_BACKEND_RESPONSE`. No Win32 code/text, target, account, material,
callback exception, or native cause is serialized.

## Testing and packaging

Cross-platform tests prove reference/target vectors, denial before backend,
capabilities, native projections, lifetime/zeroing, cancellation/deadline,
audit ordering/failure, concurrent close, method drift, redaction, no authority
surface, and the Anthropic provider composition without HTTP. Static policy
pins `CredReadW` as the only credential API and the exact package exports.

Windows CI builds the addon with `/W4 /WX`, SDL and CFG, first proves a bounded
malformed-target table is refused by the raw C grammar, then requires
`not-found` through both exported availability and read paths for one fresh
random synthetic target that the project never creates. Because exact
`CredReadW` would access and zero an unexpected matching credential before
failing the check, the no-credential-read claim is conditional on both results.
The probes cannot enumerate or create state. No synthetic writer/deleter is
shipped or exported. Packed-consumer validation exercises production and
testing exports without OS credential or provider access.

## Consequences and nonclaims

This is enabling infrastructure, not `ANT-02`: no supported real `SecretRef` was
configured and no Anthropic call ran. It does not complete `AM-02`, `PLN-02`,
Stage 17W, development acceptance, or production admission. Future operator
setup must create exactly the documented target through a separately reviewed
operator-owned procedure, bind the correct provider instance, and run the
existing one-attempt canary under its separate authority. Production activation
requires all independent gates and a later explicit admission change.
