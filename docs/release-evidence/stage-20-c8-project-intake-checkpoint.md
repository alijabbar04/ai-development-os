# Stage 20 Phase B C8 project-intake checkpoint

## Scope and publication boundary

This checkpoint closes only Stage 20 Phase B checkpoint C8. It adds the
production-disabled `@ai-dev-os/intake` library, ADR 0042, focused tests, a
packed-consumer gate, and necessary current-state documentation. The library
turns explicit operator input and bounded injected observations into an
ephemeral candidate, applies finite clarification, and can request one atomic
C7 `project-brief` acceptance transaction.

C8 adds no route, listener, desktop UI, provider or credential access, task or
plan execution, scheduling, command, approval authority, real project intake,
or production activation. C9 plan assembly, command-bearing Stage 20B work,
Stage 21, and production remain incomplete.

The final commit and tree, remote equality, independent verdict, and hosted-CI
URL cannot be recorded inside their own exact candidate tree without changing
that tree. The terminal handoff records those post-freeze facts. No review PASS
transfers to changed bytes.

## Exact entry identity

The sealed C7 input was verified before editing:

- source worktree:
  `C:\Users\mrali\Projects\ai-dev-os-stage20-c7-persistence-20260829`;
- source branch: `feat/stage-20-c7-persistence-extension`;
- HEAD: `30d144ea3a3067f53caa701d32cde784edd4faa3`;
- tree: `7404732d44535a465a75075b2bbb39ac1855d136`;
- parent/C6: `fd94ffba31d45e3ea75d12d5a2f417ba1538a29c`;
- local, upstream, remote-tracking, and live-remote refs equal, divergence
  `0/0`, and a clean source worktree; and
- exact-head CI run
  `https://github.com/alijabbar04/ai-development-os/actions/runs/33283762072`,
  attempt 2, with all seven jobs successful.

The C8 work is isolated in
`C:\Users\mrali\Projects\ai-dev-os-stage20-c8-intake-20260830` on branch
`feat/stage-20-c8-project-intake`, created directly from that exact C7 HEAD.
The C7 branch was not modified.

The supplied external C7 Opus report was read completely and verified at
17,523 bytes with SHA-256
`1f7f5e5d491d4863d0619e889d833a5d5d31d0100222517cfcafed58e409b605`.
Its verdict is PASS with zero must-fix findings and applies only to the C7
subject, not C8.

## Readiness evidence and reconciliation

The Fable readiness dossier was treated as design evidence, never repository
authority. Both supplied hash inventories were checked: 66/66 entries in the
primary inventory and 60/60 in the post-repair inventory matched, with zero
mismatches. The named handoff, scope, operator-decision, acceptance-fixture,
review/revision, independent-review, and equivalent flow/state/reconciliation
documents were read against the exact C7 contracts.

Two filenames requested by the task, `intake-state-machine.md` and
`contract-gap-and-conflict-register.md`, are absent from the integrity-checked
dossier. Their requirements are present in `end-to-end-intake-flow.md`,
`clarification-system.md`, `state-loading-error-recovery-matrix.md`,
`prior-dossier-reconciliation.md`, and the integrity-checked JSON conflict
register. ADR 0042 records this discrepancy; no requirement was waived.

Some readiness UI descriptions proposed a pre-acceptance
`communication-thread` write. The explicit task and accepted OD-06 require no
pre-acceptance persistence, so repository authority wins: candidates,
clarification sessions, and restart accounting remain ephemeral. No C6 record,
C7 aggregate discriminator, migration, control-service route, or application
composition was changed.

## Accepted decisions and authority boundary

ADR 0042 accepts and records:

- **OD-02:** one future AI Powerhouse coordinator role, amended by RD-04. The
  future direct-to-task channel is contextual, mode-independent, deferred until
  session functionality after C13, creates no Agent authority, and cannot
  bypass policy or approval. C8 implements no channel or agent runtime.
- **OD-06:** one clarification round by default, two maximum, eight questions
  and three blocking questions per round, disclosed defaults and consequences,
  and no pre-acceptance persistence. A restart may reset only ephemeral round
  accounting; accepted resolutions become auditable decisions.

