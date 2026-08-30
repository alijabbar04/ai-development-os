# `@ai-dev-os/intake`

Production-disabled Stage 20 C8 project-intake library. It transforms bounded
operator input and injected, typed repository observations into a deterministic
candidate; applies the accepted two/eight/three clarification bounds; and
records a canonical C6 `ProjectBrief` only after explicit operator acceptance.

## Boundary

`INTAKE_PRODUCTION_ENABLED` is literal `false`. Runtime capabilities and
available commands are empty, and authority is always `"none"`. This package
does not expose a route, listener, desktop UI, provider, credential path,
project command, plan, scheduler decision, task execution, agent/session
runtime, spending effect, or production admission.

Pure modules receive digest and clock ports. Repository inspection receives
only read-only filesystem/Git ports and a monotonic clock. The generic C7
bridge accepts a `PersistenceAdapter`; it contains no memory, SQLite, or
PostgreSQL-specific branch. Production source has no ambient filesystem,
process, environment, network, timer, shell, dynamic load, provider,
credential, Electron, application, control-service, or scheduler access.

## Candidate and provenance

A candidate is ephemeral, recomputable, and digest-identified. It is not a
`ProjectBrief`. Every field retains finite provenance:

- `operator-supplied`;
- `approved-observation`;
- `model-proposed`;
- `proposed-default`; or
- `derived-deterministically`.

The objective must be operator-supplied NFC text and is copied verbatim.
Repository prose cannot enter the collector report and cannot become the
objective. Candidate construction refuses bidi controls, zero-width and other
control characters, malformed or mixed-normalization Unicode, bounded
cross-script lookalikes of protected identifiers, secret-shaped material,
local absolute paths on Normal surfaces, oversized structures,
accessors, exotic/prototype-sensitive objects, and invalid C6 shapes.

`assembleCandidate` validates constraints and questions through the real C6
parsers. A candidate is ready only with an outcome, an audience, and no open
blocking question. The internal acceptance materializer is the only transition
from a candidate to the C6 record shape; it is not part of the package's public
root API and is used only after explicit acceptance validation.

## Clarification

`INTAKE_CLARIFICATION_POLICY` records the accepted OD-06 values: one round by
default, two maximum, eight questions per round, three blocking questions per
round, a required material-change reason for round two, and no pre-acceptance
persistence. Blocking uses only the five exported bases.

Questions are deterministically deduplicated against earlier questions and
typed facts from constraints, confirmed assumptions, prior decisions,
preferences, and inspection. Non-blocking defaults become unconfirmed
assumptions. A blocking default requires an explicit confirmation. Every
accepted round creates one content-derived C6
`Decision(kind: "clarification-answer")` in the acceptance event.

Opening or resolving a round verifies every prior question-set digest. The
durable decision retains the complete canonical proposed-question material,
and the public event parser recomputes its question-set digest before accepting
the audit lineage. Recomputing outer decision or binding identities therefore
cannot make altered clarification text valid. The
canonical consolidated material for one round is also bounded to 16,384
characters because the reused C6 `Decision.rationale` contract has that closed
limit. Per-field maxima therefore do not promise that eight individually
maximum-sized questions fit in one round; C8 refuses the whole round instead
of truncating or persisting incomplete audit material.

## Inspection

`collectRepositoryInspection` accepts an explicit Windows or POSIX canonical
root and a bounded list of relative targets. It validates lexical and resolved
containment, refuses traversal, UNC/broad roots, and reparse/symlink/junction
observations, and enforces file, byte, and deadline ceilings. Every port call
receives the same deadline. The port contract must complete or return an
unavailable observation by that deadline; C8 creates no detached timer.

Git calls use exactly four frozen argument arrays: root, HEAD, branch, and
status. The injected port contract fixes read-only operation with hooks,
network, credential helpers, mutation, and shell interpretation disabled.
Repository file content is not part of the observation interface; finite facts
come only from filenames and validated Git values.

## Acceptance and recovery

One `project-brief` aggregate, whose id is derived from the canonical project
id, owns the whole brief lineage. Its payload is the current C6 brief. One
event per aggregate version preserves the complete accepted brief, provenance,
explicit brief-only operator evidence, and all intake decisions.

