# Stage 20A API foundation checkpoint

- Work began: 2026-08-25 (BST).
- Local assurance finalized: 2026-08-26 (BST).
- Branch: `feat/stage-20a-api-contract-foundation`.
- Scope: C0-C2 only; production disabled.

## Outcome and evidence boundary

C0 entry verification, C1 architecture ratification, and the C2 pure,
route-free `@ai-dev-os/api` contract package are implemented. The repaired
source candidate immediately before this evidence update is commit
`e88a4038bee02367cbcec0cfc06ac61c9732e786`, tree
`e356a19ef1b097fa82f80029aeb9c7a7e6c9b8ad`.

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
| Acceptance matrix checkout | CRLF rendition; 24,147 bytes; SHA-256 `db7dbb47e6a90f85ca90798a28953b029a6da6a1c9fb170980158467d812b30f` |
| Acceptance matrix Git blob | SHA-1 `09ca763d6b8c13a5d5c458dc92e7305965611285`; 23,927 bytes |

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

The seven commits before this final evidence update were:

1. `82b6b3b` — `docs: ratify Stage 20A entry and architecture`;
2. `fcb127a` — `feat(api): add route-free Stage 20A contracts`;
3. `c81a489` — `fix(api): harden projection and refusal contracts`;
4. `77ba379` — `docs: record Stage 20A API foundation evidence`;
5. `2b32048` — `fix(api): close Stage 20A review findings`;
6. `5c9d9ec` — `docs: record Stage 20A review repairs`; and
7. `e88a403` — `fix(api): close final contract review gaps`.

## Local assurance

All final source gates below ran on repaired source commit `e88a403...`, tree
`e356a19...`. Updating this Markdown evidence file changes no executable,
configuration, package, lockfile, test, threshold, or workflow byte.

### API package

| Gate | Result |
| --- | --- |
| Typecheck | exit 0 |
| Build | exit 0 |
| Tests | 5 files, 48/48 tests passed |
| Coverage | statements 328/337 (97.32%); branches 202/212 (95.28%); functions 46/46 (100%); lines 305/308 (99.02%) |
| Coverage floors | 90% statements, 80% branches, 98% functions, 90% lines; unchanged and satisfied |
| Refusal parity | acceptance pack 70; source 70; missing 0; extra 0 |
| Stable repetition | deterministic repeated serialization tests passed |

Five load-bearing mutation controls were observed. Removing the runtime
safe-string check from identifier-rule serialization made the focused
projection suite fail because a credential-shaped identifier was admitted.
After the review repair, removing the Normal-mode mechanism-string guard made
the focused projection suite fail, and changing the test-owned `RATE_LIMITED`
next-step sentence to invented prose made the refusal parity suite fail.
Removing `refresh` from the credential-field matcher made the focused
projection suite fail, and removing block-comment trivia handling from the
static import policy made its focused suite fail. Every guard and exact mapping
was restored, no mutation marker remained, and the complete final gates passed.

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

The final dry pack contains 30 entries, is 25,635 bytes packed and 128,008
bytes unpacked, and has SHA-1 shasum
`58cd3fa54f73730bd05ef80fb95c8cf56fa3fd41` and integrity
`sha512-gKaTPjnYAsPUCS/WPwTwxCCulfwjN2qfmm89jc83z3wkWj1Yk+opJx/NkpZBb7OG4140uNc8gtDcvi/flAELXA==`.
It contains only the package README, package metadata, and built JavaScript,
source maps, and declarations.

### Static hygiene

- `git diff --check f8ab3c5 --` across the base-to-working-tree candidate:
  exit 0.
- All three changed JSON files parsed successfully.
- All nine changed Markdown files passed the local-link check; zero missing
  targets.
- The 25 changed paths had one expected synthetic private-key-header match at
  `packages/api/test/projection.test.ts:134`; it is the deliberate leakage
  canary, contains no key body or credential, and must be rejected at runtime.
  There were zero other private-key, Anthropic/OpenAI, GitHub, Slack, AWS,
  Google, JWT, or credential-bearing-URL shape matches.
- The same 25 paths had zero merge-conflict or mutation-marker matches.
- Coverage and builds left the Git worktree clean.

