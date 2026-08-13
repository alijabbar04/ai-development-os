# Stage 17W manifestless recovery operator packet

Date: 2026-08-13 (BST)

Status: **PREPARED FOR REVIEW — NOT AUTHORIZED OR EXECUTED**

This packet supersedes only the old packet's cleanup handling for the preserved
manifestless token leaf. The existing Stage 17W install/remove packet must not
be retried. This packet proposes one future remover-first observation; it does
not authorize elevation, installation, controller lifecycle, egress, restricted
proof, or any alternate cleanup.

## Bound source and artifact identity

- Branch: `fix/stage-17w-manifestless-partial-install-recovery`.
- Source commit: `7a7f4902871f10de11fe4e59bfe6a761dc7b497a`.
- Source tree: `a1bca2219f01e63abd2079ea91f64b7d118124f7`.
- Exact-head CI:
  [31746647903](https://github.com/alijabbar04/ai-development-os/actions/runs/31746647903),
  all four jobs successful.
- Required SDK: `.NET 9.0.316`.
- Required installer executable: 156,672 bytes, SHA-256
  `09b32936f4dcbcf4dddcbdbcb4b504a7aeb254eb5bec20b0aea4463abf162421`.
- Required installer DLL: 192,000 bytes, SHA-256
  `d07411654d6be57b50442c587ba58816005d3fa999d50583c5663363fcebe863`.
- Required installer closure: exactly 188 flat files / 78,090,995 bytes;
  canonical ordinal `<name>|<bytes>|<lowercase-sha256>` lines joined by LF with
  no final LF hash to
  `b4c4adc88b5d6078f5ad253e5f098db6fa0d178ccf0aeb5b252954b8065fb09c`.
- Required installer self-test: reviewed-proof mode, `productionEligible: false`,
  276/276, digest
  `d4f89a04f5be011583318e30dda16e1f5f2720f1d6e0c3e72fde089ab7a083c5`,
  zero native opens and no host state created.

Rebuild from a fresh clean checkout of the exact commit into a new empty
task-owned directory outside the repository using exactly:

```powershell
node packages/process-broker/scripts/build-windows-artifacts.mjs `
  --out <new-absolute-task-owned-output-root> `
  --flavor reviewed-proof `
  --include-proof-only
```

Require an empty `git status --porcelain=v1`, the exact commit/tree/SDK above,
successful packaging result, proof-only inclusion, sealed supervisor/helper,
byte-identical proof closures, zero proof differences, and the exact installer
EXE/DLL hashes above. Any mismatch is an abort. Do not regenerate a trust pin,
reuse an unreviewed binary, or add an argument.

## Previously evidenced protected state

The prior authorized evidence, not a new read, identified token:

`0d795cbc5427427aa386db71cba527fd`

and leaf:

`C:\ProgramData\AI-Dev-OS\Stage17-Proof\0d795cbc5427427aa386db71cba527fd`

At the last authorized observation the leaf was empty and contained neither
`stage17-proof-manifest.json` nor `stage17-proof-install-record.json`. The
current state has not been revalidated. This packet gives no authority to
inspect it before a fresh operator approval.

## Proposed future elevated sequence

After all unelevated identity and pure preflight checks pass, stop and obtain a
fresh exact operator approval tied to this packet, source commit, installer
hash, and token. Prior `approve Stage17W UAC` text is consumed and does not
authorize this sequence.

The proposed sequence contains **one UAC prompt and one native command only**.
The controller remains unelevated and is not invoked:

```powershell
Start-Process `
  -FilePath '<exact-rebuilt-root>\build-1\windows-proof-installer\AI.DevOS.WindowsProofInstaller.exe' `
  -ArgumentList @('remove','--token','0d795cbc5427427aa386db71cba527fd') `
  -Verb RunAs `
  -Wait `
  -PassThru
```

The operator/approved entry point must launch that executable directly. No
elevated shell, wrapper, destination, source, candidate, digest, ACL, owner,
force, recursive-delete, wildcard, service, task, or second token is permitted.
Do not redirect the operation through another tool or command shape.

## Expected bounded result

On success, the installer returns exit `0` and one canonical, single-line JSON
object whose finite fields show:

- `component: "windows-proof-installer"`;
- `buildFlavor: "reviewed-proof-mode"`;
- `proofModeCompiledIn: true`;
- `operation: "remove"`;
- `status: "completed"`;
- `code: "none"`;
- `failedStep: ""`;
- `rollbackStatus: "not-required"`;
- `rollbackCode: "none"`;
- `rollbackFailedStep: ""`; and
- completed steps including `prove-manifestless-empty-leaf`,
  `delete-manifestless-empty-leaf`, and `retain-shared-ancestors`.

The output contains no path, ACL body, owner, exception text, file content, or
private record. Capture the process start/end time, exact executable hash,
arguments, exit code, and canonical stdout if available. A UAC launch that
cannot capture stdout may rely only on those process facts and the later
independent residue observation; it must not fabricate a transaction receipt.

## Abort conditions

Abort before elevation on any commit/tree/SDK/hash/build-flavor/component,
conformance, closure-determinism, self-test, Git cleanliness, or CI mismatch.

After elevation begins, stop with no retry on:

- any nonzero exit or missing/contradictory transaction result;
- any refusal code or failed step;
- a nonempty leaf, missing exact chain, identity/type/reparse/access mismatch,
  owner or private exact-DACL mismatch, inaccessible state, or changed ancestor;
- an unconfirmed deletion or any new residue;
- any request for broader permissions, another token, shell cleanup, ownership
  taking, ACL changes, or recursive/path-based deletion; or
- any safety-control refusal.

Do not reroute, split, wrap, encode, force, or repeat a blocked/refused command.
Do not continue into installation, controller lifecycle, egress, or restricted
proof in the same approval.

## Post-command residue observation

After the single remover process exits, leave the administrator context. Use a
separately authorized, bounded, read-only inventory—not the controller and not
another mutation command—to confirm:

- the exact token leaf is absent;
- filesystem residue is zero for the closed token-derived names;
- manifest and install-record residue are zero;
- package-folder residue is zero;
- registry residue is zero for the previously reviewed bounded roots;
- helper and fixture process residue are zero; and
- the shared `AI-Dev-OS` and `Stage17-Proof` ancestors were retained.

Any inability to establish those exact postconditions is a failed observation
requiring manual review, not permission for cleanup. Do not enumerate unrelated
profiles, repositories, processes, registry locations, or filesystem state.

## Stop boundary

If the one remover and independent residue observation both succeed, record a
new remediation-attempt evidence packet and stop. A fresh install/lifecycle
attempt would require a separate reviewed packet and separate explicit
authorization. This packet does not complete Stage 17W or admit production.
