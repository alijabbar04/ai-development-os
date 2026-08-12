# Stage 18 live-boundary implementation checkpoint

Date: 2026-08-12 (BST)

## Outcome

This packet currently records a **production-disabled implementation candidate**,
not Stage 18 development acceptance.

- `INT-01` remains proven by the already published Stage 19B final head.
- `ANT-02` remains incomplete. The explicit bounded canary exists and its
  deterministic contract tests pass, but no supported owned scoped-secret
  reference was supplied and no live Anthropic request ran.
- `AM-02` remains incomplete. The supported reader and exact-pinned AI OS
  adapter exist and pass local cross-repository evidence, but no installed
  Account Manager store/profile was read and the Account Manager hosted job was
  prevented from starting by the account's Actions billing/spending limit.
- `developmentAccepted` and `productionAdmitted` remain `false`.
- Stage 17W remains gated. No generated native boundary candidate, installation,
  elevation, lifecycle proof, provider egress proof, or restricted operation
  ran in this queue.
- Stage 20A did not start because Stage 18 development acceptance is false.

Definitive AI Development OS local gates and independent exact-tree review pass.
The focused source commit/push, exact-head hosted CI, and final evidence
reconciliation remain pending at this precommit point and must not be inferred
from this packet.

## Starting identities and scope

AI Development OS:

- branch `feat/stage-18-live-integration-closure`;
- base/final published Stage 19B head
  `d7fe405745ccd5e1f31a3d702dc70d8095016604`;
- base tree `5fc1cec866795509571ed96726aca50cfd5b2110`;
- upstream intentionally absent before this checkpoint;
- production remains compiled disabled.

Account Manager:

- repository `https://github.com/alijabbar04/ai-account-manager`;
- branch `feat/stage-18-account-manager-reader`;
- source commit `5279113728a344a87a7e49c4222741a618b67dd5`;
- source tree `e8c342a77eaf01535db2bed2819e5ad87e1876df`;
- upstream and live remote branch equal the source commit after a non-forced
  push;
- reviewed candidate scope: nine Git-visible paths;
- 29-path source inventory SHA-256
  `df89d81c692f298b56ead07c4822a8efc87113919d5594ec0069df59d1161bf3`;
- normalized reader-source SHA-256
  `7626a6e24a10cf479983de7a1c7882ebf87a4ae45bf442c1b1f5a9d65ed04e40`;
- reader CLI blob SHA-256
  `5a3f32a4f184c326f07a8d3cbe3d7d894989319fa7b18c4aec7fde81b3935db7`.

The reviewed precommit candidate contains exactly 21 Git-visible paths: 16
tracked modifications and five new paths, including this evidence file. The 20
pre-evidence working-byte rows, ordered with .NET `StringComparer.Ordinal` and
encoded as `path<TAB>XY<TAB>size<TAB>sha256<LF>`, have SHA-256
`40a5621d2e3161ab89d7a8d215e8ff9c737f7c18ee8472733cc245f3fab55e7c`.
After explicit-path staging, the same 20 pre-evidence paths encoded from cached
Git blobs as `path<TAB>blob-sha256<LF>` have SHA-256
`dc23bdaebc683075677db686187e84efd83af26baecbb5828aa4b45822d8d2bf`.
The committed tree identity remains a future publication fact.

## Implemented boundaries

### Anthropic

`packages/provider-anthropic/src/testing/live-canary.ts` adds one test-only,
one-attempt canary. It fixes the endpoint, API version, model, harmless prompt,
token/byte/chunk/time bounds, policy/catalog/authorization/retention preflight,
scoped-secret access, response-model check, and finite redacted result/error
surface. Caller-controlled URLs, prompts, headers, redirects, cookies, tools,
files, repository data, retries, and production exports are absent.

The official primary documentation reviewed on 2026-08-12 is listed in ADR
0027 and the provider README. Normal CI uses a deterministic transport only.
No credential or session search occurred. Because no eligible owned scoped
secret reference was already supplied, the live canary was intentionally not
invoked and no provider effect was attempted.

### Account Manager

The separate repository now exports a versioned read-only reader library and
CLI. It performs handle-bound bounded reads, exact duplicate-rejecting JSON
parsing, coherence rechecks, explicit profile allowlisting, authority and
freshness normalization, finite redacted errors, and emits no secret/session/UI
material. Its root export remains compatible and the subpath is verified from a
packed fresh consumer with install scripts disabled.

The AI Development OS adapter loads and hashes the exact reviewed module instead
of trusting caller version strings. It accepts one explicit nonsecret reader
configuration fingerprint and one `claude-code` authority projection, rejects
method/module/configuration/profile substitution, snapshots hostile plain-data
results under cumulative bounds, normalizes exact windows, and delegates final
eligibility to the scheduler's existing usage rules. The historical fixture
route remains available and unchanged in meaning.

