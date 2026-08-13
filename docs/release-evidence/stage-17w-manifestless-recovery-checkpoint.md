# Stage 17W manifestless partial-install recovery checkpoint

Date: 2026-08-13 (BST)

Outcome: **SOURCE-ONLY DEFENSIVE REMEDIATION PUBLISHED AND EXACT-HEAD GREEN;
NO ELEVATED OR PROTECTED-STATE OPERATION PERFORMED**

This checkpoint repairs the transaction protocol that previously left an empty,
manifestless token leaf after a failed install and could not remove it. It is not
a stateful lifecycle proof, removal receipt, Stage 17W completion, production
admission, merge, tag, or release. The existing operator packet must not be
retried. A new elevated attempt requires fresh explicit approval tied to the
separate remediation packet.

## Exact source and publication identity

- Base commit: `c8313b6fd24f343e48bd64712eb183fa2d4ab7c7`.
- Base tree: `b642be8d879a4a09f5469f5d7460fb6e423d1dbd`.
- Branch: `fix/stage-17w-manifestless-partial-install-recovery`.
- Source remediation commit:
  `3e9fa16d47f227deb6358a4a9cdf2e8011393fa5`.
- Exact published head after a test-only Windows line-ending repair:
  `7a7f4902871f10de11fe4e59bfe6a761dc7b497a`.
- Exact published tree:
  `a1bca2219f01e63abd2079ea91f64b7d118124f7`.
