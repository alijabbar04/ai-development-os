# ADR 0019: Windows-first production scope and deferred portability

Status: Accepted product-scope decision; runtime work remains gated
Date: 2026-08-08

Extends ADRs 0014, 0015, 0017, and 0018 without changing their security
boundaries or evidence. It does not supersede ADR 0016's bounded planning
assembly; that ADR's future Stage 24 calibration work remains assigned to the
same numbered stage under the forward-looking **Stage 24W** label.

## Decision

The initial AI Development OS desktop product and the Stage 17 production
release target are Windows only. The remaining Windows closure work is called
**Stage 17W** in forward-looking plans. This label narrows the release target;
it does not renumber completed history and does not turn the current gated
Stage 17 checkpoint into a release.

Linux native enforcement, macOS native enforcement, cross-platform packaging,
platform-parity evidence, and the L-02 Linux workspace-coverage closure move to
the later **Stage 25 portability** track. Linux and macOS are therefore not
initial production-release targets and their missing native evidence does not,
by itself, block a Windows-only release. They remain unavailable and unverified,
not passing or implicitly supported.

Portable interfaces, POSIX behavior, safe-denial paths, platform probes, tests,
and historical evidence remain part of the repository. Deferral does not
authorize deleting or weakening Unix code, tests, evidence, abstractions, or
portability seams.

This decision selects a platform family, not a supported-version matrix. No
Windows version, architecture, installer form, signing state, update channel,
or production availability is claimed until its separate gates are measured on
exact reviewed artifacts.

## Release-truth taxonomy

Product plans, UI projections, release documentation, and future evidence must
keep these states distinct:

| State | Meaning | What it does not mean |
| --- | --- | --- |
| **Implemented capability** | Reviewed source or packaging logic exists. | It has run, enforced its boundary, or is releasable. |
| **Measured capability** | A bounded observation ran on an identified host and artifact. | The observation generalizes beyond its recorded boundary. |
| **Verified capability** | The required positive controls and acceptance gate passed on an exact reviewed head/artifact. | The whole product or another platform is supported. |
| **Supported production-release target** | Product policy permits a platform to enter release gating. | The platform is currently available or has passed those gates. |
| **Deferred/non-target platform** | The platform is outside the current release scope and assigned to a later track. | It passed, is verified, or may be presented as available. |
| **Unavailable/blocked capability** | Admission must refuse because a required implementation, observation, authorization, or gate is absent or failed. | A configuration flag or product target may bypass the refusal. |

`Implemented`, `measured`, `verified`, and `supported target` are independent
facts. A capability may be implemented but unmeasured, measured but not fully
verified, or a supported target while still unavailable. A deferred platform
must not be reported as passing. Conversely, a deferred platform must not
remain an initial Windows-release blocker solely because it is not an initial
release target.

## Exact decision baseline

The baseline for this decision is the exact two-parent integration candidate
`e06db598bc14238156b8d7b378320e35b2e064cf`, tree
`73ce9a998a562b5a3ac5644c10c267590f6809a4`:

- first parent: Stage 17
  `dd5617d04957108b1847d0f1bac4b38ef08a93c7`;
- second parent: completed L-03/L-01/dependency stack
  `bfb06ff54fa0902908a7769d9e4d6a8d18e77604`;
- resolved dependency: one transitive `nanoid@3.3.18`, with zero audit
  findings;
- independent read-only security review: Claude Opus 4.8 at max effort,
  `PASS`, no findings; and
- hosted run `31275835049`: Ubuntu check, Windows check, coverage, and
  dependency audit all passed on that exact head.

Those facts establish an integrated, reviewed, hosted-green candidate. They do
not establish production containment, merge the candidate to `main`, create a
release tag, or change the recorded Windows corpus state from 0/40 `not-run`.

## Stage and release consequences

- **Stage 17W** owns Windows secure-execution proof and its production admission
  gate. Windows remains unavailable until every existing Windows gate passes.
- **Stages 18 through 24W** may plan and implement orchestration, product
  experience, communications, packaging, and Windows readiness in the order
  recorded by the roadmap, but none may manufacture Stage 17W evidence or
  bypass its admission gate.
- **Stage 25** owns Linux/macOS native enforcement, L-02, cross-platform
  packaging, and parity evidence before either platform can become a supported
  production-release target.

Windows production availability remains false until the installed-artifact
lifecycle, fail-closed supervisor behavior, handle-relative containment,
armed Windows corpus, controlled provider egress, packaging, and every other
existing Windows gate pass on exact reviewed heads and artifacts.

## Historical evidence and taxonomy follow-up

Existing release-evidence JSON, proof documents, hashes, logs, attestations,
and dated observations are immutable inputs to this decision. They must not be
rewritten, deleted, regenerated, or reclassified in place. In particular, the
current Stage 17 platform truth table correctly records all three platform
backends as unavailable and the escape corpus as not run.

A separate runtime/evidence task is required if the release-truth generator or
schema cannot represent the taxonomy above. Its acceptance criteria are:

1. introduce a versioned schema that represents implementation, measurement,
   verification, target, deferral, and availability independently;
2. default missing, stale, contradictory, or unknown security evidence to
   unavailable rather than inferring support from target status;
3. preserve every historical evidence artifact byte-for-byte and keep old
   schema readers explicit;
4. add deterministic fixtures proving that a deferred platform is neither
   passing nor an initial-target blocker, and that a targeted-but-unverified
   platform still refuses;
5. bind any new evidence to exact source, artifact, platform, observation time,
   reviewer, and gate identities; and
6. generate new evidence only after the schema implementation and its review
   pass on an exact head.

Until that follow-up is implemented and fresh evidence is generated, the
current production-unavailable truth remains authoritative.

## Consequences

The project can concentrate initial product and proof effort on one platform
without pretending that absent Linux/macOS work succeeded. Later portability
will cost additional native implementation, packaging, CI, accessibility,
operations, and evidence work; preserving the current seams keeps that cost
visible and avoids a Windows-only architectural dead end.

## What this decision does not authorize

This ADR authorizes documentation of product scope only. It does not authorize
runtime or test-code changes, evidence-generator changes, native installation,
UAC/elevation, AppContainer or Job creation, protected filesystem mutation,
signing, provider credentials, live provider calls, the armed corpus, a PR,
merge, tag, release, or publication. It does not claim any supported Windows
version or that Stage 17W is complete.
