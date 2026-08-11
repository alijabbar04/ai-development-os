# Stage 19B serialized Git integration checkpoint

Date: 2026-08-11 (BST)

## Outcome

This is a **locally validated, production-disabled publication candidate**. It is
not yet a published or completed Stage 19B checkpoint because its focused source
commit, non-forced branch push, and exact-head hosted dependency-audit,
PostgreSQL, Ubuntu, coverage, and Windows jobs remain future facts.

- The complete final local source gates, exact restoration checks, package and
  consumer checks, and independent read-only source audit pass.
- `@ai-dev-os/integrator` remains incapable of production Git effects through
  its public production composition. The real Git implementation remains on the
  explicit `./testing` subpath.
- `INT-01` remains incomplete until the exact source head is hosted-green and
  the publication/final reconciliation gates pass. `ANT-02` and `AM-02`
  remain incomplete. `developmentAccepted` and `productionAdmitted` remain
  false.
- Stage 17W remains gated by the already disclosed native artifact hash
  mismatch. No Stage 17 restricted operation ran.
- No Stage 20A work started.

The permitted completion label, **Stage 19B production-disabled integration
checkpoint complete**, is deliberately not claimed by this pre-publication
packet.

## Exact candidate identity

- Base/head: `1dc802748b59612e629f1b3f94d78e91802ef76c`
- Base tree: `8de239ea21d416eb827aa18ee2dc714ac0fdb7ff`
- Base parent: `4fd90d553378fef8e12b5f6f9df40b9255bc6c4e`
- Branch: `feat/stage-19b-serialized-git-integration`
- Upstream: none
- Current Git-visible scope: 39 paths, comprising 17 tracked modifications and
  22 untracked paths; 38 paths precede this evidence file.
- Initial recovered scope: 37 paths, comprising 15 tracked modifications and
  22 untracked paths.
- Initial handoff evidence: 8,607 bytes; SHA-256
  `aeea459af542be575da8259e50f29b5dfe8b6e70b8466bf1b488f09e6f11a874`.
- Initial canonical inventory digest:
  `8188116cea7e1bbf9212aa9e1fd5d90154ff7a3674ace8fac49537a682f2cdd0`.

The sole product-source change made during this recovery window is the exact
`CONTRIBUTING.md` workspace count correction from 37 to 39. Status prose and
the `INT-01` evidence anchors were also refreshed without changing the row's
incomplete status or derived acceptance booleans. There are independently 39
package directories and 39 lockfile workspace entries. All other source and
test changes are the preserved Stage 19B candidate that was reviewed and
repaired before this recovery window.

There is still no Stage 19B commit, push, PR, merge, tag, release, signing,
package publication, production registration, or repository-setting change.

Explicit pre-evidence staging binds 38 cached Git blobs. For each path in
ordinal order, the canonical manifest contains
`path<TAB>cached-blob-sha256<LF>`. Its 3,987-byte SHA-256 is
`91299f3fdd01bdcc82b40f001d70af77b64fa8106021f93e3c9754011bcb68ff`.
This is deliberately the cached commit payload rather than working-tree bytes;
checkout line-ending filters make those identities differ for some files.

### Git-visible inventory

Tracked modifications:

```text
CONTRIBUTING.md
README.md
docs/implementation-roadmap.md
docs/release-evidence/stage-18-development-acceptance-matrix.json
docs/technical-design.md
package-lock.json
packages/persistence-postgres/package.json
packages/persistence-postgres/src/migrations.ts
packages/persistence-postgres/test/postgres-live.test.ts
packages/persistence-postgres/test/static-policy.test.ts
packages/persistence/README.md
packages/persistence/src/records.ts
packages/persistence/test/records-and-migrations.test.ts
packages/workspace/src/git-environment.ts
packages/workspace/src/git-runner.ts
packages/workspace/test/units.test.ts
packages/workspace/test/workspace-specific.test.ts
```

New paths:

```text
docs/adr/0026-stage-19b-serialized-git-integration.md
docs/release-evidence/stage-19b-serialized-git-integration-checkpoint.md
packages/integrator/README.md
packages/integrator/package.json
packages/integrator/src/contracts.ts
packages/integrator/src/errors.ts
packages/integrator/src/index.ts
packages/integrator/src/schema.ts
packages/integrator/src/state.ts
packages/integrator/src/store.ts
packages/integrator/src/testing/index.ts
packages/integrator/src/testing/real-git-port.ts
packages/integrator/test/adversarial-contracts.test.ts
packages/integrator/test/fixtures.ts
packages/integrator/test/real-git.test.ts
packages/integrator/test/schema-state.test.ts
packages/integrator/test/state-failure-paths.test.ts
packages/integrator/test/static-policy.test.ts
packages/integrator/test/store-failure-paths.test.ts
packages/integrator/test/store.test.ts
packages/integrator/tsconfig.json
packages/integrator/vitest.config.ts
```

