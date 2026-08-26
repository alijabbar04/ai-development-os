# Stage 20A entry checkpoint

- Status: entry requirements satisfied; C0 complete.
- Recorded: 2026-08-25.
- Scope: Stage 20A entry verification only. This record creates no runtime
  authority and changes no Stage 18 acceptance row.

## Sealed parent

Stage 20A starts from the immutable Stage 18 development-acceptance closure:

| Item | Exact value |
| --- | --- |
| Repository | `C:\Users\mrali\Projects\ai-dev-os-18e` |
| Branch | `feat/stage-18-development-acceptance-closure` |
| HEAD | `f8ab3c506a3c924d9ec315bc853b650d99bceff0` |
| Tree | `02d44f33caddbaf89c93e768cbc4f772faa9e297` |
| Acceptance matrix | `docs/release-evidence/stage-18-development-acceptance-matrix.json` |
| Matrix size | 24,147 bytes |
| Matrix SHA-256 | `db7dbb47e6a90f85ca90798a28953b029a6da6a1c9fb170980158467d812b30f` |
| Exact-head hosted CI | run `32846367459`, attempt 1, push event, seven of seven jobs successful |

The sealed worktree and index were clean. Its configured upstream and the live
`origin` branch both resolved to the exact HEAD. The Stage 20 worktree was
created without changing or removing that sealed worktree.

## External parent reviews

Both supplied reports were read completely and independently hashed before any
Stage 20 edit:

| Review | Size | SHA-256 | Verdict |
| --- | ---: | --- | --- |
| Fable closure review | 11,331 bytes | `23a7c89a802dae46c952097a4263b1a638aacfdd019155868f6af8ee0c5f5b4f` | PASS; zero must-fix findings |
| Opus source/security review | 19,285 bytes | `fb843574985152b5ef06e5f572272acea44195258730306955cb219f15255fc7` | PASS; zero must-fix findings |

Those verdicts seal only HEAD `f8ab3c5...` and tree `02d44f3...`. They do not
transfer to any Stage 20 byte. Their non-blocking observations are preserved in
[the carried-advisory register](stage-20-carried-advisories.md).

## Independent entry derivation

The committed matrix was evaluated from its rows rather than trusting its
top-level declarations:

- the development blockers are exactly `ANT-02` and `AM-02`;
- both development blockers are `proven`;
- `INT-01` is also `proven`;
- the set of development-blocking rows whose status is not `proven` is empty;
- therefore `developmentAccepted=true`;
- `stage20AEligible` is defined by that development result and is therefore
  `true`;
- `PLN-02=incomplete`, but `PLN-02` is not marked as a development-acceptance
  blocker; and
- `PRD-01=production-gated`, the admission schema remains refusal-only, and
  `productionAdmitted=false`.

`PLN-02` and production admission therefore do not block production-disabled
development construction. They do block any contrary planning-complete or
production claim. No matrix row was edited during C0.

The existing spawn boundary was also exercised from the new worktree:

- `@ai-dev-os/provider-codex` refused production with
  `UNSUPPORTED_CAPABILITY`, left the armed start marker absent, and its bounded
  development positive control created its separate marker; and
- `@ai-dev-os/process-broker` refused a production duplex session with
  `PRODUCTION_ISOLATION_REQUIRED`, left the armed child marker absent, and its
  bounded development positive control completed and created its marker.

Each focused test passed once. This is deterministic synthetic evidence only;
no provider, credential, task repository, or production backend was used.

## Separate operator entry decision

The operator's 2026-08-25 Stage 20A prompt is a separate decision, not an
inference from a model review or from `developmentAccepted`:

| Item | Exact value |
| --- | --- |
| Supplied prompt size | 17,912 bytes |
| Supplied prompt SHA-256 | `062240f0cfc456f5da6cc254b4e5cdd995710ed00f765e99c7734269ed34267b` |
| Authorized outcome | C0 entry verification, C1 architecture ratification, and C2 route-free contracts |
| Explicitly outside scope | C3-C5, Stage 20B, project spine, Stage 21, production activation |

The operator accepted Fable product-experience v3 as the intended Stage 21
surface and the Opus dossier as implementation-contract input. The accepted
decision set is `RD-01`, `RD-02`, `RD-03`, `RD-04`, `RD-06`, `RD-07`, `RD-09`,
`RD-10`, `RD-11`, `RD-13`, `RD-14`, `RD-15`, `RD-16`, `RD-17`, `RD-19`,
`RD-20`, `RD-21`, `RD-22`, and `RD-23`.

The five explicit reconciliations are:

1. Stage 20/21 never purchases, subscribes, raises a spending limit, or
   executes a payment. It may later prepare a bounded request for an external
   operator action.
2. External/manual VS Code session observation is removed from v1. A later
   read-only extension requires separate authorization and an ADR.
3. Emergency-stop resume will offer “also return to Contained permissions,”
   defaulted on, and visibly record the decision.
4. A bounded external Windows Job Object spike is permitted later, but not in
   C0-C2.
