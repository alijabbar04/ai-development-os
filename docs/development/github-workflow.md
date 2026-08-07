# GitHub workflow and standing policy

GitHub is the **remote system of record** for this project. Local Git remains the
working history, and the two are kept in step by the rules below rather than by
habit.

This document is normative. It is the policy every future implementation task on
this repository follows.

## Repository facts

| Fact | Value |
| --- | --- |
| Visibility | **private** |
| Default branch | `main` |
| Protected branches | `main` |
| Release lineage | `v0.1.0` … `v0.16.0`, one tag per completed stage |
| Current work | `feat/stage-17-secure-execution-backends` (gated, unmerged) |

`main` carries the latest completed release lineage plus repository governance.
It deliberately does **not** carry Stage 17: Stage 17 is a gated checkpoint, and a
default branch that contained it would imply a release that has not happened.

## Standing policy for every future task

### Before making changes

1. Verify the exact `origin`, the authenticated owner, the current branch, its
   upstream, the worktree state, and any divergence from the remote.
2. Fetch remote metadata before changing anything. Work from what the remote
   actually says, not from what a previous session recorded.
3. Work on a task-specific branch. **Never commit new task work directly to
   `main`** — protection blocks it, and the block is the reminder, not the
   mechanism you should be relying on.

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

## Branch protection

`main` is protected so that:

- force pushes are blocked;
- deletion is blocked;
- a pull request is required before merging;
- the CI checks must pass;
- conversation resolution is required where supported;
- ordinary collaborators cannot bypass it.

The required-approval count is deliberately **not** set above zero. This is a
single-maintainer repository, and a rule that makes every change unmergeable is a
rule that gets switched off. Review still happens — by independent audit sessions
and by the evidence discipline in `CONTRIBUTING.md` — and that is recorded here so
the absence of a required approver is understood as a deliberate choice rather
than an oversight.

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
