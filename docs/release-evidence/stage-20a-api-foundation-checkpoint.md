# Stage 20A API foundation checkpoint

- Work began: 2026-08-25 (BST).
- Local assurance finalized: 2026-08-26 (BST).
- Branch: `feat/stage-20a-api-contract-foundation`.
- Scope: C0-C2 only; production disabled.

## Outcome and evidence boundary

C0 entry verification, C1 architecture ratification, and the C2 pure,
route-free `@ai-dev-os/api` contract package are implemented. The source
candidate immediately before this evidence file is commit
`c81a48903b8814c2575afb518eb8c1bc4882689d`, tree
`e485d65fd3e730f71bcaae9a1a359e85946b1457`.

This document does not preclaim facts that can exist only after its own bytes
are committed. Its final evidence commit necessarily assigns a new HEAD and
tree; the fresh independent review, non-force push, exact-head hosted CI, and
local/upstream/live-remote reconciliation necessarily occur after that commit.
Those immutable closure fields must be bound in the final operator handoff.
Writing their future values here would be false and changing this file after
they occur would create another unreviewed, unverified head. This is the same
self-reference boundary used by prior repository release-evidence packets.

Publication is therefore permitted only if the final handoff supplies all of
the following for the exact evidence commit:

1. final HEAD and tree;
2. a fresh read-only independent-review PASS with zero unresolved must-fix
   findings;
3. a successful hosted CI run and attempt bound to that exact HEAD;
4. equality of local HEAD, upstream, remote-tracking ref, and live remote; and
5. an empty final worktree and index.

## Starting identity and sealed entry

| Item | Exact value |
| --- | --- |
| Starting branch | `feat/stage-20a-api-contract-foundation` |
| Starting HEAD | `f8ab3c506a3c924d9ec315bc853b650d99bceff0` |
| Starting tree | `02d44f33caddbaf89c93e768cbc4f772faa9e297` |
| Sealed repository | `C:\Users\mrali\Projects\ai-dev-os-18e` |
| Sealed branch | `feat/stage-18-development-acceptance-closure` |
| Sealed hosted CI | run `32846367459`, attempt 1, seven of seven jobs successful |
| Acceptance matrix | 24,147 bytes; SHA-256 `db7dbb47e6a90f85ca90798a28953b029a6da6a1c9fb170980158467d812b30f` |

The sealed repository was clean, and its HEAD, configured upstream,
remote-tracking ref, and live remote matched exactly. The matrix was derived
independently: `ANT-02=proven`, `AM-02=proven`, `INT-01=proven`, the set of
unproven development blockers was empty, `developmentAccepted=true`, and
`stage20AEligible=true`. `PLN-02=incomplete` is not a development-construction
blocker. `productionAdmitted=false` remains binding.

The supplied parent reviews were read completely and hashed before Stage 20
editing:

| Review | Size | SHA-256 | Exact-parent verdict |
| --- | ---: | --- | --- |
| Fable | 11,331 bytes | `23a7c89a802dae46c952097a4263b1a638aacfdd019155868f6af8ee0c5f5b4f` | PASS; zero must-fix |
| Opus | 19,285 bytes | `fb843574985152b5ef06e5f572272acea44195258730306955cb219f15255fc7` | PASS; zero must-fix |

Those verdicts apply only to the sealed parent. They do not transfer to any
Stage 20 byte. Their observations are preserved in
[the carried-advisory register](stage-20-carried-advisories.md).

Focused synthetic tests reconfirmed that production refuses before spawn in
both the Codex provider boundary and process broker, while their separate
development positive controls created only task-owned markers. No real
provider, credential, repository task, or production backend was involved.

## Operator decision, tools, and architecture

The separate operator prompt was 17,912 bytes with SHA-256
`062240f0cfc456f5da6cc254b4e5cdd995710ed00f765e99c7734269ed34267b`.
It authorized C0-C2 and accepted RD-01, RD-02, RD-03, RD-04, RD-06, RD-07,
RD-09, RD-10, RD-11, RD-13, RD-14, RD-15, RD-16, RD-17, RD-19, RD-20,
RD-21, RD-22, and RD-23.

It also fixed the following decisions:

- the product is AI Development OS and its coordinator persona is AI
  Powerhouse;
- Windows is the only current product platform;
- Stage 20 is subdivided into read-only Stage 20A and later authoritative
  Stage 20B;
- the later control plane is a desktop-owned local child process, not a
  Windows Service, scheduled task, or machine daemon;
- the later listener is loopback-only; Fastify is deferred to C4 and remains
  subject to the ordinary audit gate;
