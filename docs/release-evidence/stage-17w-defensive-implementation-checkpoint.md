# Stage 17W defensive implementation checkpoint

Date: 2026-08-09

Outcome: **REVIEWED DEFENSIVE IMPLEMENTATION CHECKPOINT — NOT A STAGE 17
COMPLETION, PRODUCTION ADMISSION, MERGE, OR RELEASE**

This checkpoint records ordinary compilation, pure self-tests, static policy,
package, dependency, audit, coverage, deterministic-publish, and read-only
review evidence for the Stage 17W implementation. It does not record a
stateful native lifecycle observation or authorize production execution.
Windows production availability remains false, production execution continues
to refuse, Stage 17W remains gated, Stage 18 remains blocked, and no Stage 17
release tag is authorized.

## Provenance, scope, and preservation

- Branch: `feat/stage-17w-complete`.
- Starting commit: `6a65d2d4be69297149fd265573a4655e9f37c9ca`.
- Starting tree: `c792e4e832f978d1baeeb037a4dabf153c501b8a`.
- The 23 Stage 17 source files present at the start of the continuation were
  preserved. No reset, checkout-based discard, clean, merge, rebase, tag, or
  deletion was performed.
- A task-owned source backup was retained at
  `C:\Users\mrali\AppData\Local\Temp\ai-dev-os-stage17w-source-backup-20260809-123133`.
  Its patch SHA-256 is
  `da688fa19a3afdebb0ba45b31391cac2a6a373762f2c72501d7842bc77d90033`;
  its zip SHA-256 is
  `da7463b6ae93dcd918df83cce05e11e1f14bf2b9bc5dd32a46d5ce87cac83fa4`.
- Work remained inside ordinary defensive engineering. No installation,
  removal, elevation, ACL mutation, AppContainer creation, Job lifecycle,
  scenario execution, recovery mutation, live provider canary, production
  registration, production workload, merge, or tag occurred.

## Reviewed implementation boundary

ADR 0020 defines the component and authority split. The checkpoint implements:

- installed-closure authentication through an exact manifest, record, flat
  filename set, retained deny-write/delete handles, per-file size and SHA-256,
  and an independently compiled source-envelope pin outside the measured
  closure;
- fixed supervisor/helper roles, a private kill-on-close/no-breakaway Job,
  exact inherited-handle lists, target containment attributes at creation,
  bounded framed control, run-token-derived scenario tokens, and closed-set
  journal cleanup/recovery;
- a proof-only controller and installer whose mutating commands require the
  explicit reviewed-proof build and whose component identities are rejected by
  production discovery and npm packaging;
- two fixed, body-free HTTPS reachability canaries with no credential, prompt,
  repository content, caller-provided endpoint, proxy, redirect, cookie,
  pre-authentication, automatic decompression, or QUIC surface; and
- a checked source projection that keeps production projects independent of
  the feasibility assembly while static policy requires byte-for-byte parity
  with the reviewed source projection.

The runtime's ancestor validation is not a native handle-relative directory
walk. The proof installer creates and verifies exact protected DACLs below the
fixed installation hierarchy, and runtime metadata/member handles remain open,
but a privileged administrator can replace protected ancestors and is outside
the same-user workload boundary. Production admission therefore requires the
same externally pinned retained lease or a native held-directory equivalent;
direct supervisor invocation is not admitted by this checkpoint.

## Native compilation, self-tests, and deterministic artifacts

All affected projects compiled with zero warnings and zero errors:

- `windows-runtime`;
- `windows-supervisor`;
- `windows-helper`;
- `windows-feasibility-probe`;
- `windows-boundary-fixture`;
- `windows-proof-controller`; and
- `windows-proof-installer`.

The production-shaped supervisor and helper were each directly published into
two clean task-owned roots. Each publish contained 188 files, and ordinal
filename, size, and SHA-256 comparison found zero differences between repeats.
The separately published single-file boundary target was 70,923,627 bytes with
SHA-256
`79491702137668b6c5addd035f5e6fada0b202f74e7250030b76e86766c4f660`.
Two isolated publishes from the exact reviewed implementation commit
`1cd722859800e8c889b1c558afd098bde6ac343f` with .NET SDK 9.0.316 were
byte-identical at that size and hash. The superseded packet pin
`5ea8f05a561cc8c2dd99a7ddbef4e5c25ed23e9158a4549669995285a4ea38fa`
embedded informational version commit `6a65d2d4be69297149fd265573a4655e9f37c9ca`,
an ancestor rather than the required reviewed revision. Its committed
boundary-fixture tree differs from the reviewed tree, although the preserved
artifact alone cannot establish which later working-tree source may have been
present when that historical publish ran. The old and reviewed binaries differ
in 161 bytes: the embedded revision strings, their derived PE timestamp/MVID,
and the single-file bundle digest. This was a stale revision-bound artifact pin,
not same-reviewed-commit nondeterminism. Neither binary was executed during the
diagnosis.
The exact merged install closure contains 193 files and 149,441,013 bytes. Its
canonical source-envelope fingerprint is
`16f327aa858f25e85c9f335d658e1879d1c93729940648df19cd6966326eb5c8`,
compiled independently into the proof installer and proof controller. The
installer filename table exactly matched the publish union: no missing or
additional name.

The repository's aggregate Windows artifact helper was not invoked because it
imports the separately safety-gated module during report assembly. The direct
ordinary `dotnet publish` measurements above do not invoke or approximate that
operation.

Pure native self-tests performed no native filesystem or lifecycle action:

