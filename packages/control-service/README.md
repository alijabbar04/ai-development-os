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
accepted model without making a stronger claim.
