# @ai-dev-os/secrets

Provider-neutral secret references, scoped material, broker ports, structured
errors, safe audit records, redaction helpers, policy-before-resolution
composition, and reusable broker contracts. This package contains no concrete
keychain, vault, filesystem, environment, or network adapter.

## References are configuration; material is not

`SecretRef` schema version 1 is a finite immutable union: named broker entry,
environment-variable reference, OS keychain entry, encrypted-file entry, or
external-vault entry. References contain bounded logical identifiers,
namespace, optional version, expected `text`/`bytes` kind, and optional provider
association. They never contain a value or unrestricted filesystem path.
Environment references are text-only. Canonical serialization and safe display
show locator metadata, not material. `secretRefFingerprint` produces the safe
canonical SHA-256 subject digest used to bind secret-access policy decisions and
approval evidence to the exact reference.

`SecretMaterial` is a separate narrow lifetime object. The primary broker API
is callback-scoped:

```ts
await broker.withSecret(ref, context, async (secret) =>
  secret.useText(async (text) => authenticate(text)),
);
```

Text and byte access are distinct callbacks, with no implicit conversion.
Material has no enumerable value property, serializes and stringifies as a
redacted marker, uses a redacted Node inspection hook, rejects use after its
lifetime, and clears owned mutable byte copies when practical. Consumers must
not retain callback arguments.

JavaScript cannot promise secure erasure: immutable strings, engine-internal
copies, garbage-collected memory, environment storage, and OS/backend copies
may remain. Buffer clearing is defense in depth, not a cryptographic erasure
guarantee.

## Broker and policy composition

`SecretBroker` defines availability, callback-scoped resolution, optional
replace/revoke, capability description, and close. `SecretAccessContext`
binds an operation, provider, purpose, requested lifetime/form,
classification, project/task, approval evidence references, disclosure
decision fingerprint, locality, trace, optional deadline, and cancellation
signal.

`createPolicyAwareSecretResolver` parses the reference, context, and request,
then exact-compares the policy-comparable subject, classification, locality,
complete trace, operation/provider/project/task/trace scope, and approval
evidence before invoking an adapter. Purpose, requested lifetime, access form,
and disclosure-decision fingerprint remain validated context fields fixed or
preserved by the provider adapter; they are not misrepresented as fields in the
policy request. Denied, malformed, throwing, and unresolved conditional
decisions guarantee the adapter is not called. The resolver captures a finite
allowed decision with an exact lowercase SHA-256 fingerprint before broker
access, supplies that fingerprint as the secret callback's second argument
before material use, and also returns it alongside the callback result.
Maintained credential consumers validate the callback fingerprint before
entering their transport callback.

Stable `SecretBrokerError` codes distinguish malformed references, missing or
unavailable versions, denial, expiry/revocation, close/timeout, unsupported
operations, backend/malformed responses, consumer failures, kind mismatches,
disposed material, and audit failures. Errors carry bounded safe metadata and
never raw values, backend responses, environment values, paths, or callback
data.

## Audits and lifecycle

Safe audit hooks receive separate `attempt` and `outcome` records for
availability, resolution, replacement, revocation, and useful close events.
Records contain only deterministic timestamps, operation categories, outcome
categories, redacted reference display, bounded context identifiers, purpose,
and trace ID. Input that cannot be safely parsed is rejected before an audit is
formed. An attempt-hook failure prevents backend access; an outcome-hook
failure is reported as `AUDIT_FAILURE` after any already-completed callback or
mutation. Audit persistence belongs to the event/persistence layer.

`@ai-dev-os/secrets/testing` exports the reusable secret-broker contract suite.
The provider-neutral package still contains no concrete adapter. Stage 18 adds
the separate production-disabled `@ai-dev-os/secrets-windows` exact-reference
Credential Manager reader for one allowlisted text `keychain` reference.
Environment, encrypted-file, and vault adapters remain deferred; config never
performs environment interpolation.
