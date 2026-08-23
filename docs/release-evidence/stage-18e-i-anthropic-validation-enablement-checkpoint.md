# Stage 18E-I Anthropic validation-enablement checkpoint

Date: 2026-08-23

Status: `READY_FOR_PUBLICATION`

## Scope and starting identity

This checkpoint prepares a production-disabled, candidate-bound capability for
one later operator-authorized Anthropic validation attempt. It does not
authorize or perform that attempt.

Before any mutation, the repository was verified on branch
`fix/stage-18e-h-visible-startup-deadline` at commit
`8fc438910c55988f33479136f67acc4bcf74a5de`, tree
`713cffa6cd1e988c4525b10fce34e115a478f14b`, and Stage 18E-H manifest
aggregate
`21776a86d9fb1eb8cfae4d7bf812b83ac577119f0c8119a6d6acc4024db49b8c`.
Exact-head GitHub Actions run `32643420290`, attempt 2, was successful. The
operation handover was independently checked as 6,073 bytes with SHA-256
`f00c31d74a26443d900f135736523e61cb499247c78de301bbf3a8ee27c8db98`.
The feature branch is `feat/stage-18e-anthropic-validation-enablement`.

The operator-supplied fact that one enabled, unvalidated owned Anthropic
credential exists in the reviewed application-vault slot was accepted without
opening any vault file or resolving its `SecretRef`. No clipboard or Account
Manager state was inspected.

## Architecture and exact future effect

ADR 0035 records the decision. The previously reviewed fixed canary and
diagnostic classifier now live under the stable
`@ai-dev-os/provider-anthropic/validation` production-disabled subpath. The old
testing paths are thin re-exports of the same implementation, so there is one
request profile and one validator rather than mutually reinforcing copies. The
normal provider entry remains refusal-only and no Anthropic SDK was added.

The only future effect prepared by this candidate is:

- method and endpoint: `POST https://api.anthropic.com/v1/messages`;
- API header: `anthropic-version: 2023-06-01`;
- model: `claude-haiku-4-5-20251001`;
- canonical UTF-8 body:
  `{"model":"claude-haiku-4-5-20251001","max_tokens":4,"messages":[{"role":"user","content":"Reply with exactly OK."}]}`;
- body length: 116 bytes;
- body SHA-256:
  `0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a`;
- maximum output: four tokens;
- maximum response: 65,536 bytes;
- effect timeout: 15 seconds;
- entered-callback/broker drain: five seconds;
- transport: `direct-anthropic-https`;
- retention: standard commercial API retention, represented by the existing
  provider-envelope value `standard-30-day`.

The body contains only a fixed synthetic phrase and no user, project,
repository, task, or business data. There is no endpoint discovery, API-version
discovery, model discovery, redirect following, proxy fallback, alternate
transport, retry, SDK retry, fallback model, or hidden second dispatch.

## Candidate binding and one-shot authorization

The source/evidence commit will be followed by one manifest-only child. The
non-self-referential manifest generator, verifier, conditional CI verifier, and
build-time candidate-binding writer all pin their reconstruction base directly
to `8fc438910c55988f33479136f67acc4bcf74a5de`; none accepts the manifest's base
field as reconstruction authority. Before publication the build writer emits
no binding. At the exact manifest-only child, it can emit only the independently
reconstructed published HEAD/tree, source commit/tree, manifest SHA-256, and
subject aggregate.

Runtime authority is a canonical, bounded packet at the fixed application-data
relative path
`credential-setup/anthropic-validation/authorization/anthropic-validation.v1.json`.
It binds schema and operation version; exact published candidate identities;
Anthropic slot; provider instance `anthropic-default`; the fixed application-
vault `SecretRef` fingerprint; endpoint, API version, model, request digest and
bounds; standard retention; finite result vocabulary; a bounded external
authorization reference; a new marker namespace; issuance and expiry no more
than 24 hours apart; one attempt; and no retry. Oversize, noncanonical,
duplicate-key, accessor, proxy, prototype-polluted, symlinked, expired,
candidate-substituted, or otherwise malformed input fails closed.

