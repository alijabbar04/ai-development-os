# Contributing

This repository has an unusually strict evidence culture. The rules below are not
style preferences — most of them exist because a specific defect got through
once, and the rule is what caught it or would have. Where that is the case, the
reason is stated, because a rule without its reason is a rule the next person
deletes.

## Getting set up

```powershell
npm ci
npm run check
```

`npm run check` runs typecheck, then tests, then build, across every workspace
package. It takes roughly 20 to 45 minutes depending on machine load. Every command in this
document was run against this repository before being written here.

Requirements: Node.js 22.9 or newer and npm 10 or newer, as declared in the root
`package.json` `engines` field. CI runs Node 24 on both Ubuntu and Windows.

Individual package:

```powershell
npm run typecheck --workspace @ai-dev-os/process-broker
npm test --workspace @ai-dev-os/process-broker
npm run test:coverage --workspace @ai-dev-os/process-broker
```

`@ai-dev-os/secrets-windows` also owns one explicit Windows-only native compile:

```powershell
npm run build:native --workspace @ai-dev-os/secrets-windows
```

The package pins `gypfile: false`, so npm cannot synthesize an install hook from
`binding.gyp`; the root pins dev-only `node-gyp@12.3.0` for this explicit command.
The build emits only ignored task-local output. CI compiles it on Windows with
warnings as errors. The ordinary mock-backed package tests cover malformed
targets and the exact native-port contract without loading the production addon.
The hosted runtime gate then loads the compiled addon and inspects its exact
`availability`/`read` export shape without invoking either function. This proves
the compiled ABI/link boundary while making `CredReadW` unreachable and touching
no Windows Credential Manager state. A native `not-found` smoke exists for a
separately authorized foundation run, but credential-host checkpoints do not run
it because even a synthetic target lookup is credential-store access.

Real PostgreSQL tests are a separate explicit gate. They require all five
`AI_DEV_OS_TEST_POSTGRES_*` fields and
`AI_DEV_OS_REQUIRE_POSTGRES_TESTS=1`; the dedicated hosted job supplies fixed
job-only values to a pinned disposable service. Ordinary local and matrix runs
record two capability skips when no server is configured. A deterministic driver
seam keeps offline coverage meaningful but is never reported as real-database
evidence.

### About `npm ci` and lifecycle scripts

Use plain `npm ci`. One reviewed dependency lifecycle script runs on install:

| Package | Hook | Command | Why it is required |
| --- | --- | --- | --- |
| `better-sqlite3@12.x` | `install` | `prebuild-install \|\| node-gyp rebuild --release` | Fetches a prebuilt native binding for the host ABI, falling back to compiling the bundled source. `packages/persistence-sqlite` cannot be tested without it. |

No first-party manifest in this repository declares a `preinstall`, `install`, or
`postinstall` script, and none may be added — adding one puts arbitrary code on
every contributor's and CI runner's install path.

Three transitive dependencies declare `prepare` scripts (`istanbul-reports`,
`lightningcss`, `tinyexec`). `prepare` does not run for registry tarballs during
`npm ci`, so they do not execute here.

Exact-pinned `electron@43.4.1` does **not** declare an install lifecycle hook.
The bounded credential-host smoke and packed-verification scripts run a reviewed
`ensure:electron` step before loading Electron. That step accepts only 43.4.1,
rejects environment-controlled platform/runtime selection, invokes the package's
checksummed `install.js` only when its local `dist` is absent, and then verifies
`dist/version`, `path.txt`, containment, and executable presence. Electron remains
outside production dependencies.

The ordinary credential-host real-Electron smoke writes its screenshot only below
the disposable smoke root printed in its result. It must remain repository-clean.
Tracked screenshot evidence may be changed only by the explicit
`npm run regenerate:credential-host-evidence-screenshot` command after UI changes
and review are complete. Do not add a custom output flag or combine regeneration
with another smoke mode; the wrapper deliberately refuses both.

`npm ci --ignore-scripts` works for anything that needs neither the SQLite
binding nor execution of the Electron verifier — typechecking, building, and `npm audit`.
CI uses it for the audit job for exactly that reason. It will fail
`packages/persistence-sqlite` tests; runnable Electron smoke or packaging
verification explicitly restores its separate exact runtime when required.

## Branch naming

Never commit task work directly to `main`. `main` represents the latest completed
release lineage plus repository governance.

Note that **nothing enforces this**: branch protection and rulesets are both
unavailable for a private repository on this plan, and making the repository
public to obtain them was refused. See
[`docs/development/github-workflow.md`](docs/development/github-workflow.md). The
rule matters more for being unenforced, not less.

| Prefix | For |
| --- | --- |
| `feat/` | A new stage or capability |
| `fix/` | A correction to delivered behaviour |
| `chore/` | Tooling, CI, repository governance |
| `docs/` | Documentation only |
| `integration/` | Merging parallel stage branches |

Include the stage where there is one: `feat/stage-17-secure-execution-backends`.

## Commits

Scoped, conventional-style subjects: `feat(process-broker): …`,
`fix(stage17): …`, `docs(adr): …`, `test(stage17): …`.