This final evidence update must pass the same diff, Markdown/local-link,
secret-shape, marker, and clean-index checks before its commit.

## Independent review and hosted publication

The first frozen evidence candidate was commit
`77ba3791b7456cc6f88b39339f8ea58738035b96`, tree
`d43d9734f6b8ac67a9f68b949f1936bf7c25b8fe`. A fresh independent read-only
GPT-5.6 Sol review at max reasoning returned FAIL with six must-fix findings.
That verdict applies only to that candidate. Source commit `2b32048...`
resolves all six as follows:

1. The governing ADR and product/entry records now preserve the
   mode-independent contextual direct-to-task contract, RD-10's fixed 30-second
   visible-application and 20-second service-ready startup deadlines and
   actions, RD-08's global
   `dispatch.pauseAll`, and the separate future C12 project-scoped stop model.
2. Normal-mode projection leakage checks now include the reconciled R2 secret
   shapes, mechanism fields and strings, opaque handles, hashes, basis points,
   rate-limit markers, owner identifiers, and generic fingerprints. Developer
   `sourceFingerprint` remains explicit and accepts only a lowercase 64-hex
   digest.
3. Timestamp ordering now compares parsed numeric instants, including extended
   years, instead of relying on lexical ISO ordering.
4. Projection node accounting includes the root, with exact 2,048-node
   acceptance and 2,049-node refusal tests.
5. The static import policy now rejects side-effect imports and scans the full
   textual production closure of API plus domain; both direct and synthetic
   transitive positive controls prove the guard.
6. Refusal parity now compares production output with a test-owned literal
   70-entry catalogue containing exact code, sentence, and `nextStepId`
   mappings, so production cannot define its own oracle.

The evidence update at commit
`5c9d9ecda3b53bb9395bc3dee74c21a730479d62`, tree
`d78c0efa990f022cf3c5587cfc9ebc8c19fc2c26`, was returned to the same
reviewer. Its exact-candidate re-review also returned FAIL, this time with
three must-fix findings. Source commit `e88a403...` and this evidence update
resolve them as follows:

1. Normal-mode credential-field rejection now covers refresh, session, ID,
   bearer, OAuth, CSRF/XSRF and API tokens; private, signing, encryption,
   client, access and authentication keys; cookies, session identifiers,
   recovery codes, OTP/TOTP fields, and passphrases. Focused tests enumerate
   the review probes while retaining `inputTokenCount` as permitted
   non-credential data.
2. The static import policy now consumes JavaScript line and block comments as
   trivia around static, side-effect, export-from, dynamic-import and `require`
   syntax. It rejects the exact `import/*comment*/"node:worker_threads";`
   bypass, comment-separated variants, and non-literal dynamic imports and
   requires, with focused positive controls.
3. This checkpoint now states the actual 30-second visible-application and
   20-second service-ready deadlines. It also records that an ignored local
   LCOV artifact was available to the reviewer and corroborated the metrics;
   LCOV is not present in the candidate tree or claimed as checkpoint evidence.

The reviewer retained one scope-timed advisory: six parameterized refusal-copy
shapes remain intentionally generic and should receive condition-specific UI
wording in C5 without changing their accepted C2 contract meanwhile. Two other
advisories were implemented here with focused tests: prototype-pollution keys
are explicitly refused, and the 256-character developer-path boundary is
accepted while 257 characters are refused. The remaining evidence-format
advisory is addressed by labelling the matrix SHA-256 as the CRLF checkout
rendition and recording its 23,927-byte Git SHA-1 blob identity above.

The ignored local LCOV artifact corroborates the reported coverage
configuration and metrics. It is not in the candidate tree, is not committed,
and is not part of this checkpoint's immutable evidence.

No exact repaired-candidate PASS or hosted result is claimed in advance. This
evidence update must be committed and then sent back to the same independent
reviewer for an exact-head read-only re-review covering the six dispositions,
entry derivation, ADR and operator decisions, envelope/refusal strictness,
projection/leakage resistance, import isolation, zero-route and zero-command
guarantees, tests, and evidence truthfulness. Every must-fix must be resolved
on a new candidate and re-reviewed.

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