Confirming prepares the attempt by exclusively creating a canonical nonsecret
marker with `wx` semantics before the resolver can receive a `SecretRef`. An
existing marker of any shape means consumed. Failure before exclusive creation
is a no-dispatch precondition failure and does not falsely claim a marker was
created. Once a file handle is returned, any later write, sync, or close
uncertainty is ambiguous and remains consumed; restart cannot restore
eligibility. An in-memory single-use guard, the host operation reservation,
renderer submission latch, and atomic marker provide additional duplicate-
activation barriers.

Cancel sends no validation IPC, performs no network effect, and consumes
nothing. Cancellation after consumption, UI close, deadline, restart, repeated
IPC, double click, Enter repetition, refresh, reopen, and a second process cannot
create a second dispatch. The absolute host deadline and abort controller begin
before the first authoritative credential read and remain authoritative through
result persistence. A close or deadline that wins before an atomic metadata
commit blocks a definitive result; only already-downgraded inconclusive facts
may be recorded after deadline, while close blocks every late commit.

## Secret, transport, result, and UI boundaries

The future secret path remains the existing application-vault `SecretRef`, the
existing policy-aware resolver, callback-scoped `SecretMaterial`, and one
bounded `useText` call directly around authorization-header construction and
HTTPS submission. Plaintext is not placed in renderer or IPC state,
configuration, environment, command line, errors, prose, diagnostics,
analytics, metadata, evidence, temporary files, screenshots, or Git. The
launcher scrubs exact `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` names plus
case-insensitive `ELECTRON_`, `NODE_`, `DOTNET_`, `COMPLUS_`, and `CORECLR_`
control namespaces without reading or reporting their values.

Only a present and enabled Anthropic slot with an exact currently available
authorization shows **Validate connection**. All other providers and invalid,
expired, consumed, unavailable, or unreadable authorization states show no
validation action. Normal and Developer modes derive from identical authority;
Developer mode adds only bounded identifiers and fingerprints.

The confirmation discloses one Anthropic request, the exact model and fixed
phrase, four-token maximum, standard retention, no retry, non-display of the
credential, Cancel/no-consumption behavior, immediate Confirm consumption, and
15-second effect plus five-second cleanup bounds. In-flight state disables
credential mutations and repeated activation. Finite result copy distinguishes
valid, invalid authentication, limited authorization, ambiguous, unreachable,
deadline-before-dispatch, and neutral pre-dispatch termination without
inventing a provider response or deadline.

Promotion is independent of the producer. `valid` requires schema 1; every
pinned endpoint/version/model/request/retention field; `success`;
`direct-anthropic-https`; bounded duration and usage; exact policy fingerprint;
and all fixed-body, no-repository-source, no-credential-retention, no-response-
retention, and model-substitution-rejected facts. Deterministic fake, `direct`,
`injected`, unknown transport, malformed or duplicate-key response, substituted
model, late result, timeout, close, and every non-success envelope cannot
promote `ANT-02`. Inconclusive outcomes preserve earlier definitive knowledge.

## Validation snapshot

- Focused final truthfulness checks: credential-host `host-service` 58/58 and
  credential-UI browser contract 19/19; both relevant TypeScript checks passed.
- Full affected ordinary suites: credential host 20 files and 257 tests plus
  launcher regressions 6/6; Anthropic provider 8 files and 216 tests;
  credential UI 2 files and 29 tests.
- Fresh root `npm run test:coverage` passed with exit 0 after the final source
  review, including every workspace suite. Affected package floors passed:
  credential host 91.15% statements, 87.22% branches, 100% functions,
  and 95.78% lines; Anthropic provider 91.82%, 87.25%, 97.66%, and 95.06%;
  credential UI 100%, 98.64%, 100%, and 100%, respectively. One initial host
  coverage attempt truthfully failed its 100% function floor because two new
  no-op handlers were not invoked; the implementation was narrowed and the
  fresh rerun passed.