- Normal and Developer modes have identical authority;
- external/manual VS Code observation, Linux/macOS integration, UI automation
  as agent integration, purchases, production dispatch, and transcript-as-
  system-of-record designs are excluded; and
- emergency-stop resume, the bounded Job Object spike, and licence review are
  recorded for their later authorized stages, not implemented here.

Only version and command-resolution probes were used. `codex --version`
reported `codex-cli 0.149.0-alpha.4.1`. `claude` and `claude-code` were not
available on `PATH`, so no version was observed. No session or account query was
started.

The dossiers' logical ADR-0036 maps to accepted repository ADR 0038 because
repository ADRs 0036 and 0037 were already occupied by Stage 18. The remaining
logical labels ADR-0037 through ADR-0047 map prospectively to repository ADRs
0039 through 0049, respectively. Those prospective numbers are not reserved
and must be rechecked when each decision lands.

[ADR 0038](../adr/0038-stage-20-subdivision-and-local-control-plane.md)
ratifies the Stage 20A/20B boundary, local child-process hosting, future
loopback-only listener, C2/C3/C4/C5 sequencing, production refusal, Windows-only
scope, unchanged Stage 18 secret/provider boundaries, and the Stage 21 frozen-
client boundary.

## C2 package architecture

`@ai-dev-os/api` is private, deterministic, framework-independent, and
production-disabled. Its only package dependency is repository-owned
`@ai-dev-os/domain`; the source also uses only the pure Node proxy-introspection
utility. It has no Fastify dependency.

The package provides:

- exact, schema-versioned success, refusal, and projection envelopes;
- bounded monotonic sequences, caller-supplied `serverNow`, `computedAt`, and
  current/stale confidence with finite stale reasons;
- all 70 reconciled refusal codes with exact runtime parsing, discriminated
  detail shapes, bounded parameters, product-owned display copy, and bounded
  unknown-code projection;
- an allowlist projection-schema DSL and canonical stable serialization;
- recursive bounds for strings, identifiers, integers, basis points, arrays,
  object depth, and total nodes; and
- explicit presentation authority plus route and command registries.

The route and command registries are frozen `readonly never[]` empty arrays.
Their exported counts are both the literal `0`, and production is the literal
`false`. Tests enumerate them and prove Normal/Developer parity. Static source
tests reject HTTP verbs, commands, `usage.refresh`, dispatch, listeners,
workspace or Git mutation, secret resolution, native bindings, persistence,
and process launch. C2 contains no server, socket, route handler, or listener.

The allowlist serializer rejects unknown or missing fields and does not spread
untrusted objects. It rejects abnormal prototypes, symbols, accessors without
invoking them, proxies, cycles, prototype-pollution keys, excess depth/nodes,
model-text schema kinds, credential field names and value shapes, absolute
paths, source fingerprints, borrowed-owner identity, and cross-profile data in
Normal projections. Error messages use bounded owned paths/codes and do not
echo attacker-controlled or credential-shaped unknown keys.

The static policy scans the complete production source of `@ai-dev-os/api` and
its transitive `@ai-dev-os/domain` closure. It permits only the reviewed pure
boundary and refuses provider, process-broker, workspace/Git, Windows secret,
Electron, native, network/listener, filesystem-persistence, and child-process
imports. A synthetic forbidden import is a positive control for the scanner.

## Exact changed-path inventory

The final base-to-evidence diff contains 25 paths:

```text
README.md
docs/adr/0038-stage-20-subdivision-and-local-control-plane.md
docs/implementation-roadmap.md
docs/product-direction.md
docs/release-evidence/stage-20-carried-advisories.md
docs/release-evidence/stage-20a-api-foundation-checkpoint.md
docs/release-evidence/stage-20a-entry-checkpoint.md
docs/technical-design.md
package-lock.json
packages/api/README.md
packages/api/package.json
packages/api/src/constants.ts
packages/api/src/envelopes.ts
packages/api/src/index.ts
packages/api/src/projection.ts
packages/api/src/refusals.ts
packages/api/src/routes.ts
packages/api/src/structural.ts
packages/api/test/envelopes.test.ts
packages/api/test/projection.test.ts
packages/api/test/refusals.test.ts
packages/api/test/routes.test.ts
packages/api/test/static-policy.test.ts
packages/api/tsconfig.json
packages/api/vitest.config.ts
```

The three pre-evidence commits were:

1. `82b6b3b` — `docs: ratify Stage 20A entry and architecture`;
2. `fcb127a` — `feat(api): add route-free Stage 20A contracts`; and
3. `c81a489` — `fix(api): harden projection and refusal contracts`.