`INTAKE_PRODUCTION_ENABLED` is literal `false`; available commands and runtime
capabilities are frozen empty tuples; all projections report
`authority:"none"`. The package has only `@ai-dev-os/project` and
`@ai-dev-os/persistence` as runtime dependencies. Memory and SQLite adapters
are test-only development dependencies.

## Candidate, provenance, and clarification contracts

Candidates are deterministic digest-bound working values, not durable records.
The objective must be operator-supplied, operator-accepted NFC text and is
preserved byte-for-byte after validation. Repository file bodies are outside
the collector contract, and repository prose cannot become the objective.
Removing chat/transcript context does not change candidate digest, accepted
state, decisions, or deterministic projections.

Every field retains one of five finite provenance values:
`operator-supplied`, `approved-observation`, `model-proposed`,
`proposed-default`, or `derived-deterministically`, plus explicit operator
confirmation. Constraints, questions, previews, and accepted briefs pass the
real strict C6 parsers. A candidate is ready only with at least one outcome and
audience and no unanswered blocking question.

Blocking is closed to exactly five bases: missing required outcome, impossible
or non-machine-readable hard constraint, unresolved data classification or
permission ceiling, unresolved spending/budget ceiling, and ambiguous
repository/branch authority. Questions deduplicate deterministically against
the five typed fact sources and prior rounds. Every non-blocking default has a
consequence and materializes as a model-sourced unconfirmed assumption.
Blocking defaults require explicit confirmation. Round two requires a finite
material-change reason. Each accepted round contributes one content-derived
C6 `Decision(kind:"clarification-answer")` to the later acceptance event.

## Inspection trust boundary

The collector receives an explicitly approved canonical root, relative target
names, and injected read-only filesystem, Git, and monotonic-clock ports. It
refuses traversal, absolute targets, UNC/broad roots, containment escapes, and
symlink/junction/reparse observations. File count, byte, nesting, collection,
and deadline limits are finite. The same deadline reaches every port call; C8
does not create detached timers or operations that could mutate after refusal.

Git is limited to four exact frozen argument arrays for root, HEAD, branch, and
status. The injected contract requires argument-array execution with shell,
hooks, credential helpers, remotes/network, and mutation disabled. The pure
core has no ambient filesystem, process, environment, clock, timer, network,
provider, credential, Electron, control-service, scheduler, or application
access.

## Atomic persistence, lineage, and recovery

There is exactly one `project-brief` aggregate lineage per project. The current
C6 `ProjectBrief` is the aggregate payload; complete accepted history,
provenance, explicit operator evidence, and all consolidated intake decisions
are retained in its C7 journal events. There is no Decision aggregate and no
second brief-record family.

Acceptance binds the candidate digest, expected prior brief head, expected
aggregate version, and the digest of complete consolidated clarification-
decision material. Aggregate, event, brief, evidence, and decision identities
are derived from canonical SHA-256 material. The C7-compatible bridge performs
one conditional aggregate write plus one acceptance-bearing event append in the
same transaction. First acceptance without clarification is audited by the C8
event and explicit `brief-only` operator evidence; it does not fabricate the
C6 `scope-accepted` kind. Clarification rounds record `clarification-answer`
and revisions record `brief-revision-accepted`. Neither grants planning,
scheduling, task, or production authority. Byte-identical content accepted
against a new binding is a deliberate new revision with a new identity.

There is exactly one write attempt. Conflict or ambiguous outcome causes a
bounded reread of the head and ascending per-aggregate journal, at most 100
events per page and 1,000 events total. A complete semantic binding match is
recognized without another write; a different binding is superseded; confirmed
absence is `not-recorded`; and exhausted or unavailable evidence is
`outcome-unknown`. There is no blind retry, detached recovery, or hidden
idempotency store.

## Refusal, hostile-input, and projection controls