- Real Electron `43.4.1` smoke using only canonical synthetic authorization and
  disposable appData passed 71 default assertions, 2 reduced-motion assertions,
  and 4 forced-colours assertions. It covered Cancel, exactly one fake dispatch,
  double confirmation, consumption, preconsumption refusal, postcommit locking,
  normal/developer parity, focus, and bounded diagnostic leakage.
- Packed-host verification passed with a clean packed install and high-severity
  audit, 10 packages, 84 application files, a visible renderer, four provider
  cards, zero validation buttons without authorization, production disabled,
  and exactly seven preload bridge methods.
- `npm audit --audit-level=high` reported zero vulnerabilities. `npm ls --all`
  exited 0 with only expected unmet optional platform dependencies.
- An independent PowerShell/.NET SHA-256 computation reproduced the exact
  116-byte request body and
  `0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a`.
- The conditional subject-manifest verifier passed in the unpublished state and
  emitted no candidate binding. Manifest inverse tests include wrong-base,
  parent drift, malformed inventory, dirty-worktree publication, and independent
  fixed-base assertions.
- Fresh root `npm run check` passed with exit 0 after the final source review,
  including every workspace typecheck, test, and build. The build confirmed
  `status: unpublished` and wrote no candidate binding.
- Final static-policy tests passed 14/14 for the credential host and 3/3 for
  the Anthropic provider. A non-copying scan of all 49 changed source/evidence
  paths found no credential-shaped token, private key, or ambient credential
  environment read. It also confirmed no authorization packet, marker root,
  unpublished candidate binding, or subject manifest had been created in the
  repository and that the Stage 18 acceptance matrix was unchanged.
- Canonical manifest generation, independent Git-blob recomputation, clean
  published build binding, non-force push, and exact-head CI necessarily follow
  this source/evidence commit and are not claimed complete in this record.

## Independent review

An independent GPT-5.6 Sol Max read-only source/security review returned PASS
with no remaining must-fix findings. Earlier review rounds found and drove fixes
for pre-marker failure truth, EEXIST and marker-close uncertainty, external
cancellation after nominal callback success, finite Electron-smoke diagnostics,
close/deadline persistence races, duplicate JSON keys, close during the first
authoritative read, manifest-base self-trust, and pre-dispatch UI/activity
truthfulness. All must-fix findings were addressed and affected checks rerun.

The final reviewer independently confirmed exact candidate binding, atomic
pre-resolution one-shot consumption, bounded direct Anthropic HTTPS, strict
success promotion, late/closed-result refusal, finite diagnostics, truthful UI
states, authorization-absent disablement, and no production task or inference
reachability. Its remaining advisories are non-blocking follow-up hardening:

- match the JSON media type more narrowly so `application/jsonp` is not treated
  as JSON;
- assert every fixed callback broker context field in the adapter;
- consider parent-directory durability syncing, stronger marker-directory
  TOCTOU protection, and a separate bound for pre-dispatch filesystem work;
- prefer the phrase “one request attempt” where the dispatch observation occurs
  immediately before `req.end` and provider receipt is not knowable.

The reviewer accessed no secret, vault, clipboard, Account Manager state,
environment-variable value, real marker, or provider/network endpoint.

## Safety, nonactions, and project truth

No task action opened, parsed, hashed, copied, decrypted, exported, rotated,
replaced, or removed the real vault or stored credential. No clipboard contents
or Account Manager private state were inspected. No real authorization packet
or marker was created. No Anthropic or other provider request was made. No
production task execution, general inference, PR, merge, rebase, force-push,
tag, release, repository-setting change, production activation, Stage 20, or
Stage 21 action occurred.

Project truth remains unchanged:

