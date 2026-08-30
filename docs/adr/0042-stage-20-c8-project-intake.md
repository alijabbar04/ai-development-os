# ADR 0042: Stage 20 C8 project intake

- Status: Accepted for Stage 20 Phase B checkpoint C8
- Date: 2026-08-30
- Governing parents: ADR 0038, ADR 0040, and ADR 0041
- Exact prerequisite: C7 commit
  `30d144ea3a3067f53caa701d32cde784edd4faa3`, tree
  `7404732d44535a465a75075b2bbb39ac1855d136`
- Supersedes no project or persistence contract

## Context

ADR 0040 owns the canonical project records and ADR 0041 owns their generic
persistence discriminators. C8 needs to turn explicitly supplied project
information and bounded repository observations into a reviewable candidate,
then persist a canonical `ProjectBrief` only after an explicit operator
acceptance. It must not add a route, command, provider call, task, plan,
scheduler decision, UI, credential path, or production authority.

The Fable readiness dossier is design evidence rather than repository
authority. Its requested files `intake-state-machine.md` and
`contract-gap-and-conflict-register.md` do not exist in the integrity-checked
66-file dossier. The same requirements are carried respectively by
`end-to-end-intake-flow.md`, `clarification-system.md`,
`state-loading-error-recovery-matrix.md`, `prior-dossier-reconciliation.md`,
and the earlier integrity-checked JSON conflict register. This filename
discrepancy does not change or waive a requirement.

The readiness flow mentions pre-acceptance communication-thread writes in a
few UI-state descriptions. The explicit C8 task and OD-06 instead require no
pre-acceptance persistence. The repository implementation follows that
higher-priority boundary: candidates, clarification rounds, and restart state
are ephemeral until acceptance.

## Accepted operator decisions

### OD-02

Adopt one future AI Powerhouse coordinator role, amended by RD-04. The future
direct-to-task input channel is contextual, mode-independent, and deferred
until session functionality after C13. It is not a free-standing agent chat,
does not create an Agent authority record, and cannot bypass policy, approval,
usage, allocation, or security refusal. Communication never creates
authority. C8 implements no channel or agent runtime.

### OD-06

Adopt one clarification round by default and a hard ceiling of two ephemeral
pre-acceptance rounds. Each round contains at most eight questions and at most
three blocking questions. Every default has an explicit consequence. A second
round requires a typed material-change reason. Blocking is limited to:

1. absence of a required outcome;
2. an impossible or non-machine-readable hard constraint;
3. unresolved data classification or permission ceiling;
4. unresolved spending or budget ceiling; and
5. ambiguity about the repository or branch that may be changed.

A restart before acceptance may reset round accounting because C8 persists
nothing before acceptance. Every accepted clarification round is represented
by a consolidated `Decision(kind: "clarification-answer")` in the acceptance
journal event. Defaulted non-blocking answers become unconfirmed assumptions.
Every prior question-set digest is reverified before a round is opened or
resolved. The consolidated decision carries the complete canonical proposed-
question material, and durable event parsing recomputes its question-set digest
instead of trusting an embedded digest string. Consolidated material is bounded to the reused C6
`Decision.rationale` ceiling of 16,384 characters. This can constrain the
combined size of eight otherwise valid questions; C8 fails closed rather than
truncate audit evidence, and changing that closed C6 limit is outside C8.

## Pre-implementation map

This map was recorded before C8 source was written.

| Concern | Repository contract reused | C8-owned implementation |
| --- | --- | --- |
| accepted record | C6 `ProjectBrief`, `Constraint`, `ClarificationQuestion`, `Decision`, strict parsers and lineage guards | ephemeral candidate with field provenance; acceptance materialization only |
| canonical bytes | C6 canonical project JSON plus C7 SHA-256 utility | candidate, binding, identity, and decision material definitions |
| durable lineage | C7 `project-brief` aggregate, optimistic versions, one transaction, append-only event journal | one aggregate id derived from project id; current brief as payload; one acceptance event per aggregate version |
| clarification | C6 question and decision shapes | fixed blocking bases, two/eight/three ceilings, deterministic dedupe, answers/defaults, session restart |
| observation | no ambient C6/C7 I/O | bounded read-only filesystem and Git ports, canonical-root containment, typed observations, partial/unavailable results |
| time and hashing | C7 checksum function is the default SHA-256 adapter | injected clock and digest ports at the engine boundary |
| refusal | C6 and C7 errors remain closed and unchanged | finite C8 rule ids, safe roots, fixed copy, no rejected-input reflection |
| presentation | C6 Normal/Developer subset and no-authority precedent | pure brief/intake/history projections; Normal recursively omits identities, digests, rules, and absolute paths |
| production | inherited literal false boundaries | `INTAKE_PRODUCTION_ENABLED=false`, empty commands, authority, and runtime capabilities |