**Stage explicit paths. Never `git add .`, `git add -A`, or `git add --all`.**
This is not fussiness. This repository has had concurrent sessions writing to one
worktree, and a broad `git add` in that situation commits work whose provenance
the committer cannot vouch for. Stage the paths you reviewed.

Also never use, without explicit direction: `git reset --hard`,
`git checkout -- <path>`, `git clean`, `git stash`, force-push, or history
rewriting of any published branch.

**A design document and the code it governs belong in the same commit.** This has
gone wrong in both directions and both were audit findings: once an ADR marked
"Accepted" existed only as an untracked file, and once a commit shipped a
normative ADR that contradicted its own code in four places while omitting the
single most load-bearing disclosure.

## Tests and coverage

Every package has coverage floors in its `vitest.config.ts` and they are
enforced, not advisory. **Do not lower a threshold to make a change pass.** If a
change genuinely cannot be covered, say so in the pull request and explain why.

Beyond "the suite is green", this repository holds tests to three further
standards. All three come from real findings.

### 1. A test that compares a value against itself cannot fail

Literal-versus-computed is the only comparison that can fail. This defect has
recurred three times here under different names — a parity check that called the
same function on both sides, a vector comparing a value to itself, and a vector
comparing the literal `"true"` to the literal `"true"` while the surrounding
comments cited the earlier instances as the thing being avoided.

When you assert a fact about behaviour, ask what produced the observed value. If
the answer is "a constant in the same file", it is not a test.

### 2. A guard whose removal changes nothing observable is not a guard

For any security-relevant guard, the required question is: **if I delete this
guard, does anything observably change — and does it change for THIS reason?**

A vector that still fails after the guard is removed, but fails because an
unrelated mechanism produced the same refusal code, has stopped discriminating.
That distinction has produced findings twice: once where a hostile fixture's
directory did not exist, so removing the guard still failed for the mundane
reason that the path was absent; and once where two different guards returned the
same code.

For security-relevant changes, **reintroduce the defect and observe the failure.**
Record the observed expected-versus-actual in the pull request. If the suite goes
red for the wrong reason, the vector needs fixing before it counts.

### 3. Anything a simulation does not model, no test can see

Several components are verified against in-memory simulations of OS behaviour,
because the alternative is creating real OS state. That is legitimate and it is
bounded: three HIGH findings in the Stage 17 native installer were all properties
of a real kernel object that the simulation did not model — an object-graph link,
an enum family, and a per-handle byte offset.

If you add an operation to a simulated contract, model the property that makes it
possible to get wrong, and prefer an explicit contract operation over a
convenience hidden inside an adapter. A convenience hidden in an adapter cannot
have its own absence detected.

## Architecture decision records

An ADR under `docs/adr/` is required for any change that:

- moves, widens, or narrows a **security boundary**;
- changes what is trusted, or where authority comes from;
- changes a refusal from structural to conditional, or the reverse;
- adds a native interop call site, or extends the interop allow-list;
- changes the isolation, quota, or provider-egress contracts.

Number it sequentially, state the decision and its honest limits, and say what it
does **not** authorize. Do not mark an ADR "Accepted" in a commit that does not
also contain the code it describes.

## Security rules that are not negotiable

- **Do not weaken a production refusal gate.** Production autonomous execution
  refuses because no genuinely enforcing sandbox backend exists. Widening that is
  not a code-review matter; it requires the backend to actually exist and be
  tested.
- **Do not delete a security assertion so your own code fits.** If an assertion
  blocks a change, that is the assertion working. Escalate it: an implementation
  removing the check that would have caught it is the specific failure mode this
  project guards against. This has happened and was correctly escalated instead.
- **No live provider or model calls in ordinary tests.** Live calls are explicit
  opt-in, guarded by conditional skips, and must remain skipped by default. CI
  configures no provider credentials and must not start.
- **No credentials in the repository.** Not in source, tests, fixtures, config,
  or history. Secrets are resolved at runtime by reference through
  `packages/secrets`.
- **No generated artifacts committed.** No `.exe`, `.dll`, `.pdb`, `.so`,
  `.node`, publish directory, coverage output, proof manifest, recovery journal,
  or run token. Native builds write to a task-owned directory outside the
  repository, and the packaging script refuses an output path inside it.
- **No `shell: true`.** Process execution is structured.
- **No nondeterminism in production source** — no `Date.now`, `Math.random`,
  `randomUUID`, or locale-sensitive comparison where a result is compared,
  digested, or pinned.

## Pull requests

Target `main` from a feature branch. CI must be green: `check` on Ubuntu and
Windows, `dependency audit`, and `coverage`.

In the description, state:

- what changed and why;
- the measured validation you ran, with numbers rather than "tests pass";
- for security-relevant changes, the defect proofs you ran and what you observed;
- what the change does **not** do, if it could be mistaken for doing more;
- any ADR added or amended.

Do not overstate. An accurate description of a partial change is worth more than
a confident description of a complete one, and this project's audit history is
mostly a history of confident comments that outran their code. If a limitation
remains, name it — a pull request that says "this does not close X" is
reviewable; one that implies X is closed is not.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md).