- `AM-02`: proven;
- `INT-01`: proven;
- `ANT-02`: incomplete and still the sole development-acceptance blocker;
- `PLN-02`: incomplete and production-gated;
- `developmentAccepted=false`;
- `productionAdmitted=false`;
- Stage 20A remains ineligible.

## Source/evidence changed-path inventory

The source/evidence candidate contains these 49 paths relative to the reviewed
base; the canonical subject manifest is intentionally absent until these blobs
are committed:

1. `.github/workflows/ci.yml`
2. `README.md`
3. `apps/credential-setup/README.md`
4. `apps/credential-setup/package.json`
5. `apps/credential-setup/scripts/launch-production-host.mjs`
6. `apps/credential-setup/scripts/launch-production-host.regression.mjs`
7. `apps/credential-setup/scripts/packed-runtime-wrapper.cjs`
8. `apps/credential-setup/scripts/real-electron-smoke.mjs`
9. `apps/credential-setup/scripts/verify-packed-host.mjs`
10. `apps/credential-setup/scripts/write-stage-18e-i-candidate-binding.mjs`
11. `apps/credential-setup/src/main/anthropic-validation-authorization.ts`
12. `apps/credential-setup/src/main/anthropic-validation.ts`
13. `apps/credential-setup/src/main/host-service.ts`
14. `apps/credential-setup/src/main/metadata-store.ts`
15. `apps/credential-setup/src/main/production-composition.ts`
16. `apps/credential-setup/src/main/validation.ts`
17. `apps/credential-setup/src/testing/electron-smoke-main.ts`
18. `apps/credential-setup/test/anthropic-validation-authorization.test.ts`
19. `apps/credential-setup/test/anthropic-validation.test.ts`
20. `apps/credential-setup/test/host-service.test.ts`
21. `apps/credential-setup/test/metadata-store.test.ts`
22. `apps/credential-setup/test/production-composition.test.ts`
23. `apps/credential-setup/test/stage-18e-i-subject-manifest.test.ts`
24. `apps/credential-setup/test/static-policy.test.ts`
25. `docs/adr/0035-stage-18e-i-anthropic-validation-enablement.md`
26. `docs/implementation-roadmap.md`
27. `docs/release-evidence/stage-18e-i-anthropic-validation-enablement-checkpoint.md`
28. `package-lock.json`
29. `package.json`
30. `packages/credential-ui/src/browser/entry.ts`
31. `packages/credential-ui/src/contracts.ts`
32. `packages/credential-ui/src/errors.ts`
33. `packages/credential-ui/src/index.ts`
34. `packages/credential-ui/src/projections.ts`
35. `packages/credential-ui/test/browser-contract.test.ts`
36. `packages/credential-ui/test/projections.test.ts`
37. `packages/provider-anthropic/README.md`
38. `packages/provider-anthropic/package.json`
39. `packages/provider-anthropic/src/testing/live-canary-diagnostics.ts`
40. `packages/provider-anthropic/src/testing/live-canary.ts`
41. `packages/provider-anthropic/src/validation/index.ts`
42. `packages/provider-anthropic/src/validation/live-canary-diagnostics.ts`
43. `packages/provider-anthropic/src/validation/live-canary.ts`
44. `packages/provider-anthropic/test/anthropic-live-canary.test.ts`
45. `packages/provider-anthropic/test/static-policy.test.ts`
46. `scripts/generate-stage-18e-i-subject-manifest.mjs`
47. `scripts/stage-18e-i-subject-manifest-lib.mjs`
48. `scripts/verify-stage-18e-i-if-published.mjs`
49. `scripts/verify-stage-18e-i-subject-manifest.mjs`

Publication requires a clean source/evidence commit followed by one manifest-
only child, canonical and independent verification, a clean build that emits
the exact published binding, non-force push, and green exact-head CI. Until
those steps complete, this record is truthfully `READY_FOR_PUBLICATION`, not a
completed or live-validated checkpoint.
