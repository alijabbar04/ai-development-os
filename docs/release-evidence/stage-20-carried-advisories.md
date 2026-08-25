# Stage 20 carried-advisory register

- Status: non-blocking observations carried forward for explicit later
  disposition.
- Source subject: Stage 18 closure HEAD
  `f8ab3c506a3c924d9ec315bc853b650d99bceff0`, tree
  `02d44f33caddbaf89c93e768cbc4f772faa9e297`.
- Policy: preserve frozen Stage 18 evidence. A wording improvement is not
  authority to rewrite a historical receipt, closure record, or operation.

## Fable closure-review advisories

| ID | Observation | C0-C2 disposition |
| --- | --- | --- |
| FBL-C1 | Some closure fields say the committed validator “returned `ANT02_PROVEN`”; the validator accepts bytes, while operator adjudication assigns that label. | Carried. Fix only when the owning current-state record is intentionally revised. |
| FBL-C2 | Some prose attributes HTTP 200, model echo, and exact `OK` directly to the projection. They are strict-parser entailments and recorded operation observations, not receipt projection fields. | Carried. New Stage 20 prose does not repeat the loose attribution. |
| FBL-C3 | Older ADRs 0035/0036 and the repair checkpoint retain then-correct present-tense `developmentAccepted=false` language without a pointer to ADR 0037. | Carried. Historical bytes remain intact. |
| FBL-C4 | The closure checkpoint names a “secret scan” without identifying a command; the actual automated coverage is in secret-shape assertions. | Carried. Stage 20 evidence must name its exact scan. |
| FBL-C5 | Baseline review artifacts are cited by identity but were not locally auditable to that reviewer. | Carried. C0 binds the two newly supplied reports by path-independent size and digest. |
| FBL-C6 | The credential-setup README has stale future tense and lacks a descendant-build hint explaining “Live validation disabled.” | Carried to a separately scoped UI/documentation touch. |
| FBL-C7 | The large Stage 18 status table cell in the root README is difficult to scan. | Carried; C0-C2 does not reformat frozen closure prose. |

The Fable review also confirmed that eight advisories from its earlier baseline
review remain open because the UI bytes did not change. Their original review
remains the authoritative wording; this register does not fabricate or
reinterpret unavailable baseline text.

## Opus closure-review advisories

| ID | Observation | C0-C2 disposition |
| --- | --- | --- |
| OPS-C1 | Evidence prose loosely attributes parser-entailed facts to the projection. | Carried with FBL-C2. |
| OPS-C2 | The matrix's `ANT-02` requirement was correctly made explicit about request-scoped provider authentication, but the wording change was not called out. | Carried. No matrix row is edited here. |
| OPS-C3 | A matrix-test derivation checks `status === "incomplete"` where `status !== "proven"` is the safer predicate; a sibling exact-set assertion currently preserves safety. | Carried to a Stage 18 maintenance change. |
| OPS-C4 | A moved manifest guard lost an exact static assertion although behavioural and structural coverage remains. | Carried to a Stage 18 maintenance change. |
| OPS-C5 | `verify:stage-18e-i-subject-manifest` is exact-head-only, but its script name does not communicate that constraint. | Carried to operator-documentation maintenance. |
| OPS-C6 | Earlier UI copy still says “Exactly one provider check completed.” | Carried to a separately scoped UI change. |
| OPS-C7 | The reviewer independently reconstructed final HEAD/CI because the requested final operator inputs were not supplied. | Closed as a review-process lesson: Stage 20 review input will bind the exact frozen candidate and locally measured gates. |

## Disposition rule

These advisories are not Stage 20 must-fix findings and do not weaken the exact
parent PASS verdicts. Later work may resolve an item only when its owning bytes
are in scope, with focused tests and a new review where appropriate. Historical
provider state, credentials, receipts, markers, and operations remain closed.