| Component/build | Result | Vector count and digest |
| --- | --- | --- |
| Supervisor, sealed | pass | core 165, `3b5ad6e8931cbe129dd5bda1fe8998853260466ea0525680d34276ad0bc77757`; role 28, `f32f48474e5cd5b51af555ca545aca5487d7fb6836db4145fdf23bfebcdb13e2` |
| Helper, sealed | pass | core 165, same core digest; role 54, `0a7e32f9c453faf6a3ed34f1102a554ec65fa6c13816cd481889c41889ae8af0` |
| Proof controller, sealed and reviewed | pass | 2, `cf12f49e59d6f0fbcc713bcdbf990a383ee30887f8dba068ccf9d8a91c8b6ef0` |
| Proof installer, sealed | pass | 150, `0533ec4bc096f334b0612ac812080a38acdab9ba4c1be1eef6603cb0467c651e` |
| Proof installer, reviewed | pass | 190, `58cecc4917f62c87fe527b319131c8e94a9573403a1e59136c6819e33726175b` |

The supervisor and helper both reported `productionEligible: false`, their
operational pure self-tests passed, and reviewed-proof mutation authority was
absent. A literal two-file canonical-serializer fixture fixes expected SHA-256
`d804d19ca6e350c7684f17a67aa14a56ef1ca1377b175eec33f1514d045edad7`
rather than comparing the serializer with itself.

## TypeScript, package, audit, and coverage gates

| Gate | Exact result |
| --- | --- |
| Clean dependency install | `npm ci` passed; 142 packages added, 175 audited, zero vulnerabilities |
| Affected package | typecheck and build passed; 445 passed and 1 intentional skip across 8 files |
| Focused Stage 17 static/security slice | 176 passed across 3 files |
| Repository check | uninterrupted `npm run check` exited 0 in 1,662.4 seconds; typecheck, tests, and build passed; 2,718 passed and 25 intentional skips across 131 files (129 passing, 2 skipped) and 32 suite summaries |
| Repository coverage | uninterrupted `npm run test:coverage` exited 0 in 869.6 seconds; the same 2,718 passed and 25 skipped tests; 32 LCOV reports |
| Dependency audit | `npm audit --json` and `npm audit --audit-level=high` reported zero findings at every severity |
| Dependency shape | the expected single `nanoid@3.3.18` chain through `postcss@8.5.25`, `vite@8.2.0`, and `vitest@4.1.10`; `npm ls` exited 0 |
| Package dry run | `@ai-dev-os/process-broker@0.1.0`: 122 files, 169,073 packed bytes, 772,726 unpacked bytes; only `README.md`, `package.json`, and `dist`; zero native/source entries |

Coverage totals:

| Scope | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Process broker | 2,166/2,338 (92.64%) | 1,308/1,517 (86.22%) | 364/370 (98.37%) | 2,067/2,206 (93.69%) |
| Repository, 32 reports | 20,049/21,385 (93.75%) | 13,185/15,212 (86.67%) | 3,958/4,046 (97.82%) | 18,143/19,119 (94.89%) |

The uninterrupted repository-check log is retained outside the repository as
`ai-dev-os-stage17w-npm-check-final-20260809.log`, SHA-256
`768d137a80ff3b9d7faef942956d564340212bb935713ecdc7dc81768ee06abe`.
The coverage log is
`ai-dev-os-stage17w-coverage-final-20260809.log`, SHA-256
`22677e111339ccc2f363d7b992fb187350f11bf3766df302c108fbd8156a3944`.

## Independent read-only review

Claude Code CLI 2.1.201 performed a one-turn, no-tool, read-only review using
actual primary model `claude-opus-4-8` at max effort. Session
`31bd7366-f50c-44d5-a200-4d67ee06b988` returned PASS for the checkpoint scope
with four findings:

1. Medium: the installed manifest needed an independent pin outside the
   measured closure. Fixed by the proof controller's independent compiled pin,
   canonical reconstruction through retained handles, matching controller /
   installer static policy, and the literal serializer fixture.
2. Low: runtime ancestor validation is path-based rather than a native
   held-directory walk. Accurately bounded in ADR 0020 and above; it remains a
   production-admission limitation outside the same-user workload boundary.
3. Low: a supervisor self-test field could imply proof mutation authority.
   Fixed by renaming it to `reviewedProofMutationAuthorized`; sealed output is
   false.
4. Informational: the stateful lifecycle and live egress paths were compiled
   but not executed. This is the deliberate checkpoint boundary, not passing
   runtime evidence.

A fresh final no-tool follow-up reviewed those fixes and this evidence record
using actual primary model `claude-opus-4-8` at max effort. Session
`d09f7f53-2c97-4949-9e8a-6e2f901a95a4` returned PASS for the bounded
checkpoint commit/push with no must-fix finding. It confirmed F1 and F3 fixed,
kept F2 open and correctly bounded, and retained F4 as informational. It also
noted that `AcquireFromCurrentImage` does not apply the external pin: this is
consistent with direct supervisor invocation remaining inadmissible, and a
future production launcher must apply the same externally pinned lease. The
review consumed only a fixed text packet, used no tools, made no repository
change, and had no permission denial. Its retained JSON SHA-256 is
`a5ad061b23959dd5f5d7c6b43fa03dd44810f96272caeee8c30f45725ee94d2b`.

## Release truth and remaining operations

The compiled code and ordinary checks are not runtime enforcement evidence.
The eight-scenario installed lifecycle, recovery observations, and two live
provider canaries remain unrun under this checkpoint's ordinary-only scope.
No production fingerprint was admitted.

**Remaining safety-gated operation (reported separately): mandatory existing
native corpus execution.** It was not invoked, inspected, modified,
reproduced, described, rerouted, or approximated by this work.

Consequently this branch may carry only a focused checkpoint commit. It must
remain unmerged and untagged; Stage 17W is not complete.