## Implemented boundary

`@ai-dev-os/integrator` adds closed, bounded, production-disabled contracts
for exact request, admission, candidate-artifact, repository, route, validation,
and authority identities. It provides durable serialized leases/fencing,
deterministic fast-forward and reviewed-merge intent, effect-start, receipt,
recovery, exhaustion, terminal replay, exact idempotency, finite redacted
errors, and explicit non-authority for model output.

The testing-only real-Git adapter is limited to verified task-owned disposable
repositories. It binds canonical repository and physical-target identities,
protected refs, commits, trees, parents, source-history paths, object/file/byte
bounds, and candidate artifact lineage. It rejects untrusted hooks, filters,
merge/diff drivers, protocol overrides, partial-clone/promisor state,
alternates, replace/graft/shallow state, unsafe Git administration,
dirty/untracked state, symlink/reparse/submodule escapes, and out-of-scope
worktree paths. Process cancellation is forwarded and the shared runner
requires finite process-tree drain evidence before settlement.

Publication uses a private effect guard plus atomic compare-and-swap target
update. Durable effect-start precedes the boundary. Ambiguity cannot be
re-executed; reconciliation revokes or observes the guard and distinguishes
exact publication, proven no effect, prepared-only residue, divergence, and
manual-reconciliation exhaustion. Exact command identities make duplicate
delivery converge after physical SQLite reopen, including the final
recovery-exhaustion path.

PostgreSQL migration `0003` adds the `integration-run` aggregate type.
Sentinel-gated hosted tests cover exact migration history and real
multi-adapter integrator service/reopen/serialization behavior. The live suite
was not run locally because no task-owned PostgreSQL capability was started;
its exact-head hosted job remains a publication prerequisite.

## Definitive local validation

### Package and focused gates

- Integrator TypeScript `--noEmit`: exit 0 in 14.3 seconds.
- Integrator complete package: 7 files, 64/64 tests passed; Vitest 246.72
  seconds, lifecycle 274.1 seconds.
- Integrator complete production coverage: 7 files, 64/64 tests passed;
  statements 1,155/1,276 (90.51%), branches 1,190/1,325 (89.81%),
  functions 174/178 (97.75%), lines 1,035/1,049 (98.66%); lifecycle 273.6
  seconds.
- Workspace complete package: 3 files, 114/114 tests passed; Vitest 53.18
  seconds, lifecycle 61.7 seconds.
- PostgreSQL deterministic package: 5 files passed and 1 live-capability file
  skipped; 92 tests passed and 3 expected capability skips; lifecycle 15.2
  seconds.
- The post-review `INT-01` anchor/rationale refresh passed the focused Stage 18
  acceptance-matrix contract: 1 file, 3/3 tests, 213 milliseconds.

### Literal root gates

- Isolated root typecheck: exit 0 in 342.6 seconds.
- Isolated root tests: exit 0 in 1,015.5 seconds. Across 39 workspace test
  runs, 3,267 tests passed, 29 intentional/capability skips remained, and
  3,296 tests were enumerated.
- Isolated root build: exit 0 in 355.5 seconds.
- Definitive literal `npm run check`: started
  2026-08-11 20:39:41.968 BST, ended 21:06:52.660 BST, exit 0 in
  1,630.692 seconds. Durable output:
  `C:\Users\mrali\AppData\Local\Temp\stage19b-root-check-output.log`;
  result:
  `C:\Users\mrali\AppData\Local\Temp\stage19b-root-check-result.json`.
- Definitive literal `npm run test:coverage`: started
  2026-08-11 21:08:49.387 BST, ended 21:23:50.844 BST, exit 0 in 901.457
  seconds. Durable output:
  `C:\Users\mrali\AppData\Local\Temp\stage19b-root-coverage-output.log`;
  result:
  `C:\Users\mrali\AppData\Local\Temp\stage19b-root-coverage-result.json`.
- All 39 package-local coverage directories exist and are Git-ignored.
  Aggregate exact coverage is statements 26,716/28,676 (93.16%), branches
  18,638/21,459 (86.85%), functions 5,190/5,320 (97.55%), and lines
  24,226/25,555 (94.79%). The repository 90/80/90/90 floors and every
  package threshold remain intact.

