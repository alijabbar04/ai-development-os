# `@ai-dev-os/control-service`

Windows-first, production-disabled Stage 20A host boundary. C3 owns launch
identity, exact-name descriptor and lock artifacts, digest-only bearer sessions,
the lifecycle table, and nonce-before-bearer adoption. C4 adds the literal
`127.0.0.1` read-only listener. C5 adds allowlisted UI projections backed only
by injected records.

This package is never installed as a Windows Service, scheduled task, startup
entry, or elevated process. It has no provider, credential, vault, Account
Manager, task, agent, workspace, repository, Git, scheduler-command, or process
launch dependency. It exports no production bootstrap and cannot enable
production.

The descriptor contains the bearer in plaintext because a future native client
must read it. The server retains only its SHA-256 digest. Node mode `0o600` is a
useful POSIX permission request but does not prove a Windows DACL. These
application-level checks are not a security boundary against a hostile process
already running as the same user. Exact-name reads, component checks, file
identity checks, create-only promotion, and ownership-bound cleanup narrow the
accepted model without making a stronger claim. Cooperating mutations are
serialized by a create-only, exact-name transient claim so a pathname cannot be
replaced between an ownership check and unlink. An orphaned or unverifiable
claim blocks later mutation; Stage 20A does not delete it by age or silently
recover it.

Adoption sends health and session reads over one TCP connection. The bearer is
written only after the complete health response matches the descriptor nonce
and version. A closed channel is never replaced, and one monotonic deadline
bounds connect, response framing, identity verification, and authentication.

## Stage 20A read surface

The exact inventory is six `GET` routes and zero commands:

- unauthenticated `GET /v1/health` for the bounded nonce identity probe;
- authenticated `GET /v1/session`;
- authenticated `GET /v1/projections/health`;
- authenticated `GET /v1/projections/usage.policyConstants`;
- authenticated `GET /v1/projections/usage.profiles?profileId=...`; and
- authenticated `GET /v1/projections/routing.latest?taskId=...`.

Normal or Developer presentation is fixed when the host is composed. It is not
a request parameter and changes no route, command, authentication, or
production authority. Every authenticated projection uses the C2 projection
envelope with one monotonic sequence, server-owned `serverNow`, `computedAt`,
confidence, and a finite stale reason. A missing named record produces the
finite C2 `SERVICE_NOT_READY` refusal; raw source errors are never returned.

C5 accepts one strictly parsed, bounded in-memory dataset. It accepts no read
callbacks and imports no Account Manager, vault, provider, scheduler, task,
workspace, repository, or Git runtime. Unknown fields, mixed-profile
reservations, model-text fields, credential/path/fingerprint canaries, and
unbounded collections refuse before the listener is created.

Usage preserves `active`, `inactive`, `stale`, and `unavailable` as distinct
states. Inactive and unavailable values remain null. Ambiguous authorization,
unknown revocation, stale evidence, invalid resets, and expired windows fail
closed. Normal receives product-owned reason sentences; exact policy rule IDs
and bounded record identities are Developer-only. `sourceFingerprint` and
borrowed-owner identity are never projected in either presentation. The
Europe/London weekday `[09:00,17:00)` calculation uses the explicit `en-GB`
calendar contract and only the served `serverNow`; the 50% five-hour borrowed
cap relaxes outside that interval while the 70% weekly cap remains in effect.

The health projection reports e-stop availability as `not-implemented`, never
as ready. A fresh startup cannot claim recovered sessions, and a stopped run
may remain unresolved. The routing projection exposes only an injected stored
selection and finite product-owned reasons; it contains no model, forecast,
allocation outcome, command, or effect.
