# GitHub workflow and standing policy

GitHub is the **remote system of record** for this project. Local Git remains the
working history, and the two are kept in step by the rules below rather than by
habit.

This document is normative. It is the policy every future implementation task on
this repository follows.

## Repository facts

| Fact | Value |
| --- | --- |
| Visibility | **public temporarily** — operator-managed for GitHub-hosted L-03 CI; return to private is a separate action |
| Default branch | `main` |
| Protected branches | **none** — branch protection is unavailable on this plan, see below |
| Release lineage | `v0.1.0` … `v0.16.0`, one tag per completed stage |
| Current work | `feat/stage-17-secure-execution-backends` (gated, unmerged) |

`main` carries the latest completed release lineage plus repository governance.
It deliberately does **not** carry Stage 17: Stage 17 is a gated checkpoint, and a
default branch that contained it would imply a release that has not happened.

## Merge policy

| Method | Enabled | Why |
| --- | --- | --- |
| Squash | **Yes** | The default for a focused change. One reviewable commit on `main`. |
| Merge commit | **Yes** | For a stage branch, whose intermediate commits and their evidence are the record. Squashing a stage would destroy the per-checkpoint history this project's evidence documents refer to by SHA. |
| Rebase | **No** | Rebasing rewrites commits. This repository never rewrites published history, and a merge method that does so by design is the wrong tool here. |

Branches are deleted automatically after merge, and auto-merge is disabled: no
change reaches `main` without someone deciding it should.

## Security features: what this repository actually has

Feature-detected against the API rather than assumed, because a security control
you believe you have and do not is worse than a known gap. The table below records
the standing private-repository feature state; temporary public visibility for
hosted L-03 validation does not turn public-plan features into durable controls.

| Feature | State |
| --- | --- |
| Dependabot vulnerability alerts | **Enabled** |
| Dependabot automated security fixes | **Enabled** |
| Secret scanning | **Unavailable** — GitHub Advanced Security, not offered for this private repository's plan |
| Push protection | **Unavailable** — same reason |
| Private vulnerability reporting | **Unavailable** — API reports the feature absent |
| Branch protection / rulesets | **Unavailable** — both refused with 403, see the section below |

The operator later made the repository public temporarily so standard
GitHub-hosted runners could complete L-03 validation without paid private minutes.
The L-03 task changed no visibility or repository setting and does not restore
privacy; that remains a separate operator action. Two private-state consequences
are handled rather than ignored:

- Vulnerability reports come by email; `SECURITY.md` says so plainly instead of
  pointing at a button that does not exist.
- Because no server-side secret scanning exists, the local pre-push scan below is
  not a belt-and-braces extra. It is the only secret scanning this repository has.

## Defects that CI surfaced

CI had never run on this repository before it was created, and the code had only
ever been validated on Windows. The first runs found three defects across 32
packages. L-01 and L-03 are closed below; L-02 remains open and separately
scoped.

**L-01 — Fixed: the Claude child now receives only its broker-owned platform
home.**
`packages/provider-claude-code/test/security.test.ts` unconditionally asserted
that the child environment did not contain `HOME`. The broker deliberately sets
a broker-owned session home — `HOME` on POSIX, `USERPROFILE` on Windows — so the
assertion failed on Ubuntu and passed on Windows without checking the Windows
home at all. The provider README, live-test comment, and roadmap repeated the
same incorrect omission claim.

The reconstructed contract starts from an empty environment and never inherits
the invoking user's profile. After admission the broker may add one trusted,
fresh session home under its session root using the platform name. The opposite
home name and provider-unused XDG redirectors stay absent, and request bindings
cannot set any home/profile redirector. An explicitly authorized API-key secret
binding remains supported. This blocks default installed-login discovery but is
not filesystem containment under `unsafe-development-current-user`.