## Local assurance

All final source gates below ran on source commit `c81a489...`, tree
`e485d65...`. Adding this Markdown evidence file changes no executable,
configuration, package, lockfile, test, threshold, or workflow byte.

### API package

| Gate | Result |
| --- | --- |
| Typecheck | exit 0 |
| Build | exit 0 |
| Tests | 5 files, 46/46 tests passed |
| Coverage | statements 312/324 (96.29%); branches 187/200 (93.5%); functions 45/45 (100%); lines 290/295 (98.3%) |
| Coverage floors | 90% statements, 80% branches, 98% functions, 90% lines; unchanged and satisfied |
| Refusal parity | acceptance pack 70; source 70; missing 0; extra 0 |
| Stable repetition | deterministic repeated serialization tests passed |

The load-bearing projection mutation removed the runtime safe-string check
from identifier-rule serialization. The focused projection suite then failed
because a credential-shaped identifier was admitted. The exact guard was
restored, the mutation marker was absent, and the complete final gates passed.

### Repository and maintained consumers

- Fresh literal `npm run check`: exit 0 after all 45 workspace typechecks,
  tests, and builds.
- Fresh literal `npm run test:coverage`: exit 0 after all 45 configured
  workspace coverage scripts. No existing skip, exclusion, threshold, or test
  was changed for this task.
- `npm run verify:packed-consumer`: PASS, 27/27 probes.
- `npm run verify:app-vault-packed-consumer`: PASS.
- `npm run verify:stage-18e-i-if-published`: PASS.
- Focused production-before-spawn provider-Codex and process-broker tests:
  PASS with their bounded development-marker positive controls.

The repository commands emit package-local totals rather than one trustworthy
cross-package test/coverage aggregate. This checkpoint records the exact API
totals and the literal root exits instead of inventing an aggregate.

### Dependency and packing closure

`npm ls --all --workspace @ai-dev-os/api` resolved exactly one dependency:
`@ai-dev-os/domain@0.1.0`, with no problem. `npm audit
--audit-level=high` exited 0 and reported `found 0 vulnerabilities`.

The final dry pack contains 30 entries, is 24,670 bytes packed and 124,947
bytes unpacked, and has SHA-1 shasum
`7e4f91633c9a699e65b94f694d24807a4b3eb174` and integrity
`sha512-NATefRTYmw6CuZm/jfDhITc02v9PoU1s6bwJgpu2RwJ/5qsEx8El34jhI2z7FX0bDHP5mrBpOaQKhiiw8NBrHA==`.
It contains only the package README, package metadata, and built JavaScript,
source maps, and declarations.

### Static hygiene

- `git diff --check f8ab3c5..c81a489`: exit 0.
- All three changed JSON files parsed successfully.
- All eight changed pre-evidence Markdown files passed the local-link check;
  zero missing targets.
- The 24 changed pre-evidence paths had zero private-key, Anthropic/OpenAI,
  GitHub, Slack, AWS, or credential-bearing-URL shape matches.
- The same 24 paths had zero merge-conflict or mutation-marker matches.
- Coverage and builds left the Git worktree clean.

The evidence file itself must pass the same diff, Markdown/local-link,
secret-shape, marker, and clean-index checks before its commit.

## Independent review and hosted publication

No review verdict or hosted result is claimed in advance. The final evidence
commit must be frozen and then submitted to one fresh independent read-only
review covering entry derivation, ADR and operator decisions, envelope/refusal
strictness, projection/leakage resistance, import isolation, zero-route and
zero-command guarantees, tests, and evidence truthfulness. Every must-fix must
be resolved on a new candidate and re-reviewed.

After review PASS, the feature branch may be non-force-pushed. Hosted CI must
complete successfully at that exact evidence HEAD. A rerun is permitted only
for a clearly established hosted-runner/infrastructure flake and without a head
change. The final handoff must report the actual run, attempt, jobs, review
verdict/advisories, remote equality, and cleanliness.

## Explicit nonclaims and next checkpoint

This checkpoint did not validate or contact Anthropic or any provider, access
the credential vault or Account Manager, start an agent or task, start a local
API listener, create a route or command, enable production, perform a purchase,
mutate `main`, create a PR, merge, tag, release, publish a package, or implement
Linux/macOS integration.

C3, C4, C5, Stage 20B, the project spine, and Stage 21 are not started. The
smallest next checkpoint after exact-head closure is **C3-C5** under its own
authorization: descriptor/single-instance/lifecycle contracts, then the first
loopback listener with independent security review, then the first UI-facing
projections with independent leakage review.