The package is `@ai-dev-os/intake`. Pure modules have no ambient filesystem,
Git, process, environment, network, provider, credential, clock, timer, UI, or
application access. The collector and C7 store bridge receive narrowly typed
ports; no source repository is mutated.

## Candidate, provenance, and objective fidelity

A candidate is deterministic, digest-identified working data and is never a
durable project record. Every candidate value carries one of the finite
provenance sources `operator-supplied`, `approved-observation`,
`model-proposed`, `proposed-default`, or `derived-deterministically`, plus
explicit operator confirmation where applicable. The acceptance event preserves that provenance
beside the canonical brief and decisions because the fixed C6 brief shape does
not have provenance fields for every list item.

The objective must be operator-supplied NFC text and is copied byte-for-byte
after validation. Repository prose, README text, comments, issue text, package
descriptions, commit messages, model prose, and derived facts cannot become
the objective. Raw chat transcripts are not accepted as durable intake input.
Deleting the conversation record referenced by `sourceThreadId` does not
change the accepted record, decisions, or later deterministic projections
because C8 never dereferences thread content.

A candidate is ready only when a preview constructed from its content passes
the real C6 `parseProjectBrief`, contains at least one outcome and audience,
and has no unanswered blocking question. Preview-only identity and timestamp
fields are excluded from candidate digest material.

## Inspection boundary

The collector receives an explicitly approved canonical root, bounded relative
targets, and injected filesystem, Git, and monotonic-clock ports. It refuses
absolute or traversing targets, UNC roots, canonical paths outside the root,
and symlink/junction/reparse observations. File and byte ceilings are checked
before observations are admitted. Every port call receives the same finite
deadline; the port contract must finish or return an unavailable result by
that deadline. No detached timeout operation is created.

Git access is a closed set of frozen argument arrays for root, HEAD, branch,
and worktree status observations. The port contract forbids hooks, credential
helpers, remote/network access, mutation, shell interpolation, and caller-
selected subcommands. Classification uses typed metadata and finite Git facts,
never repository prose. Identical observations produce identical reports.

## Acceptance transaction and idempotency

There is one `project-brief` aggregate per project. Its aggregate id is derived
from the canonical project id. The aggregate payload is exactly the current
C6 `ProjectBrief`; accepted history and C8 provenance remain in one journal
event for each aggregate version.

Acceptance binds the candidate digest, expected prior brief id or null,
expected aggregate version, and a digest of the complete consolidated
clarification-decision material. It derives stable aggregate, event, brief,
operator-evidence, and decision identities from canonical SHA-256 material.
The transaction conditionally creates version 1 or updates exactly version N
to N+1 and then appends one event containing:

- the complete acceptance binding;
- the accepted `ProjectBrief` (therefore preserving history);
- field provenance;
- finite explicit-operator acceptance evidence; and
- every applicable consolidated, real C6-parsed intake `Decision`.

The C7 bridge is a runtime trust boundary, not a TypeScript-only boundary. It
reparses the whole prepared value and independently requires a ready candidate
with no blocking open question before the transaction can start. The public
acceptance-event parser enforces the same no-blocking invariant independently
for durable reconciliation, history, and projection consumers. It reconstructs
the complete durable clarification session, applies the same closed resolution
semantics (including answer options), and binds resolved assumptions plus
unresolved questions and their provenance to the accepted brief before any C7
write.

The event is in the same C7 transaction as the brief write. A fault between
the aggregate operation and event append rolls both back. There is no Decision
aggregate or idempotency ledger.