5. The operator will read the relevant licence documents before Stage 23
   packaging decisions.

The explicit third reconciliation adopts RD-08's resume choice: the future
global emergency-stop resume offers "also return to Contained permissions",
defaulted on only when the mode at engagement was not Contained, and records
the choice separately. It does not authorize a stop or resume command here.

The product is **AI Development OS** and the coordinator persona is **AI
Powerhouse**. Windows is the only product platform. Normal mode has one
coordinator; the bounded direct-to-task input is mode-independent and exists
only for a waiting or blocked session or its approval question, never as free-
standing agent chat. Developer mode adds visibility without more authority, and
the locally persisted mode is never sent as task input. The control plane is a
local child process, never a Windows Service. Fastify is accepted only for the
later C4 listener and remains subject to the dependency audit. Production
dispatch, automatic purchases, Linux/macOS integration, UI automation as agent
integration, and transcript-as-record designs remain excluded.

RD-10 fixes the future visible/application and service-ready deadlines at 30
and 20 seconds, respectively, with no options before the applicable deadline;
the deadline surface is Relaunch, Quit, or stale-cache-only Open read-only with
no dispatch, bounded adoption retry (10 minutes and 20 attempts), a disabled-
with-reason emergency-stop control, and a 1024 by 720 minimum window. RD-08 and
RD-21 keep global `dispatch.pauseAll`, scoped
`ProjectStop {projectId, engagedAt, effects, resumedAt}`, and global emergency
stop separate. A project stop refuses only its project, global stop remains
engageable, and resume starts nothing automatically. The separately chosen
E-3 checkbox returns to Contained permissions by default only when applicable
and records that choice. These are durable future C12/C19 deltas, not C0-C2
runtime capabilities.

## Start-state and CLI observation

Before the first Stage 20 edit, the isolated worktree resolved as follows:

| Item | Observation |
| --- | --- |
| Worktree | `C:\Users\mrali\Projects\ai-dev-os-stage20a-api-foundation-20260825` |
| Branch | `feat/stage-20a-api-contract-foundation` |
| Starting HEAD | `f8ab3c506a3c924d9ec315bc853b650d99bceff0` |
| Starting tree | `02d44f33caddbaf89c93e768cbc4f772faa9e297` |
| Remote | `origin=https://github.com/alijabbar04/ai-development-os.git` for fetch and push |
| Branch upstream at entry | none; the new branch had not been published |
| Worktree/index at entry | clean |
| `codex --version` | `codex-cli 0.149.0-alpha.4.1` |
| `claude --version` | executable unavailable on `PATH`; no version observed |
| `claude-code --version` | executable unavailable on `PATH`; no version observed |

Only version and command-resolution probes were made. No CLI session was
started, no account state was queried, nothing was installed, and no credential
or provider was contacted. “Unavailable” is the exact observation, not a claim
about whether Claude Code exists elsewhere on the machine.

## Dossier reconciliation and ADR crosswalk

The dossiers were based on earlier repository snapshots where Stage 18
development acceptance was false, Stage 20A was ineligible, and ADR numbers
0036 onward were available. Current repository truth supersedes those entry
assumptions: acceptance is now true at the sealed parent, the prompt supplies a
separate operator decision, and ADRs 0036 and 0037 already belong to Stage 18.

The logical candidate labels remain useful design references but do not reserve
numbers. The current landing crosswalk is:

| Dossier logical label | Subject | Repository disposition |
| --- | --- | --- |
| ADR-0036 | Stage 20 subdivision and control-plane hosting | **ADR 0038**, accepted in C1 |
| ADR-0037 | Canonical project model | prospective ADR 0039; not started |
| ADR-0038 | Persistence aggregate extension | prospective ADR 0040; not started |
| ADR-0039 | Approval and spending contracts | prospective ADR 0041; not started |
| ADR-0040 | Operator coordinator model | prospective ADR 0042; not started |
| ADR-0041 | `--bare` Claude Code sessions | prospective ADR 0043; not started |
| ADR-0042 | Broker-owned Claude Code configuration | prospective ADR 0044; not started |
| ADR-0043 | Windows Job Object containment | prospective ADR 0045; not started |
| ADR-0044 | External editor integration boundary | prospective ADR 0046; not started |
| ADR-0045 | Agent session protocol | prospective ADR 0047; not started |
| ADR-0046 | MCP deferral | prospective ADR 0048; not started |
| ADR-0047 | Notifications, outbox, and Stage 21 UI | prospective ADR 0049; not started |

Only ADR 0038 is allocated by this checkpoint. Every prospective number must be
rechecked at its own landing; the crosswalk cannot reserve future identifiers.

## Entry conclusion and nonclaims

C0 is satisfied: the exact parent and its external seal match, development
acceptance and Stage 20A eligibility re-derive, production still refuses before
spawn, and a separately bound operator decision authorizes C0-C2.

This record does not validate or contact Anthropic, read the vault or Account
Manager, start an agent, execute a task, open a listener, complete `PLN-02`,
admit production, begin Stage 20B, or transfer any review verdict to new bytes.
