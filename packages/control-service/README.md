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