C8 owns a finite serializable refusal taxonomy and never extends C6's closed
codes. Public parsers snapshot exact data properties and reject accessors,
exotic/prototype-sensitive objects, prototype-pollution keys, sparse arrays,
cycles, excessive structure, duplicate JSON keys, malformed Unicode, mixed
normalization, bidi/control/zero-width text, secret shapes, and forbidden local
paths without reflecting rejected content, stack traces, or caller paths.
The shared pure detector covers drive, arbitrary leading-backslash rooted/UNC,
delimiter-bounded root-only slash runs, forward-slash UNC, POSIX, and file-URL
local forms while preserving ordinary explicit-scheme network URLs.
Protocol-relative and other ambiguous doubled-slash forms are conservatively
refused. A finite protected-token grammar applies NFD and pinned Unicode
17.0.0 UTS #39 reverse single-code-point equivalence classes for ASCII
letters, digits, and `._:-`, with one-code-point NFKC compatibility closure.
The 2025-07-22 `confusables.txt` source has SHA-256
`091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a`.
An explicit compatibility table closes all 84 one-code-point NFKC preimage
pairs across 71 code points and 26 protected classes. A mechanical Unicode
scan plus fixed-prefix, separator, body, and all-64-digest-position tests make
the closure load-bearing at Candidate and Normal boundaries.
The narrow C8 supplements retained for repository-established canaries are
Cyrillic ve/soft sign for `b`, Latin small-cap D for `d`, Cyrillic en for `h`,
Cyrillic ka for `k`, Cyrillic em for `m`, Greek eta/Cyrillic pe for `n`, and
Cyrillic te for `t`. Matching is scoped to fixed namespace, body, boundary,
and 64-slot digest shapes; marks are handled only inside those tokens. The
shared candidate/Normal formatter refuses default-ignorable and variation-
selector characters. Legitimate multilingual prose and punctuation outside
protected token shapes remain permitted. The credential corpus matches the
repository-established cloud, GitHub, Slack, JWT, private-key, Bearer,
labelled-secret, long-hex, and long-base64 shapes.

Pure brief, clarification, intake-state, and history projections cover finite
loading, empty, partial, unavailable, blocked, ready, and conflict states.
Normal is an explicit recursive structural subset of Developer. Both modes
have identical finite verbs, no runtime action handles, empty commands, and no
authority. Normal structurally omits rules, digests, internal ids, manifests,
PIDs, absolute paths, database details, raw exceptions, credentials, and
Developer diagnostics. Positive leakage canaries prove the detector is active.

## Changed inventory

The C8 candidate is limited to:

- new package `packages/intake/`: manifest, README, TypeScript/Vitest config,
  packed-consumer verifier, eleven source modules, fixtures, and seven focused
  test modules;
- ADR 0042 and this checkpoint evidence;
- scoped current-state changes to the root README, implementation roadmap,
  product direction, and technical design; and
- root package/lockfile and CI packed-consumer registration.

No C6/C7 source contract, adapter, aggregate discriminator, migration,
application, route, runtime-composition, or production-enablement file changed.

## Validation evidence before publication

The focused final pre-review candidate passes:

- package typecheck and build: PASS;
- tests: 7 files, 195 tests, all PASS, including memory and real in-memory
  SQLite acceptance/rollback/recovery integration;
- coverage: 91.19% statements (1,285/1,409), 87.72% branches (929/1,059),
  98.31% functions (233/237), and 93.00% lines (1,143/1,229), above maintained
  floors; and
- focused static-policy, planted-negative, leakage, hostile-input, concurrency,
  pagination, transcript-independence, and projection-parity controls: PASS as
  part of that suite.

An early coverage candidate passed all then-current 82 tests but reached only
85.06% line coverage. Missing branches were exercised with focused behavioral
tests; no floor, assertion, timeout, or exclusion was weakened. A later cleanup
candidate removed a still-used type-only import; TypeScript failed with
`TS2304` before tests ran. The import was restored and the complete focused
sequence above passed. During the later exact-review repair, the first
typecheck exposed a local `number` versus `1 | 2` narrowing error; an explicit
runtime narrowing fixed it. A later typecheck caught an exact-optional-property
call-site mismatch in the new detector option; passing the already validated
options object fixed it without weakening the setting. The first two focused repair runs then failed
25/145 and 3/145 tests because the expanded long-hex detector also rejected the
package's own separately bound digest fields. Digest-shaped values are now
allowed only while parsing the two exact canonical decision-rationale forms,
whose embedded fields are independently parsed and verified; all ordinary
inputs and Normal output remain covered. During the seventh repair, typecheck
passed but the first focused run failed 1/104 because an all-ASCII digest run at
some moving positions correctly reached the older secret-shape refusal before
the new protected-token refusal. The test was repaired with a second reviewed
confusable opposite the moving slot, keeping ASCII runs below the independent
secret threshold while exercising all 64 protected positions; no production
guard changed. The final 195/195 sequence above passed. These failed
candidates are retained in this history and were not reviewed, committed, or
published.