Acceptance binds `{candidateDigest, expectedHeadBriefId,
expectedAggregateVersion, intakeDecisionDigest}`. The final field commits the
complete consolidated clarification-decision material, so different answer
sets cannot share one idempotency identity. A single C7 transaction conditionally creates or
updates the aggregate and appends the acceptance event carrying every
applicable intake decision. There is one
write attempt and no retry. A conflict or ambiguous result triggers a bounded
per-aggregate keyset journal/head reread. The original result is returned only
for the same semantic binding and decision material; a different result is
superseded. Confirmed absence returns `not-recorded`; an exhausted finite
window returns `outcome-unknown`. Neither outcome issues a second write.

Brief revisions receive a new content-derived binding identity and supersede
the exact prior head. Byte-identical content accepted against a later version
is therefore a deliberate new revision. Decisions are event payloads, never a
Decision aggregate. First acceptance without clarification is audited by the
acceptance event and its explicit `brief-only` operator evidence; C8 does not
invent a `scope-accepted` decision that could be confused with later C9
authority.

The C7 composition bridge revalidates the complete prepared value at runtime,
including candidate readiness and the absence of blocking questions. A forged
JavaScript `PreparedAcceptance` cannot bypass the public acceptance gate. The
public durable-event parser independently rejects an accepted brief containing
any blocking open question, so reconciliation, history, and projections cannot
reinterpret that malformed state as accepted. It reconstructs the durable
clarification rounds, reuses the same closed-options/default validator as the
ephemeral path, and requires every resolution or unresolved question to match
the accepted brief and its field provenance before the C7 bridge can write.

## Projections

Pure brief, clarification, intake-state, and history projections expose the
same finite verbs, `authority: "none"`, and empty command tuple in both modes.
Normal is a recursive structural subset. Developer adds bounded ids, digests,
provenance, blocking bases, drop diagnostics, and canonical-root facts, but no
action or authority. Normal projection construction includes a load-bearing
leakage detector for controls, credentials, digests, internal ids, rule ids,
protected-identifier lookalikes, and local absolute paths. The pure local
detector covers drive, arbitrary leading-backslash rooted/UNC, delimiter-bounded
root-only slash runs, forward-slash UNC, POSIX, and file-URL forms while
preserving ordinary explicit-scheme network URLs. Protocol-relative and other
ambiguous doubled-slash forms are conservatively refused. The finite
protected-token grammar applies NFD and Unicode 17.0.0 UTS #39 reverse
single-code-point equivalence classes for ASCII letters, digits, and `._:-`,
plus an explicit mechanically audited one-code-point NFKC compatibility table
and the documented narrow repository-specific supplements. Matching remains
limited to the fixed namespace, body, boundary, and 64-slot digest grammar;
marks are handled only inside such tokens, while default-ignorable and
variation-selector characters are refused by the shared formatting check.
Ordinary multilingual prose and punctuation outside protected token shapes
remain permitted. The pinned `confusables.txt` source is dated 2025-07-22 and
has SHA-256
`091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a`.
Its credential corpus
includes the repository-established cloud, GitHub, Slack, JWT, private-key,
Bearer, labelled-secret, long-hex, and long-base64 shapes.

## Verification

From the repository root:

```powershell
npm run typecheck --workspace @ai-dev-os/intake
npm run build --workspace @ai-dev-os/intake
npm test --workspace @ai-dev-os/intake
npm run test:coverage --workspace @ai-dev-os/intake
npm run verify:packed-consumer --workspace @ai-dev-os/intake
```

The focused suite drives memory and real in-memory SQLite through the same C7
bridge, including atomic rollback and ambiguous-result recovery. It uses only
synthetic data and task-owned stores. See
[ADR 0042](../../docs/adr/0042-stage-20-c8-project-intake.md) and the
[C8 checkpoint evidence](../../docs/release-evidence/stage-20-c8-project-intake-checkpoint.md).

## Deferrals

C9 owns plan assembly and must add the missing accepted-brief gate before plan
sealing. Stage 20B owns commands and write routes. Sessions/direct-to-task
input, the Stage 21 UI, providers, credentials, scheduling, execution,
spending, external messaging, and production activation remain absent.
