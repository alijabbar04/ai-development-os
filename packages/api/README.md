# `@ai-dev-os/api`

Pure Stage 20A response and projection contracts. This package is deterministic,
framework-independent, and production-disabled.

## Included in C2

- schema-versioned success, projection, and refusal envelopes;
- caller-supplied `serverNow`, monotonic sequence validation, and projection
  freshness metadata;
- the complete reconciled finite refusal catalogue and product-owned display
  copy;
- an allowlist projection-schema DSL with strict hostile-input and Normal-mode
  leakage refusal; and
- explicit route and command registries whose count is zero.

There is no server, socket, listener, route, HTTP framework, command, provider,
workspace, Git, persistence, secret, native, Electron, or process-launch
composition here. Fastify belongs to the later C4 listener and is deliberately
not a dependency of C2. Stage 20B owns all future mutations.

Clients must derive ages and expiry language from the envelope's `serverNow`.
This package never reads a local clock. A projection marked `stale` remains a
displayable bounded record with a finite reason; it is not silently converted to
current or hidden.

Normal and Developer presentation modes have identical route, command, and
production authority. Developer projections may opt into explicitly typed
absolute-path and source-fingerprint fields. Normal projections refuse those
fields, credential shapes, borrowed-owner identity, and profile data outside the
declared profile scope.

C5 adds two narrow schema rules without adding a route or runtime effect here:
`product-copy` accepts only an exact schema-owned finite sentence set that has
already passed the Normal leakage checks, while `policy-rule-id` accepts only an
exact lowercase dotted policy-ID set and remains subject to the Normal
mechanism guard. The control service uses policy IDs only in Developer schemas.

## Boundaries

The only runtime dependencies are the repository-owned `@ai-dev-os/domain`
validation and canonical-JSON contracts plus Node's pure proxy-introspection
utility. Tests enforce the direct and transitive import closure, scan the entire
production source surface, and include forbidden-import positive controls.

This package creates no acceptance or production claim. It does not implement
C3-C5, a client, a project spine, Stage 20B, or the Stage 21 desktop.
