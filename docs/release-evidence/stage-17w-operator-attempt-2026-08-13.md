# Stage 17W operator-present stateful attempt

Date: 2026-08-13 (BST)

## Outcome

This packet records a **failed-closed Stage 17W stateful attempt with one
preserved empty protected leaf**. Stage 17W remains gated. It is not a lifecycle
proof, restricted proof, release, production admission, or permission to retry
or broaden cleanup.

The corrected deterministic preflight passed exactly. After explicit operator
approval, the reviewed proof installer returned exit code `2`. The ordinary
post-install/stateful controller lifecycle was not invoked; controller activity
was limited to the retained pure describe/self-test/plan preflight. The
packet-required exact remover was then invoked once for the same token and also
returned exit code `2`. Independent read-only inventory found only the empty
token-derived ProgramData leaf; every other residue category remained zero.

## Reviewed identities

Published Stage 17W evidence line:

- branch `feat/stage-17w-complete`;
- starting commit `311b95a21322b6999a0432c454580c1e9922b12e`;
- starting tree `6599926d9d7f39de3a36553deab7e78df0505529`;
- local, upstream, remote-tracking, and live remote refs equal before this
  evidence delta;
- worktree/index clean with no Git lock or operation state; and
- exact-head hosted run
  [`31538818416`](https://github.com/alijabbar04/ai-development-os/actions/runs/31538818416)
  completed successfully.

Reviewed implementation/build line:

- clean detached commit `1cd722859800e8c889b1c558afd098bde6ac343f`;
- tree `1861c447d069bf60c08696683f58faf0cafa4e31`;
- .NET SDK `9.0.316`;
- fresh task-owned artifact root
  `ai-dev-os-stage17w-pure-preflight-20260813-085715`; and
- run token `0d795cbc5427427aa386db71cba527fd`.

The continuation prompt named
`C:\Users\mrali\Projects\ai-dev-os-stage-17-secure-execution` as the relevant
Stage 17 worktree. Read-only reconciliation showed that path was instead a
clean Stage 19B worktree on another branch. It was not switched, edited, or
used. The published Stage 17W evidence worktree and clean detached reviewed
implementation above were used instead.

## Pure deterministic preflight

Five exact `dotnet publish` commands from the corrected packet produced the
runtime closure, proof controller, and proof installer. Pure outputs proved:

- controller component `windows-proof-controller`, reviewed-proof mode,
  `productionEligible: false`, 2 vectors, zero failures;
- installer component `windows-proof-installer`, reviewed-proof mode,
  `productionEligible: false`, 190 vectors, zero failures;
- one installable `stage17w-runtime-v1` candidate;
- installer plan `filesystemTouched: false`;
- exact 193-name candidate inventory; and
- source-envelope fingerprint
  `16f327aa858f25e85c9f335d658e1879d1c93729940648df19cd6966326eb5c8`.

The four reviewed proof-artifact hashes matched exactly:

| Artifact | SHA-256 |
| --- | --- |
| Controller executable | `2678a479e863fc80360ec4371b9b78be96d8588cda1beffe51066012b09e9735` |
| Controller DLL | `31b866dcfa9bc07a239a06ef422863e5df2ba3b08c22230859c8cce2003c2e53` |
| Installer executable | `09b32936f4dcbcf4dddcbdbcb4b504a7aeb254eb5bec20b0aea4463abf162421` |
| Installer DLL | `befda5f13e986f5f9eab3d964ceb1da27b117a4a291ee80e60f850b6756cb5b5` |

No installation, registry/profile/process lifecycle, egress, or restricted
operation occurred during pure preflight.

## Pre-install independent inventory

Immediately before elevation, read-only checks recorded:

- install volume filesystem `NTFS`;
- ProgramData boundary not a reparse point;
- exact token-derived install leaf absent;
- filesystem residue `0`;
- marker residue `0`;
- package-folder residue `0`;
- registry residue `0`;
- helper-process residue `0`;
- fixture-process residue `0`;
- generic task-directory residue `0`; and
- generic registry residue `0`.

The inventory used only the token/profile/path names emitted by the reviewed
plans and the two bounded AppContainer registry roots. It did not invoke the
controller or inspect the separately restricted corpus.

## Exact elevated attempt and refusal

The operator approved the packet's two narrowly scoped UAC actions. The
controller remained unelevated.

1. The exact reviewed installer executable was launched directly with verb
   `RunAs` and only `install --token <token> --candidate
   stage17w-runtime-v1 --source <fresh-runtime-closure>`. It exited `2` at
   `2026-08-13T08:42:12.8391089Z`.
2. No post-install controller run/lifecycle/egress command was invoked; the
   controller plan was generated only during the retained pure preflight.
3. Per the packet's aborted-install rule, the same reviewed installer
   executable was launched directly with verb `RunAs` and only
   `remove --token <token>`. It exited `2` at
   `2026-08-13T08:42:29.0834198Z`.

No wrapper, alternate destination, ACL argument, force option, recursive
delete, shell cleanup, ownership change, second token, or retry was used. The
direct UAC launches did not provide redirected stdout; the durable facts are
the exact executable/arguments, process completion records, exit codes, and
independent state observations. Missing successful transaction JSON is itself
part of the failed proof.

## Post-refusal state

The bounded independent inventory at `2026-08-13T08:43:01.0373477Z` found:

| Category | Count |
| --- | ---: |
| Filesystem residue | 1 |
| Marker residue | 0 |
| Package-folder residue | 0 |
| Registry residue | 0 |
| Helper-process residue | 0 |
| Fixture-process residue | 0 |
| Generic task-directory residue | 0 |
| Generic registry residue | 0 |

The one filesystem residue is the exact empty leaf:

`C:\ProgramData\AI-Dev-OS\Stage17-Proof\0d795cbc5427427aa386db71cba527fd`

A final read-only inspection at `2026-08-13T08:43:25.8767145Z` established:

- zero child directories;
- zero files and zero file bytes;
- no `stage17-proof-manifest.json`;
- no `stage17-proof-install-record.json`; and
- leaf ACL SHA-256
  `5ad50bd5ce6f998199d36fbd425808edbeeb898976a24b413d5f7b16197f9ef2`.

The leaf remains untouched and protected for manual review. The failed remover
is not permission to delete, rename, take ownership, change its ACL, reroute
cleanup, or invoke another tool. Any future remediation requires a separately
reviewed, explicitly authorized procedure.

## Closure truth and remaining gate

- Corrected pure preflight: **passed**.
- Reviewed elevated install: **failed closed, exit 2**.
- Ordinary controller lifecycle: **not run**.
- Conditional egress: **not run**.
- Separately safety-gated/restricted operation: **not run**.
- Reviewed remover: **failed closed, exit 2**.
- Zero-residue proof: **failed** because the empty token leaf remains.
- Production eligibility/admission: **false**.
- Stage 17W: **gated**.

Repository validation passed root `npm run check` with exit 0 in
1,171.5 seconds, covering all workspace typechecks, deterministic tests, and
builds. `git diff --check` also exited 0 with line-ending conversion notices
only. Post-validation documentation edits recorded those terminal results,
advanced the roadmap date, and corrected review-identified wording about the
failed-closed native/controller boundary. They changed no source, test, or gate
result. Independent review, commit, push, and hosted reconciliation remain
future facts here.

## Safety and nonclaims

- No restricted corpus or operation is described, reconstructed, or invoked.
- No provider credential, prompt, request body, response body, UI/session state,
  unrelated process, or unrelated registry/filesystem location was accessed.
- The four operator-protected historical residue paths were not touched.
- No production service/task registration, production activation, `main`
  mutation, merge, rebase, force-push, tag, release, signing, or package
  publication occurred.