The packed consumer passed across five packed first-party packages, 194 files,
and the two declared runtime dependencies. C6 compatibility passed 71/71
project tests. Persistence core passed 30/30; memory passed 54 with its one
existing capability skip; SQLite passed 113 with three existing capability
skips; and the deterministic PostgreSQL seam passed 103 with three live-server
tests skipped. No PostgreSQL capability variable was present, so no local live
PostgreSQL result is claimed; hosted CI owns that capability gate.

The full root coverage command passed every workspace and was repeated after
the third exact-review repair. Its terminal workspace
passed 114/114 tests at 90.66% statements, 81.21% branches, 91.15% functions,
and 92.63% lines. The pre-commit root `npm run check` passed every workspace
typecheck and the complete test matrix, including C8 at 127/127, and built every
C8/other workspace successfully. Its sole terminal refusal was the inherited
Stage 18 `CANDIDATE_BINDING_WORKTREE_NOT_CLEAN` guard in credential-setup,
which intentionally cannot generate a published-subject binding from a dirty
candidate. The complete root check is run again on the clean commit before
publication.

`npm ls --all` passed; its missing entries were declared optional platform or
browser packages. `npm audit --audit-level=high` reported zero vulnerabilities.
All 117 candidate JSON files parsed, the seven changed Markdown files had
balanced fences and 50 valid inline links, and `git diff --check` passed. The
focused static-policy/leakage gates found no ambient timer or forbidden runtime
surface in production source. The Stage 18 published-anchor descendant verifier
passed. The terminal handoff reports the later clean-tree lifecycle result.

## Independent review history and boundary

The first independent read-only review bound exact staged tree
`1cca1d554d3f5fd8b28bd8e0203f5b2e544e7027`, 33 staged paths, zero
unstaged/untracked/unmerged paths, and a passing cached-diff check. It returned
**FAIL** with three must-fix findings. That verdict is preserved and does not
apply to repaired bytes:

1. the C7 composition boundary accepted a self-consistent but blocked forged
   `PreparedAcceptance`;
2. absolute-path detection missed single-segment and delimiter-adjacent paths,
   while the Normal leakage corpus omitted the already-recognized Bearer-token
   shape; and
3. the public intake-state projection accepted contradictory state/count
   combinations.

The repair independently requires readiness and zero blocking questions at the
C7 boundary and proves zero writes from the direct forged value. It uses one
shared absolute-path/secret detector in validation and Normal scanning, with
single-segment, delimiter-adjacent, Windows, POSIX, and Bearer canaries. It also
requires `blockingCount > 0` exactly when the public state is `blocked`.

All four non-blocking review advisories were assessed. Clarification decisions
now require complete canonical proposed-question material, a recomputed
question-set digest, ordinal/subject-digest agreement, closed blocking
semantics, and null supersession. Filesystem observations now
bind their canonical path to the exact requested relative target, not merely
some contained path. Opening and resolving rounds now reverify all prior
question-set digests. The remaining 16,384-character consolidated-round bound
is the closed reused C6 `Decision.rationale` limit: it is explicit in the C8
contract and package documentation, and fails closed without truncation;
changing C6 is correctly deferred.

The second independent read-only review bound exact staged tree
`e0c630f25e383010c9f72e2739e8180a6d32d59d`, the same 33 staged paths, zero
unstaged/untracked/unmerged paths, and a passing cached-diff check. It returned
**FAIL** with three must-fix areas: Windows rooted/forward-UNC and established
credential-shape false negatives; a clarification-rationale parser that did
not recompute its embedded question-set digest; and a public durable-event parser
that admitted a brief with blocking open questions. It otherwise confirmed the
first three repairs, exact observation binding, prior-session digest checks,
the documented 16,384-character residual, atomicity, one-attempt recovery,
authority parity, production disablement, and C6/C7 non-regression. That second
verdict is preserved and applies only to `e0c630...d59d`.

The second repair added rooted/forward-UNC and repository-established credential
canaries to both input validation and Normal scanning; retained the full
canonical proposed-question value in each clarification decision and
recomputed the question-set digest; and independently refused blocking open
questions in durable event parsing before history or projection. Because
source and load-bearing evidence changed, neither earlier FAIL tree conferred a
verdict.