- Remote: `origin`, branch of the same name, pushed non-forced.
- Exact-head CI:
  [run 31746647903](https://github.com/alijabbar04/ai-development-os/actions/runs/31746647903),
  successful.

The first pushed source head, `3e9fa16d47f227deb6358a4a9cdf2e8011393fa5`,
produced [run 31745329753](https://github.com/alijabbar04/ai-development-os/actions/runs/31745329753).
Ubuntu check and dependency audit passed, while Windows check and the
Windows-hosted coverage job rejected an LF-only static-test assertion on a CRLF
checkout. The one-line follow-up normalizes only the bounded extracted test
string from CRLF to LF; it changes no production, native, package, or verifier
behavior. The failed run was not rerun. The new exact-head run passed all four
jobs:

| Job | Result | Duration |
| --- | --- | ---: |
| coverage | pass | 8m41s |
| check (windows-latest) | pass | 18m25s |
| check (ubuntu-latest) | pass | 5m44s |
| dependency audit | pass | 11s |

GitHub emitted informational Node-action deprecation notices for the pinned
checkout/setup-node actions. They did not fail a job and were not changed by
this candidate.

## Proven static diagnosis

The earlier installer created the exact token leaf before the first destination
file. A later refusal had no rollback path, leaving an empty protected leaf. The
remover required `stage17-proof-manifest.json` before deletion, so the same
empty manifestless state refused as `removal-record-unreadable` and remained.
The prior packet's installer and remover each exited `2`.

The prior evidence, not a read in this session, records the preserved leaf as:

`C:\ProgramData\AI-Dev-OS\Stage17-Proof\0d795cbc5427427aa386db71cba527fd`

At its last authorized observation on 2026-08-13 it was empty, contained no
manifest or install record, and was deliberately preserved. This checkpoint did
not read, enumerate, open, modify, remove, rename, move, take ownership of, or
change the ACL of that leaf. Its present physical state is therefore **not
revalidated here**.

## Remediation boundary

The source now:

- gives `DELETE` only to the exact create-only token leaf during install;
- keeps the two shared removal directory handles traverse-only and gives
  directory-delete authority only to the exact token leaf;
- performs rollback only for the exact leaf created by the current transaction;
- preserves the primary install refusal and records rollback status/code/step in
  separate finite fields;
- refuses rollback unless the exact retained chain, object identities, directory
  types, non-reparse state, access bounds, and private owner/exact DACL still
  match;
- observes emptiness twice, re-proves the full chain after the observations, and
  passes only the retained token-leaf handle to deletion;
- recognizes the exact manifestless-empty removal state under the same bounded
  proof, while every nonempty, replaced, reparse, foreign-owner, DACL-drifted,
  identity-drifted, inaccessible, or ancestor-drifted state refuses without
  deletion;
- maps filesystem-adapter exceptions, including pre-state failures, to finite
  body-free transaction/rollback refusal fields; and
- introduces no arbitrary path, recursive deletion, force switch, shell,
  service, task, network, registry, ownership-taking, or ACL-changing surface.

The build pipeline now also refuses a reviewed-proof flavor unless proof-only
components are included, always builds production-shaped supervisor/helper
artifacts sealed, binds the proof installer/controller identities and reported
statuses, and fails on any proof-only two-build byte difference.

## Deterministic synthetic and package evidence

The final clean-commit artifact build used .NET SDK `9.0.316` and a fresh
task-owned root outside the repository. It built each production and proof
component twice, compared complete closures, and ran only read-only self-tests.
It did not invoke install simulation for proof bundles.

| Component | Exact result |
| --- | --- |
| Proof installer | 276/276, zero failures; digest `d4f89a04f5be011583318e30dda16e1f5f2720f1d6e0c3e72fde089ab7a083c5` |
| Proof controller | 2/2, zero failures; digest `cf12f49e59d6f0fbcc713bcdbf990a383ee30887f8dba068ccf9d8a91c8b6ef0` |
| Proof closures | both byte-identical across two builds; zero differences |
| Native side effects in self-test | zero native filesystem instantiations, zero native opens, `hostStateCreated: false` |
| Supervisor/helper | sealed, deterministic, manifest-matched, `productionEligible: false` |
| Cross-language manifest identity | exact agreement, fingerprint `c39961a4a6946201758403a86fe25795c89e70f607a1c6e3642c292419663054` |

Clean-commit proof artifact identities:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `AI.DevOS.WindowsProofInstaller.exe` | 156,672 | `09b32936f4dcbcf4dddcbdbcb4b504a7aeb254eb5bec20b0aea4463abf162421` |
| `AI.DevOS.WindowsProofInstaller.dll` | 192,000 | `d07411654d6be57b50442c587ba58816005d3fa999d50583c5663363fcebe863` |
| `AI.DevOS.WindowsProofController.exe` | 156,672 | `1d57d02ca6f303c2c45543679a8b2fa5c71dff59f1d9a37ad2def9f617626768` |
| `AI.DevOS.WindowsProofController.dll` | 268,800 | `344bd9d83fd307ad64cb1642e438aebf9e18da25935656f90a4a933afba9b247` |

The installer closure has 188 files / 78,090,995 bytes and canonical ordinal
`<name>|<bytes>|<sha256>` digest
`b4c4adc88b5d6078f5ad253e5f098db6fa0d178ccf0aeb5b252954b8065fb09c`.
The controller closure has 188 files / 78,167,612 bytes and digest
`353c3e54f508a582aa996dbd9e92643dbd55a81e5a954e44f52c4a1f69e40ebe`.
Lines are joined by LF with no final LF. These comparison digests bind every
runtime file in the measured closures.

The local build report was 14,020 bytes with SHA-256
`2e0b83bf415fbf779b0abd9c2a6b47bd69ece3c348b6151dd20ebdfef5aeadf8`.
That report hash binds its local output-root field and is evidence, not a future
trust input.

Other final local gates:

| Gate | Exact result |
| --- | --- |
| Focused static/package slice | 2 files, 100/100 passed |
| Process-broker coverage | 8 files; 446 passed, 1 intentional skip |
| Process-broker coverage totals | statements 2,166/2,338 (92.64%); branches 1,308/1,517 (86.22%); functions 364/370 (98.37%); lines 2,067/2,206 (93.69%) |
| Process-broker typecheck/build | pass/pass |
| Monorepo typecheck | pass, 328.3s |
| Dependency audit | zero findings at every severity; 217 dependencies |
| Dependency tree | `npm ls --all --json` exit 0 |
| Process-broker dry pack | 122 entries; 169,070 packed bytes; 772,733 unpacked bytes; SHA-1 `a3f26be48d807003870ce82838c51fb1f706d0ba`; zero bundled dependencies |
| Diff integrity | `git diff --check` pass |

A local root `npm run check` did not return before its shell boundary and was
recorded as inconclusive, exit `124`. Its remaining repository-matching Vitest
process tree was identified by exact command lines and terminated; a follow-up
inventory found zero matching processes. This was not counted as a pass. The
same root check subsequently passed in both exact-head hosted Ubuntu and Windows
jobs.

## Independent review

GPT-5.6 Sol at Max effort performed a strictly read-only same-family review of
the exact source/package/docs/test candidate. It returned PASS after the
authority, rollback, exception, race, build-flavor, identity, determinism, and
mutation-discrimination findings were repaired. It then rechecked the one-line
CRLF normalization at exact commit `7a7f4902871f10de11fe4e59bfe6a761dc7b497a`
and returned PASS again. The reviewer did not run tests, native operations,
Git/GitHub mutations, or protected-state reads. Usage/cost evidence was not
available.

## Nonclaims and remaining boundary

- No UAC prompt, install, removal, lifecycle, egress, restricted proof, or
  protected-state inspection occurred in this remediation session.
- No production fingerprint was admitted. Windows production availability and
  `productionAdmitted` remain false.
- The preserved leaf is not claimed removed, unchanged, or presently empty.
- The synthetic conformance suite is not proof of real NT behavior.
- No PR, merge, main mutation, force-push, rebase, tag, release, signing, package
  publication, or production activation occurred.

The next boundary is the separate remediation operator packet proposed alongside
this checkpoint. It
proposes exactly one future elevated remover invocation followed by bounded
independent residue verification. It is not authorization to perform either.