Two combined-check attempts remain explicitly inconclusive and are not counted
as passes: the inherited handoff attempt hit its 1,803.3-second external cap
while the thinker prerequisite chain remained active; a later foreground
attempt lost its completion channel when the code-mode host generation expired.
No matching repository process survived either observation. The durable
literal pass above is the only claimed final combined-check result.

## Mutation, restoration, and real-Git discrimination

Fourteen load-bearing mutants were killed:

1. production refusal;
2. exact request/evaluation-admission authorization;
3. Stage 19A head/tree evidence binding;
4. receipt allowed-path binding;
5. target-tree/repository identity;
6. lease/fencing;
7. durable effect-start persistence;
8. ambiguous-execute duplicate handling;
9. private Git guard revocation/CAS;
10. SQLite reopen duplicate lookup;
11. recovery exhaustion/manual reconciliation;
12. migration checksum history;
13. layered error redaction; and
14. unsafe Git configuration argument refusal.

Six deliberately isolated single-layer mutants survived because a separate
independent control still rejected the same substitution. They are not called
kills. Each corresponding combined/load-bearing mutant was then killed.

Exact restored SHA-256 values:

- integrator store:
  `bae9f9c0998b0013f2c7c80ca2e271ad792e2865c93e3ee65f615b77d2a646be`;
- integrator state:
  `ce88380203e8c16ee24ceb691bb53ce49a1530f93cf52c2b83520ec3e01e598a`;
- integrator schema:
  `21c4d83cdedfdc7d14380816ffea59a9d4704195d297637704a48d79a7635841`;
- real Git port:
  `3c85912dc2d9a863ff3363a8b919222d7502d2c661ffec87bcc3f667bb5dcd5a`;
- evaluation:
  `f8880baaa5578dac69f15f0c1deea5fd18c7999d87c9ce8d21896914eade9c24`;
- PostgreSQL migrations:
  `0501e388456138f91138adcbdf874b4c2ebf9d7c032ac59ef1eadb7bc3c860bc`;
- workspace Git environment:
  `ae55efa7ed58256244eb8f8c6928fb3fcf5a07c31b1d95205f62b69054cb2b95`.

The mutation-marker scan is empty. Post-restoration checks passed: integrator
source/state/store/adversarial 5 files/40 tests, Stage 19A evidence 1/1,
PostgreSQL static policy 3/3, and workspace unsafe-argument 1/1.

The selected real disposable-Git crash/recovery/concurrency matrix passed 4/4
at shuffle seeds `190119` (86.66 seconds), `190120` (90.28 seconds), and
`190121` (94.67 seconds). The actual AI Development OS repository HEAD,
refs, status, and linked-worktree inventory stayed exact. On the final
repetition the index SHA-256 was byte-identical before and after:
`e25093c0a16a6e2124ff976e436ef6c76905377f449873059fb62ec27251fa94`.

## Dependency, package, and consumer evidence

- `npm ls --all --json`: exit 0, 43 top-level records, zero problems.
- Repository `npm audit --json`: exit 0; 0
  info/low/moderate/high/critical vulnerabilities across 191 production, 22
  development, 54 optional, and 246 total records.
- `npm audit --audit-level=high`: exit 0, `found 0 vulnerabilities`.
- The reviewed runtime closure has 24 packages: 10 internal workspaces and 14
  external PostgreSQL-chain packages. The external chain is 12 MIT and 2 ISC
  records. No closure package declares preinstall/install/postinstall.

Final dry packs bundle no dependency:

| Package | Entries | Packed | Unpacked | SHA-1 shasum |
| --- | ---: | ---: | ---: | --- |
| `@ai-dev-os/integrator` | 34 | 79,973 | 473,575 | `c8801e117dbdc84f48f62dcdf418fac8d1a379eb` |
| `@ai-dev-os/persistence` | 46 | 38,093 | 184,213 | `dd274338b477e42c7eb376762c1373602a759884` |
| `@ai-dev-os/persistence-postgres` | 22 | 25,920 | 120,376 | `6bc84fdab385bdc7d6eb90e7a03911ca45217f0a` |
| `@ai-dev-os/workspace` | 62 | 72,627 | 325,305 | `79ca4a262fd5ed0ab69a3af9ccb0bb9f30416e45` |

A fresh external consumer at
`C:\Users\mrali\AppData\Local\Temp\ai-dev-os-stage19b-consumer-20260811-213000`
installed exact tarballs for all 10 internal runtime-closure workspaces with
lifecycle scripts disabled. With exact TypeScript 7.0.2 and Node type
declarations, it:

- imported integrator, persistence, PostgreSQL, and workspace public roots;
- passed strict public type compilation;
- proved `INTEGRATION_PRODUCTION_ENABLED === false`;
- invoked the production service and received finite
  `PRODUCTION_DISABLED` before any persistence/Git/validation boundary;