Only one conditional write is attempted. On a concurrency conflict or an
ambiguous result, C8 re-reads the head and a bounded, per-aggregate keyset
journal window. The C7 journal orders ascending and exposes no reverse scan;
C8 therefore caps the total examined acceptance events and returns a finite
unresolved result if the target falls outside that bound. An identical durable
binding returns the original result without another write. A different binding
is superseded. A confirmed absence after an ambiguous write returns
not-recorded and leaves a later explicit operator action to try again. There is
no hidden or blind retry.

The first acceptance without a clarification round needs no invented C6
`Decision`: the C8 event and its explicit `brief-only` operator evidence audit
that transition. Clarification rounds add `clarification-answer`; revisions add
`brief-revision-accepted`. C8 deliberately does not fabricate
`scope-accepted`, which could be misread as the C9 scope authorization that C8
does not own.

Brief ids are new for every binding, including byte-identical content accepted
against a later expected version. Revision records supersede the exact prior
head and pass C6 `assertNewBrief`; revision events include
`Decision(kind: "brief-revision-accepted")`.

## Projection boundary

Normal and Developer projections are pure frozen values with the same
`authority: "none"`, empty command tuple, and finite status/actions vocabulary.
Developer may add bounded identifiers, digests, provenance, rule ids, and
canonical root facts. Normal is an explicit recursive structural subset and
contains no rule id, digest, aggregate/event/record identity, manifest, PID,
database detail, raw exception, secret-shaped text, or absolute path. Neither
projection contains a callback or runtime action handle. The shared pure
scanner recognizes Windows drive and arbitrary leading-backslash rooted/UNC,
delimiter-bounded root-only slash runs, forward-slash UNC, POSIX and file-URL
local paths, plus the repository-established credential shape corpus. A finite
protected-token grammar applies NFD and pinned Unicode 17.0.0 UTS #39 reverse
single-code-point equivalence classes for ASCII letters, digits, and `._:-`,
with one-code-point NFKC compatibility closure. The source
`confusables.txt` is dated 2025-07-22 and has SHA-256
`091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a`.
An explicit compatibility table closes all 84 one-code-point NFKC preimage
pairs across 71 code points and 26 protected classes. A mechanical Unicode
scan plus fixed-prefix, separator, body, and all-64-digest-position tests make
that closure load-bearing at Candidate and Normal boundaries.
The narrow C8 supplements retained for repository-established reviewer
canaries are Cyrillic ve/soft sign for `b`, Latin small-cap D for `d`, Cyrillic
en for `h`, Cyrillic ka for `k`, Cyrillic em for `m`, Greek eta/Cyrillic pe for
`n`, and Cyrillic te for `t`. Matching is limited to the fixed namespace,
body, boundary, and 64-slot digest grammar; marks are handled only within such
tokens. The shared formatter independently refuses default-ignorable and
variation-selector characters. Ordinary multilingual text and punctuation
outside protected shapes remain permitted; explicit-scheme network URLs pass,
while protocol-relative and other ambiguous doubled-slash forms are
conservatively refused.

## Explicit deferrals and nonclaims

C8 adds no C9 plan assembly or sealing. C9 must add an authoritative gate that
refuses plan sealing without an accepted current `ProjectBrief`; C6 does not
currently contain that brief-to-plan gate.

Also deferred are attachments/context-pack persistence, Stage 20B commands and
write routes, control-service intake routes, task scheduling, provider and
credential access, sessions and direct-to-task input, the Stage 21 UI,
spending or messaging automation, and production enablement. C8 creates no real
project or intake record during development or tests.

Inherited C7 advisories remain recorded without widening scope: cross-platform
package byte/SHA-1 evidence needs a pinned newline policy; migration checksums
depend on JavaScript template-literal newline normalization; the synthetic
secret canary is expected only in the testing export; and earlier static-policy
inventory limitations remain maintenance debt.

## Consequences

C8 supplies a deterministic, production-disabled library boundary that later
application and UI stages may call. It cannot execute its own projections,
start work, or grant authority. Stage 20, Stage 20B, Stage 21, `PLN-02`, and
production admission remain incomplete.
