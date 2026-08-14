# `@ai-dev-os/secrets-windows`

Production-disabled, Windows-only exact-reference secret broker for Windows
Credential Manager. It implements the provider-neutral `SecretBroker` contract
without becoming a general credential-manager API.

The factory accepts one exact allowlisted schema-v1 `keychain` reference. It
requires `expectedKind: "text"` and `version: null`, and binds namespace,
service, account, and optional provider instance. The Win32 target is
`AI-Dev-OS:v1:<namespace>:<sha256(canonical locator)>`; service, account, and
provider-instance values are represented only inside the digest. No raw user,
email, path, or arbitrary target string crosses the native boundary.

Capabilities are deliberately narrow:

- `resolve=true`, `availability=true`, `kinds=["text"]`;
- `replace=false`, `revoke=false`, `versions=false`;
- no enumerate/list/prefix/wildcard/default/fallback API;
- no environment, credential-file/fallback, arbitrary-path, registry-generic,
  process, browser, network, service, or child-process authority. Production
  lazily loads only the fixed package-relative reviewed native addon.

The production entry uses a repository-owned asynchronous C/N-API addon whose
only exports are exact-target `availability` and `read`. The addon calls
`CredReadW` with `CRED_TYPE_GENERIC`, copies at most 16,384 bytes, overwrites the
Win32 credential blob before `CredFree`, and returns only a closed status plus a
bounded buffer. TypeScript copies into callback-scoped `SecretMaterial` and
zeros both mutable JavaScript transport copies. Windows, Node, V8, and immutable
JavaScript strings may retain implementation copies; this is defense in depth,
not a perfect-erasure claim.

No native binary is committed. `gypfile: false` prevents npm from synthesizing
an install hook from the root `binding.gyp`; the native build is explicit:

```powershell
npm run build:native --workspace @ai-dev-os/secrets-windows
```

`binding.gyp` pins MSVC warning level 4, warnings as errors, SDL checks, control
flow guard, and the sole `Advapi32.lib` dependency. The normal build remains
portable and import-safe. `./testing` exposes only the narrow injected native
port and fake-backed broker factory; native loader internals are not exported.

Policy is intentionally not duplicated here. Compose the broker through
`createPolicyAwareSecretResolver`, then use
`createPolicyAwareAnthropicCredentialPort` from
`@ai-dev-os/provider-anthropic`. Central secret-access policy and approval
binding complete before either native read or provider transport. The public
Anthropic provider remains production-disabled.

The hosted Windows check compiles the addon, proves a bounded malformed-target
table is refused by the raw native grammar before work is queued, then requires
`not-found` from both availability and read for one fresh random synthetic target
that this project never creates. `CredReadW` would necessarily access and
immediately zero an unexpected matching credential before the check failed, so
the no-credential-access claim is conditional on both recorded `not-found`
results. The probes have no create, replace, delete, or enumeration authority
and make no provider request. A synthetic write/delete test seam was rejected
because it would widen production-adjacent native authority solely for testing.