The third independent read-only review bound exact staged tree
`9031dc688cf0e689fd4958dbee2fcdd07989dbbf`, the same 33 staged paths, zero
unstaged/untracked/unmerged paths, and a passing cached-diff check. It returned
**FAIL** with three must-fix findings: paths beginning with three or more
backslashes escaped the shared detector; durable answer parsing omitted the
closed-options invariant; and durable resolution/unresolved-question material
was not independently bound to the accepted brief and provenance at the public
event/C7 boundary. It otherwise verified the second repair, the original C7
guard, atomic one-attempt recovery, authority parity, production disablement,
and C6/C7 non-regression. That verdict applies only to `9031dc...bfbf`.

The third repair recognizes any leading backslash run with one shared input
and Normal detector and tests counts one through eight; reuses a single closed
resolution validator for ephemeral and durable paths; reconstructs verified
durable rounds; and requires every resolved assumption or unresolved question
and its provenance to agree with the accepted brief before the C7 write. Direct
public-parser and zero-write forged-JavaScript controls cover an out-of-options
answer, an omitted confirmed answer assumption, and an omitted unresolved
question. Session verification also independently rejects self-consistent
semantic duplicates across rounds. Internal digest, decision-material,
detector, resolution-validator,
prepared-parser, and text-option helpers are absent from the package root API,
with a runtime export regression. Documentation now states that explicit-
scheme ordinary URLs pass while ambiguous doubled-slash forms refuse
conservatively.

The fourth independent read-only review bound exact staged tree
`dfaeb4f05efa0bc3206bb5359055d7a553c9ea15`, the same 33 staged paths, zero
unstaged/untracked/unmerged paths, and a passing cached-diff check. It returned
**FAIL** with two must-fix findings: delimiter-bounded root-only slash runs and
root-only `file:`/`path:` forms escaped the shared detector; and cross-script
lookalikes could impersonate protected identifiers because NFC and the ASCII
patterns did not form a confusable skeleton. It otherwise verified all three
prior repairs, atomicity and zero-write refusal, bounded recovery, authority
parity, static boundaries, evidence accuracy, and C6/C7 non-regression. That
verdict applies only to `dfaeb4...ea15`.

The fourth repair added shared candidate/Normal canaries for whitespace- and
quote-delimited root tokens, mixed slash runs, root-only `file:`/`path:` forms,
and both reported Cyrillic rule-id substitutions. The shared protected-token
check used a finite compatibility/Greek/Cyrillic skeleton and retained explicit
ordinary-URL and legitimate multilingual negative controls.

The first process for the fifth review bound the repaired tree and then ended
on model-capacity infrastructure before reaching a verdict. It changed nothing
and conferred no review result. The restarted fifth independent read-only review
bound exact staged tree `3cc207db257e6a94036eb534f2142bd20511acd9`, the same
33 staged paths, zero unstaged/untracked/unmerged paths, and a passing cached-
diff check. It returned **FAIL** with one must-fix finding: the hand-maintained
confusable skeleton still missed adjacent substitutions in rule bodies, record
bodies, and a 64-slot digest, including Cyrillic em, Greek mu/chi, and Latin
small-cap D. It otherwise verified the complete path repair and all prior
security, durable-event, atomicity, recovery, projection, package-boundary, and
C6/C7 non-regression findings. That verdict applies only to `3cc207...acd9`.

The fifth repair replaced the incomplete hand table with a token-scoped Unicode
category grammar. Candidate and Normal controls covered every reported
suffix/body/digest substitution, confusable separators, and a confusable
prefix hyphen.

The sixth independent read-only review bound exact staged tree
`53ee0970c58e1d25228f9bd03505f83eb8b568f9`, the same 33 staged paths, zero
unstaged/untracked/unmerged paths, and a passing cached-diff check. It returned
**FAIL** with two must-fix findings: the category wildcard rejected ordinary
multilingual/non-identifier punctuation content, and combining marks or
default-ignorable characters could bypass protected token and digest checks.
Exact probes included U+034F/U+FE0F before `brf:metadata`, U+20DD inside a
digest-shaped value, and legitimate Japanese, Chinese, Korean, Arabic,
Russian, Greek, punctuation, and 64-character non-identifier controls. It
otherwise verified the prior repairs and the complete C8 state, provenance,
clarification, durability, recovery, projection, static-boundary, packaging,
and C6/C7 non-regression surfaces. That verdict applies only to
`53ee09...568f9`.

