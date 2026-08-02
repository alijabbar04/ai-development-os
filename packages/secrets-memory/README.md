# @ai-dev-os/secrets-memory

A deterministic in-process `SecretBroker` reference adapter for tests and
development. It depends only on `@ai-dev-os/secrets`; the port package never
depends on this adapter.

Seeds are explicit references plus text or byte material and optional access
and revoked state. Inputs and resolution snapshots are defensively copied.
There is intentionally no enumerate or dump-all API. The capability descriptor
is stable and advertises availability, resolution, versions, replacement,
revocation, and both material kinds.

Resolution takes a private snapshot before entering the consumer callback.
Concurrent replace or revoke affects subsequent resolutions without changing
an active callback. Callback completion or failure always disposes its scoped
material. Consumer exceptions become secret-safe `CONSUMER_FAILURE` errors.
Deadline and cancellation state are checked deterministically through the
injected clock and access context.

Replacement and revocation clear the adapter-owned previous buffer where
practical. Close marks the broker closed, clears all stored buffers in stable
reference order, waits for active callbacks to finish, and is idempotent;
subsequent operations reject. An optional `onZero` hook exposes only reason,
length, and all-zero status for safe testing. It never exposes bytes.

The audit hook receives separate attempt/outcome records. If an attempt audit
fails, the operation does not access or mutate the store. If an outcome audit
fails after a callback or mutation, the adapter reports `AUDIT_FAILURE` without
rolling back the completed action and without including material in the error.

```ts
const broker = createMemorySecretBroker({
  clock,
  entries: [{ ref, material: { kind: "text", text: fixtureValue } }],
});

await broker.withSecret(ref, context, (secret) =>
  secret.useText((value) => value.length),
);
await broker.close();
```

This is not a production vault and offers no process isolation, durable
storage, access-control service, or secure-erasure guarantee. Its purpose is to
make the public broker contract and lifecycle semantics reproducible.