- proved the real Git/testing constructor is absent from the root and present
  only on `@ai-dev-os/integrator/testing`;
- passed `npm ls --all`; and
- reported zero vulnerabilities across 24 production, 23 development, 21
  optional, and 47 total records.

Two setup attempts are not counted as passes. The first install command used
PowerShell's reserved `$args` variable and reached only npm help; the corrected
argument variable installed the tarballs. The first typecheck omitted
TypeScript 7's explicit Node ambient `types` entry; the corrected
`types: ["node"]` configuration passed.

## Static and scope scans

- Final candidate: exactly 39 paths, 17 tracked and 22 untracked.
- `git diff --check`: exit 0; only informational checkout line-ending
  notices were emitted.
- Zero private-key header, GitHub/Slack/GitLab token, OpenAI key, AWS access
  key, or credential-bearing URL pattern matches.
- Zero merge-conflict marker or mutation-marker matches.
- Zero candidate binary, library, source-map, database, archive, or image
  extensions.
- The sole changed lockfile is the expected root `package-lock.json`.
- Environment references are limited to the reviewed workspace host/Windows
  runtime inputs plus bounded live-capability and native-driver refusal tests;
  no credential/session value is present.
- No threshold, skip, exclusion, audit rule, production refusal, or package
  boundary was weakened. The PostgreSQL lifecycle build prerequisite and its
  static assertion changed together to cover the integrator import.
- Coverage generated no Git-visible files.

## Independent review

The final independent review used GPT-5.6 Sol at Max effort, read-only, through
the existing collaboration boundary. This is a same-family limitation; no
opposite-family reviewer was available in the authorized environment. Its
separate verdicts are **source correctness: PASS** and **precommit
completion/publication readiness: PASS**. No remaining source, test, contract,
package-boundary, or evidence discrepancy was confirmed. The verdict
authorizes only staged-blob binding, the focused non-forced source publication,
and hosted verification; it does not claim Stage 19B complete or permit
`INT-01` promotion before exact-head CI. Reviewer usage/cost is unavailable.

## Stage 18 decision

`INT-01` remains `incomplete` in the current matrix. Local evidence now
proves durable intent/effect-start, exact idempotency, no-repeat crash recovery,
finite receipt/reconciliation states, stale fencing, real disposable Git
effects, SQLite reopen, and the hosted-PostgreSQL test implementation. The row
cannot become `proven` until the exact source-head hosted dependency audit,
PostgreSQL integration, Ubuntu check, coverage, and Windows check pass, followed
by final evidence reconciliation. No promotion is made from source inspection
or local evidence alone.

`ANT-02` remains incomplete because no owned credential/reference was
available and no live Anthropic canary ran. `AM-02` remains incomplete because
no already supported non-interactive authorized Account Manager source was
available. `PRD-01` remains gated on Stage 17W.

## Safety, effects, and residues

- No Stage 17 installation, elevation, UAC automation, generated-native
  execution, lifecycle, egress canary, removal, restricted corpus/procedure,
  or security-control bypass occurred.
- No credential discovery, provider response body, account/session data,
  prompt/source payload, or hidden reasoning was recorded.
- No real AI Development OS target ref, index, or linked-worktree mutation,
  product integration push, `main` mutation, remote publication, UI/comms
  work, or Linux/macOS product integration occurred.
- Ordinary build/test subprocesses, ignored coverage output, SQLite file
  fixtures, task-owned disposable Git repositories/worktrees, and packaging
  tarballs were used.
- A prior read-only reviewer diagnostic accidentally invoked
  `npm exec -- node`; npm attempted package resolution and timed out. It made
  no Git/source or live provider/account change and was not retried.
- One killed SQLite duplicate-lookup mutant stopped fixture cleanup and left
  `C:\Users\mrali\AppData\Local\Temp\ai-dev-os-integrator-sqlite-HvAspQ`.
  Its exact validated removal was blocked before execution and was not retried
  or rerouted.
- The exact validated cleanup of the new packed consumer was likewise blocked
  before execution. The consumer path above remains preserved and no alternate
  deletion route was attempted.
- All pre-existing disclosed residues and ignored coverage directories remain
  preserved.

## Publication boundary and next action

The highest-value next action is to create and non-forcibly push the focused
source checkpoint, then require exact-head hosted dependency-audit,
PostgreSQL, Ubuntu, coverage, and Windows success. Only after that proof may
`INT-01` be promoted and the evidence/matrix finalization commit be published
and reconciled at its own exact hosted-green head.