The stronger test found a second Windows-specific part of L-01: Node copied the
parent process's `HOMEDRIVE` and `HOMEPATH` into the spawned child even though the
broker's environment object omitted them. The repair suppresses only those two
ambient values for the synchronous native spawn call and restores the parent
immediately. Lower-level tests simulate hostile POSIX and Windows homes, a null
home, ordinary and secret override attempts, and explicit permitted bindings.
The real fake CLI records only allowlisted bounded values and proves the selected
home exists empty under the expected session root, is neither equal to the root
nor accepted through a sibling-prefix collision, is outside source/managed
workspaces and the ambient profile, and is removed before settlement. Do not
mark this defect closed without a run for the exact repair commit on both hosted
operating systems.

Corrective commit
[`6bd96c4005f24c575e5e4d849a9d5299e2901a08`](https://github.com/alijabbar04/ai-development-os/commit/6bd96c4005f24c575e5e4d849a9d5299e2901a08)
was checked out by run
[`31226295963`](https://github.com/alijabbar04/ai-development-os/actions/runs/31226295963).
The
[`Ubuntu check`](https://github.com/alijabbar04/ai-development-os/actions/runs/31226295963/job/93021175912)
and
[`Windows check`](https://github.com/alijabbar04/ai-development-os/actions/runs/31226295963/job/93021175888)
both passed. On each host all 45 Claude security tests executed and passed. The
process-broker suite passed on both; all 19 retained L-03 containment tests ran
on Windows, while Ubuntu skipped only the physically unavailable Windows
cross-volume vector. The
[`coverage job`](https://github.com/alijabbar04/ai-development-os/actions/runs/31226295963/job/93021175898)
also ran all 45 Claude security tests and all 19 containment tests on Windows.
Process-broker coverage was 91.53% statements, 86.43% branches, 90.43%
functions, and 92.54% lines; Claude-provider coverage was 90.70%, 83.81%,
94.32%, and 90.72%. All floors remain unchanged.

The workflow's overall conclusion is nevertheless failure because its
[`dependency audit`](https://github.com/alijabbar04/ai-development-os/actions/runs/31226295963/job/93021175861)
independently reported the newly published `GHSA-2v37-7h3g-55p8` against the
unchanged transitive `nanoid@3.3.16` lock entry. That is a real, separately
scoped dependency finding; no dependency was changed or audit result hidden in
this bounded L-01 repair.

**L-03 — Fixed: `process-broker` canonicalised one side of a containment
comparison and not the other.**

`packages/process-broker/src/tool.ts:333-352` compares a resolved tool image
against its containment root:

```ts
resolved = await realpath(descriptor.executablePath);   // canonicalised
const root = descriptor.containmentRoot;               // NOT canonicalised
if (resolved !== root && !resolved.startsWith(root.endsWith(sep) ? root : root + sep)) { … }
```

The executable went through `realpath`; the root did not. Two paths that named the
same directory therefore failed to compare equal whenever the root as supplied was
not already in its canonical on-disk form. Two tests in
`packages/process-broker/test/edges.test.ts` — "verifies a matching digest and
accepts the tool" and "accepts a tool inside its containment root" — expected a
resolved tool but actually received `EXECUTABLE_UNSAFE` in both the `check
(windows-latest)` and `coverage` jobs for main run `31175235796` and Stage 17 run
`31175253557`. Both used Actions runner `2.336.0`, Windows Server 2025 image
`20260803.193.1`, and Node `24.18.1`.

The errors correctly serialized no operands. The sanitized spelling difference is
the hosted runner's 8.3 temporary-user alias:

```text
lexical root:    C:\Users\RUNNER~1\AppData\Local\Temp\<task-leaf>
canonical image: C:\Users\runneradmin\AppData\Local\Temp\<task-leaf>\<tool>
```

This is long/short-name canonicalization, not a casing-only difference and not
junction resolution. The regression suite also supplies its own case-variant root,
so it deterministically distinguishes the fix even on a Windows machine whose
ambient temporary path is already canonical.

The failure direction was **closed**: a legitimate tool was refused, not an
illegitimate one admitted. It was therefore a portability and robustness defect,
not an escape. The asymmetry nevertheless had the same shape as Stage 17's F-01 —
two values meant to correspond, where only one was normalized.

The fix canonicalizes the executable and containment root independently at the
live resolution boundary, refuses either resolution failure, and uses
`relative()` with component-aware `..`, absolute-result, and equality checks.
Missing or unreadable roots use the existing `EXECUTABLE_UNAVAILABLE` public code;
an existing non-directory root is `EXECUTABLE_UNSAFE`. Equality is refused because
the descriptor contract requires a directory root and a file executable.

The root entry itself must be an ordinary directory. A root symlink or junction is
refused even when `allowLinkIndirection` permits deliberate executable indirection;
that flag does not expand the descriptor's boundary authority. Executable links
remain governed by the existing flag, and their canonical target must still be a
descendant. The same-user path and digest checks retain their documented TOCTOU
limitation: without an immutable backend reference, another same-user process can
replace filesystem objects between verification and image load.

Two isolated built-output mutants distinguish the regressions. Mutant A replaced
the component comparison with the original lexical-root/string-prefix comparison:
the fixed build accepted a case-variant Windows root naming the same hierarchy,
while the mutant refused it with `EXECUTABLE_UNSAFE`. Mutant B retained both
canonicalizations but bypassed the containment predicate: the fixed build refused
an existing outside-root tool with `EXECUTABLE_UNSAFE`, while the mutant accepted
it. Neither mutant modified the authoritative worktree, and all task-owned mutant
and filesystem-test leaves were removed after the proof.

**Hosted closure evidence.** The first executed rerun of the original fix was
[`31182304551`, attempt 2](https://github.com/alijabbar04/ai-development-os/actions/runs/31182304551)
at exact head `38d8b9fc350ea54e020572779e997ef224d0857e`. Its
[`check (windows-latest)` job](https://github.com/alijabbar04/ai-development-os/actions/runs/31182304551/job/92896653467)
and
[`coverage` job](https://github.com/alijabbar04/ai-development-os/actions/runs/31182304551/job/92896653766)
both failed at `tool-containment.test.ts:146` before the named casing vector called
`resolveTrustedTool`. The fixture's lexical path combined the hosted runner's
`RUNNER~1` ancestor with a deliberately case-varied leaf. The diagnostic helper
returned one priority-ordered string, so it reported
`8.3-short-name-to-long-name`; the brittle assertion required the whole pair to
equal `casing-only`. Production containment did not refuse. The preceding ambient
8.3 vector was accepted, and every later equality, traversal, sibling-prefix,
outside-root, cross-volume, linked-root, and executable-escape vector executed and
passed.

Local validation missed the harness defect because the local temporary root was
already canonical. Only the controlled casing difference remained, so the
exclusive label happened to equal `casing-only`. Corrective commit
`a6d1da73a7a7e9053a15628dfbc8652a9ea23088` replaced that enum-like label with
independent, path-redacted characteristics, used a canonical ancestor for a true
casing-only live vector, retained the live hosted 8.3 vector, and added a composed
live vector plus positive and negative detector controls. Reintroducing the old
exact-label assumption produced expected `casing-only`, actual
`8.3-short-name-to-long-name`; the corrected combined detector recorded both
`casing=true` and `8.3-short-name-to-long-name=true`.

Corrective-code run
[`31195723647`](https://github.com/alijabbar04/ai-development-os/actions/runs/31195723647)
checked out that exact commit. The
[`Windows check`](https://github.com/alijabbar04/ai-development-os/actions/runs/31195723647/job/92923330628)
and
[`coverage`](https://github.com/alijabbar04/ai-development-os/actions/runs/31195723647/job/92923330681)
jobs both logged, without operands:

```text
ambient:    casing=false; 8.3-short-name-to-long-name=true
casing-only: casing=true;  8.3-short-name-to-long-name=false
combined:   casing=true;  8.3-short-name-to-long-name=true
```

All 19 Windows containment tests executed and passed in both jobs. Process-broker
coverage was 91.56% statements, 86.74% branches, 90.32% functions, and 92.59%
lines, above the unchanged 90/80/90/90 floors. The
[`dependency audit`](https://github.com/alijabbar04/ai-development-os/actions/runs/31195723647/job/92923330664)
found zero vulnerabilities. The only failure in the complete
[`Ubuntu log`](https://github.com/alijabbar04/ai-development-os/actions/runs/31195723647/job/92923330597)
was the separately tracked L-01 `provider-claude-code` assertion at
`security.test.ts:628`, where `HOME` was present; process-broker passed there with
only the physically unavailable Windows cross-volume vector skipped. The Node 20
action-runtime deprecation annotation is a separate non-blocking maintenance item.
No Stage 17 stateful operation was performed.

**L-02 — `@ai-dev-os/workspace` misses its coverage floors on Linux.**
89.62% statements against a 90% floor, and 79.77% branches against 80%, because
platform-specific branches are unreachable on Linux. The coverage job therefore
runs on Windows, where the floors were measured. **Do not lower a threshold to
close this.** The fix is to make those branches reachable on Linux or to make the
floors platform-aware.

L-01 and L-03 are not expected failures on either check platform. L-02 remains
open and explains the Windows placement of the separate coverage job; no
threshold is lowered. The independent dependency-audit finding above remains
visible and requires its own bounded update.

## Standing policy for every future task

### Before making changes

1. Verify the exact `origin`, the authenticated owner, the current branch, its
   upstream, the worktree state, and any divergence from the remote.
2. Fetch remote metadata before changing anything. Work from what the remote
   actually says, not from what a previous session recorded.
3. Work on a task-specific branch. **Never commit new task work directly to
   `main`.** Nothing stops you: branch protection is unavailable on this plan, so
   there is no block to catch a mistake here. This rule is load-bearing precisely
   because it is unenforced.

### While making changes

4. Preserve unrelated edits. If files you did not touch have changed, find out
   why before proceeding; do not sweep them up and do not discard them.
5. **Stage only explicitly reviewed paths.** Never `git add .`, `git add -A`, or
   `git add --all`. This repository has had concurrent sessions writing to one
   worktree; a broad add commits work whose provenance the committer cannot
   vouch for.
6. Run validation proportional to the risk of the change. A security-boundary
   change needs the full `npm run check`, the relevant defect proofs, and an
   independent review. A typo in a comment does not.
7. Scan changed content for secrets and generated artifacts before committing.

### Committing and pushing

8. Commit successful changes with focused, scoped messages.
9. **Honest failed-checkpoint evidence may be committed and pushed** when it is
   clean, accurate, and free of unsafe generated artifacts. A recorded FAIL is
   more valuable than an absent record. What must **never** be pushed is
   interrupted, unverified, partial work pushed merely to back it up — this has
   happened, was caught, and is the reason the rule is written down.
10. Push the current task branch after commits and validation. Set upstream only
    when it is absent.
11. **Never force-push.** Not `--force`, not `--force-with-lease`. Never delete a
    remote branch or tag. Never rewrite published history.
12. If the remote branch has diverged, fetch and inspect. Do not blindly pull,
    merge, or rebase.
13. Verify the remote commit after pushing by comparing local and remote object
    IDs. A push that reported success and a ref that actually moved are two
    different facts.

### After pushing

14. Wait for GitHub Actions. Report the check URLs and their outcomes.
15. Fix in-scope CI regressions and push the corrective commit. **Do not weaken
    or delete a valid test to turn CI green.** If a test is genuinely wrong, say
    why in the pull request and fix the test as its own reviewable change.

### What requires separate, explicit authorization

None of the following may be done on inference from a task description. Each
needs the user to ask for it:

- creating or merging a pull request;
- creating a tag or a GitHub Release;
- publishing a package to any registry;
- changing repository visibility;
- force-pushing, deleting refs, or rewriting history;
- adding a licence, or describing the project as open source.

### Never

- Expose credentials, secrets, tokens, private host paths, or raw sensitive
  evidence in a commit, a pull request, an issue, or a CI log.
- Store a token in the repository. GitHub CLI holds the user's session; nothing
  in this repository needs a credential of its own.
- Encode automatic external mutation into package runtime code, git hooks,
  install scripts, or CI. Nothing in this repository may push, tag, publish, or
  open a pull request as a side effect of being installed, built, or tested.
  Remote mutation is an explicit human act.

## Secret scanning before a push

There is no history-aware secret scanner installed on the maintainer's host and
none is downloaded automatically. The scan is done with Git plumbing over every
blob reachable from every ref — not just the working tree — using conservative
provider-specific and generic credential patterns, with every candidate
dispositioned by inspection.

Candidates are expected and are not automatically problems. This repository
contains, legitimately:

- the detection patterns of its own secret-redaction module in
  `packages/memory/src/redaction.ts`;
- test vectors for that module using published vendor examples and obvious
  alphabet sequences;
- negative-test fixtures asserting that inline credentials are **rejected**,
  including a deliberate canary string.

A candidate is dispositioned by reading it. An unresolved likely secret blocks
the push. If a real secret is ever found in history, **stop** — do not rewrite
history to remove it without separate authorization, and report the affected refs
and commits without reproducing the value.

## Branch protection: UNAVAILABLE, and what that actually means

**`main` is not protected, and it cannot be on this plan.** Both mechanisms were
attempted and both were refused:

| Mechanism | Result |
| --- | --- |
| Classic branch protection (`PUT /repos/…/branches/main/protection`) | **403** — "Upgrade to GitHub Pro or make this repository public" |
| Repository ruleset (`POST /repos/…/rulesets`) | **403** — same message |

Making the repository public would obtain both. **That is refused**, and the
refusal is the point: a private repository whose protection was purchased by
publishing its contents has not been protected, it has been exposed. No other
setting was weakened to compensate either.

So the following are, on this plan, **conventions rather than enforced
controls**, and nothing server-side stops the maintainer from doing any of them:

- not force-pushing;
- not deleting `main`;
- not committing task work directly to `main`;
- not merging without CI passing.

Stated plainly because a control you believe you have and do not is worse than a
known gap: **the standing policy below is the only mechanism.** Every rule in it
that would otherwise be enforced by protection is now enforced by whoever is
following it. That is a real weakness, it is recorded here rather than glossed,
and it is the strongest argument in this repository for either a Pro plan or a
deliberate decision to accept the risk.

The intended configuration, for whenever protection becomes available, is:
blocked force pushes, blocked deletion, pull request required, the required checks
in the CI section below, and conversation resolution required. The
required-approval count is deliberately **zero**: this is a single-maintainer
repository, and a rule that makes every change unmergeable is a rule that gets
switched off. Review still happens, by independent audit sessions and by the
evidence discipline in `CONTRIBUTING.md`.

## CI

`.github/workflows/ci.yml` runs on pushes to maintained branches and on pull
requests targeting `main`, so a feature branch receives CI when pushed rather than
only at pull-request time.

Every action is pinned to a full commit SHA with its release tag in a comment,
because a tag is a mutable pointer and whoever controls the action repository can
move it. Top-level permissions are `contents: read`; pull-request code never runs
with a writable token.

What CI deliberately does not do is enumerated at the bottom of the workflow file:
no elevation, no protected-location writes, no AppContainer profile or Job object,
no process-lifecycle proof, no proof-mode native execution, no live provider
calls, no secrets, no publication, no release. The native components are built and
self-tested only by the local packaging script under explicit human operation.

## Dependabot

`.github/dependabot.yml` proposes weekly, bounded updates for npm and GitHub
Actions against `main`. Updates are grouped only where grouping does not hide a
major-version change, open-PR limits are small, and **nothing merges
automatically**. A dependency update to a project with this repository's security
posture is a change to review, not a change to accept.

Pinning actions by SHA and letting Dependabot propose the upgrades is the intended
division of labour: the pin means CI cannot change under you, and the Dependabot
pull request means an upgrade is a decision someone made.
