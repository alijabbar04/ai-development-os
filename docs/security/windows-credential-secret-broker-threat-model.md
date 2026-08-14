# Windows credential secret-broker threat model

Date: 2026-08-14

Scope: production-disabled `@ai-dev-os/secrets-windows` and the policy-aware
Anthropic credential composition. No real credential or provider operation is
part of this checkpoint.

| Threat | Control and residual risk |
| --- | --- |
| Credential enumeration or confused deputy | Native and TypeScript ports expose exactly one availability/read target, never list/prefix/write/delete. The broker exact-compares one configured reference and provider context. Same-user malicious code outside this boundary is not contained by a library API. |
| Target injection/collision | Existing strict reference grammar plus proxy/accessor/prototype/unknown-key rejection; SHA-256 canonical projection; fixed prefix/namespace/64-hex native grammar; no caller-supplied native target. Cryptographic collision remains theoretical residual risk. |
| Wrong provider/profile/instance | Reference subject, locality, complete execution trace, operation/provider/task/trace scope, classification, and approval evidence are bound before backend access. The trusted provider adapter separately fixes purpose, access form, requested lifetime, and cloud locality for the provider transport, and preserves the disclosure-decision fingerprint. Its `projectId` comes from the exact injected policy-request builder because the provider request has no independent project field. Provider disclosure and secret-access policies are separate required decisions. |
| Logs/errors/JSON/inspection/audit leakage | Material has no value property and redacted string/JSON/inspection. Broker errors use fixed text/codes and no raw causes. Audits carry only reference fingerprint and bounded IDs. Native status has no Win32 text/code/target. Core dumps, debuggers, and compromised runtimes remain outside the guarantee. |
| Lifetime and unavoidable copies | Win32 blob, native heap copy, Node result buffer, broker input buffer, material buffer, and scoped byte copies are zeroed where controlled. V8 strings, OS internals, allocator/runtime copies, paging, crash dumps, and callback-created copies cannot be proven erased. |
| Cancellation, timeout, use-after-dispose | Pre/post OS checks, late-result zeroing, fatal UTF-8/bounds, material disposal, and use-after-dispose refusal. An executing local `CredReadW` is non-preemptive; close waits rather than abandoning it. |
| Concurrent close/races | Factory captures native methods, each read owns distinct bytes, active count spans OS and callback, close sets closed first, rejects new work, waits for zero active, and is idempotent. Host/process termination can still interrupt cleanup. |
| Callback retention | Material is invalid after callback and carries no value property. Immutable text passed to `useText` cannot be revoked if malicious consumer code retains it; policy and trusted transport composition are therefore part of the authority boundary. |
| Native compromise/unsafe dependency | Repository-owned small C/N-API source, `CredReadW` only, 16 KiB maximum, `/W4 /WX`, SDL/CFG, no credential library dependency, no binary commit, and `gypfile: false` to prevent npm from synthesizing an install hook. Hosted compiler/toolchain compromise remains supply-chain risk. |
| Child process/environment/file/network leakage | The package creates no child and has no environment, credential-file/fallback, arbitrary-path, or network input. It lazily loads exactly one fixed package-relative reviewed native addon. The Anthropic transport is separately injected and runs only after both policies. Downstream transport/runtime remains responsible for its own process and network controls. |
| Malicious repository input/test fixture | Exact own data projections, bounded identifiers/results, static forbidden-API/export scans, distinctive synthetic marker scan, and no real store mutation. Tests never derive a real target or discover credentials. |
| CI/non-Windows behavior | TypeScript/fake tests are portable and imports cause no OS access. Only Windows CI explicitly builds the addon, proves malformed targets refuse before work is queued, and requires `not-found` through both native operations for one fresh random target that the project never creates. An unexpected collision would cause exact `CredReadW` access before failure. No CI credential is configured, and no provider secret or production activation exists. |
| Production activation bypass | Anthropic production factory remains refusal-only; no application production registration is added. Matrix `ANT-02`, `AM-02`, `PLN-02`, development acceptance, and production admission remain unchanged. |

The strongest residual is same-user compromise: any process already able to run
arbitrary native code as the operator may bypass this library and call Windows
APIs directly. This broker minimizes authority for correct AI Development OS
composition; it is not an OS sandbox or protection against a compromised user
session.