No installed Account Manager UI, browser state, credential, session, or live
profile data was accessed. A local cross-repository contract used only a bounded
task-owned synthetic store.

## Current local validation

Account Manager exact source commit:

- `npm test`: exit 0; 15/15 tests passed, zero skipped; runtime verification
  passed;
- syntax checks passed for reader, CLI, consumer verifier, and tests;
- packed fresh consumer passed root/subpath resolution with scripts disabled;
- consumer audit reported zero vulnerabilities;
- independent GPT-5.6 Sol/Max read-only same-family review: PASS, no remaining
  source/package/docs/test blocker.

AI Development OS current precommit source:

- provider Anthropic: typecheck and build exit 0; 6/6 files and 125/125 tests
  pass, zero skipped; coverage is 93.41% statements (752/805), 88.29%
  branches (679/769), 98.92% functions (92/93), and 96.87% lines (652/673);
- application: typecheck and build exit 0; 8 files pass and one live file is
  intentionally skipped, with 50 tests passed and one live test skipped;
  coverage is 95.05% statements (346/364), 92.21% branches (237/257), 97.61%
  functions (41/42), and 95.08% lines (329/346);
- focused repaired contracts: Anthropic canary 12/12, Account Manager adapter
  17/17, and acceptance matrix 3/3 pass;
- literal root `npm run check`: exit 0 after 23m00s; 169 test files passed and
  four were skipped, with 3,290 tests passed and 29 skipped across all 39
  workspace manifests;
- literal root `npm run test:coverage`: exit 0 after 13m10s; all 39 coverage
  roots are present. Aggregate exact fractions are 26,920/28,889 statements,
  18,795/21,626 branches, 5,206/5,337 functions, and 24,418/25,756 lines,
  yielding floor-to-two-decimal coverage of 93.18%, 86.90%, 97.54%, and
  94.80%;
- repository `npm audit --json`: exit 0, zero info/low/moderate/high/critical
  vulnerabilities across 246 dependency records; `npm audit
  --audit-level=high`: exit 0, `found 0 vulnerabilities`;
- affected production dependency inspection reaches 11 internal workspaces and
  adds no dependency or lockfile edge; the Account Manager reader pin remains
  commit `5279113...`, tree `e8c342a...`, and normalized artifact SHA-256
  `7626a6e...04e40`;
- current package dry-runs with scripts disabled: application 30 entries,
  30,189 packed bytes, 149,320 unpacked bytes, shasum `0a74215a...`; Anthropic
  34 entries, 42,733 packed bytes, 216,159 unpacked bytes, shasum
  `e3ec2f82...`; neither bundles a dependency or includes source/tests/coverage;
- a fresh task-owned consumer installed 11 exact internal tarballs with scripts
  disabled, resolved the application/Anthropic root and testing subpaths with
  the declared optional Vitest peer, proved testing-only surfaces absent from
  production roots, passed `npm ls --all`, and audited zero vulnerabilities
  across 130 dependency records; and
- independent GPT-5.6 Sol/Max same-family, strictly read-only review of the exact
  21-path tree: PASS after its HTTPS transport, Account Manager fingerprint/
  CRLF/size, and matrix identity/status discrimination findings were repaired
  and rerun. No source/package/test/docs blocker remains.

These local results do not substitute for the pending source publication,
exact-head hosted CI, or final evidence-head reconciliation.

## Hosted state

Account Manager workflow run
[`31549101139`](https://github.com/alijabbar04/ai-account-manager/actions/runs/31549101139)
targeted exact source commit `5279113728a344a87a7e49c4222741a618b67dd5`
but failed before any step started. GitHub reported that recent account payments
had failed or the spending limit needed to be increased. This is external and
inconclusive, not a source-test failure and not a passing hosted gate. It was not
retried without a changed condition.

AI Development OS commit/push/hosted facts remain future-only until they occur.

## Safety, authority, and nonclaims

- No live Anthropic call and no Account Manager installed-state read occurred.
- No filesystem/browser credential or session discovery, UI automation,
  communication, purchase, or new recipient action occurred.
- No Stage 17 native candidate execution, restricted operation, installation,
  removal, UAC/elevation, lifecycle proof, or provider-egress proof occurred.
- No production registration/admission, `main` mutation, merge, force-push,
  history rewrite, tag, release, signing, registry/package publication, or
  Linux/macOS product integration occurred.
- Previously disclosed Stage 17/19 task-owned residue was not touched.

## Pending exact dependency order

1. Stage and reconcile only the explicit 21-path reviewed candidate.
2. Commit and non-forcibly push the focused AI Development OS checkpoint, then
   require exact-head hosted jobs.
3. Finalize and reconcile evidence without promoting `ANT-02` or `AM-02` unless
   their missing live/hosted facts actually exist.