The sixth repair replaces the category wildcard with the pinned Unicode 17.0.0
UTS #39 data-backed equivalence table and exact protected-token grammar
described above. Candidate and Normal share the same formatting pattern definitions;
default-ignorables and variation selectors refuse globally, while marks are
handled only inside fixed protected shapes. Focused regressions include every
sixth-review positive and negative probe, retain the earlier confusable corpus,
pin the Unicode source identity, and keep the internal helpers absent from the
package root API.

The seventh independent read-only review bound exact staged tree
`88da12f55e0dd21c1e5fc2ad8f79906e2c35e33b`, the same 33 staged paths, zero
unstaged/untracked/unmerged paths, and a passing cached-diff check. It returned
**FAIL** with two must-fix findings. First, 84 one-code-point NFKC preimage
pairs across 71 code points and 26 protected classes were absent from the
claimed compatibility closure; exact Candidate and Normal escapes covered
Cyrillic modifier forms in `intake`, `sha256`, and `dec`, compatibility colon
and hyphen forms, and a digest slot. Second, the ignored compiled `dist` bytes
predated the latest U+FFF0-U+FFF8 source repair, so the current-source build and
packed-consumer claims were not yet supported. The review otherwise passed the
complete C8 authority, state, provenance, clarification, persistence,
reconciliation, inspection, projection, static-boundary, default-ignorable,
path, evidence-history, and C6/C7 non-regression surfaces. That verdict applies
only to `88da12...e33b`.

The seventh repair adds an explicit 84-pair compatibility table and a
mechanical full-Unicode closure audit, plus end-to-end Candidate and Normal
checks for every fixed prefix, both separator classes, all compatibility body
classes, and all 64 digest positions. Multi-code-point NFKC expansions remain
outside the single-slot grammar. The final build and packed-consumer result in
the validation section is regenerated from these repaired source bytes.

Because source and load-bearing evidence changed again, no prior verdict can
transfer. A fresh independent reviewer must bind the new complete staged tree
and cover state-machine totality, provenance/objective fidelity, clarification
ceilings and event/brief semantics, atomicity, concurrency/idempotency,
unknown-result recovery, hostile-input/leakage controls, Normal/Developer
parity, static boundaries, evidence accuracy, and C6/C7 non-regression. The
terminal handoff records that exact-tree verdict because inserting it here
would change the reviewed tree again.

## Inherited advisories, nonclaims, and next boundary

C7 advisories remain inherited without widening C8 scope:

1. cross-platform package byte/SHA-1 measurements are unstable unless newline
   policy is pinned;
2. migration checksum stability depends on JavaScript template-literal newline
   normalization;
3. the synthetic secret-shaped canary is expected only in the testing export;
   and
4. earlier maintenance/static-policy inventory limitations remain debt.

C8's remaining non-blocking limitations are explicit: injected inspection
ports must honor the supplied deadline; the C6 `Decision.rationale` contract
imposes the fail-closed 16,384-character consolidated-round ceiling; and
Windows canonical Git-root equality is conservatively case-sensitive. The
Unicode equivalence/closure tables are source-identity-pinned and mechanically
audited, but regenerating the base UTS #39 table remains a documented
maintainer procedure rather than a checked-in generator. The
local-path policy deliberately treats protocol-relative URLs, doubled-slash
URL paths, and ambiguous IPv6-host spellings as possible local/UNC material
rather than risking Normal leakage.

C8 does not contact a provider, credential store, vault, Account Manager,
network service, real repository collector, or real project. It creates no
listener, process, session, task, plan, approval, spending effect, message, PR,
merge, rebase, force-push, tag, release, or production state. No main-branch or
historical evidence byte is modified. `PLN-02` remains incomplete,
`productionAdmitted=false`, and Stage 17W remains the production gate.

C9 must add the authoritative rule that no plan can seal without a current
accepted `ProjectBrief`, because C6 contains no brief-to-plan gate. The smallest
safe next action after C8 exact-head publication is external Opus/Fable review,
followed by a separately authorized C9 checkpoint.
