# Windows product direction

Status: Accepted product requirements; bounded implementation checkpoints in progress
Last updated: 2026-08-14

This document records future product requirements under the Windows-first scope
accepted by [ADR 0019](adr/0019-windows-first-production-scope.md). It separates
product intent from measured release evidence. Nothing here changes the current
production refusal or grants runtime authority.

The words **must**, **must not**, and **should** are normative. A **borrowed
profile** is an explicitly authorized Claude workspace profile owned by another
person. A **usage snapshot** is a bounded, source-attributed observation of one
profile and one provider-defined usage window; it is not a credential or an
authorization.

## Product experience: Stage 21

The Windows desktop application should be modern, aesthetic, dark-themed,
uncluttered, accessible, and usable without exposing implementation detail by
default. It must use progressive disclosure through two presentation modes:

- **Normal mode** is the everyday surface for tasks, progress, approvals,
  results, compact health and usage indicators, pause/kill, and essential
  controls. It should explain consequences in product language rather than
  exposing protocol or process internals.
- **Developer mode** exposes routing decisions, provider/profile telemetry,
  policy traces, process details, logs, evidence, diagnostics, and advanced
  settings. Developer mode changes visibility and configuration reach only; it
  must not weaken authorization, isolation, approval, redaction, or safety
  policy.

Every meaningful wireframe/prototype set and the implemented desktop experience
must receive a future Fable 5 design review when that review capability is
available. The review is advisory evidence, not authority and not a substitute
for accessibility, security, or deterministic tests. A borrowed profile must
never be used for Fable 5. This task neither invokes Fable nor creates UI assets.
This named product checkpoint does not make a commercial model string a core
routing role: any future route still requires explicit configuration, verified
capabilities, ownership, authorization, and model-substitution checks.

## Usage-aware authorized-profile routing: Stage 18

Dispatch must consider task capability, model suitability, remaining five-hour
usage, remaining weekly usage, reset times, observation freshness, ownership,
authorization, policy caps, and recent failures. Hard feasibility and safety
constraints run before scoring.

Only explicitly authorized profiles may be considered. Owned profiles may have
separately configurable budgets, but still participate in usage-aware routing.
Borrowed profiles may be used only for authorized Claude Code tasks and allowed
models such as Opus or Sonnet; they must never be used for Fable 5.

For each borrowed profile:

- on weekdays when configured local time is at or after 09:00 and before
  17:00 (the half-open interval `[09:00, 17:00)`), the default work timezone
  being `Europe/London`, dispatch must refuse
  when five-hour usage is at or above 50 percent and must not knowingly schedule
  work expected to drive it above 50 percent;
- outside that weekday window and on weekends, the special 50 percent
  five-hour ceiling does not apply;
- the 70 percent weekly ceiling applies at all times, and dispatch must not
  occur at or above it or knowingly drive usage above it;
- both ceilings are hard admission rules, not scoring preferences; and
- stale, unavailable, inactive, ambiguous, or internally inconsistent usage data must
  fail closed for capped-profile dispatch.

Each required five-hour and weekly window must explicitly be active before any
owned or borrowed allocation. A legitimate inactive window remains truthful
evidence with no capacity/reset value; it must not be treated as zero usage,
unlimited capacity, or an active eligibility signal.

Each usage snapshot must identify the provider source, profile identity by a
non-secret scoped reference, provider-defined window, observed time, reset
time, configured timezone, freshness state, and whether each value is
authoritative or estimated. Routing decisions must be auditable without
recording credentials, raw session material, or state from another profile.

### AI Account Manager integration input

The reviewed source is
[`alijabbar04/ai-account-manager`](https://github.com/alijabbar04/ai-account-manager).
The repaired supported reader checkpoint is pinned to commit
`f958ccaee81452f919e7321078899de692f0c81c`, tree
`04c22c65d5839a2c80f716e55f4f41d5ab79c6a7`, its full inventory, and the exact
reader artifact recorded by ADR 0027. It exposes a versioned read-only library
and CLI with one explicit profile allowlist and emits only normalized
`claude-code` usage/authority observations. AI Development OS additionally
binds the exact reader/store configuration fingerprint and trusted profile
authority before scheduler eligibility checks.

This implementation does not itself prove a live installed-state route. No
installed UI, browser/session state, credential, or profile store was accessed
for the checkpoint; the live-route proof required an explicitly authorized read
plus exact-head hosted evidence, recorded below. UI scraping remains
prohibited.

The 2026-08-13 operator-present follow-up invoked that exact maintained boundary
once for one explicitly allowlisted owned profile. It failed closed with
`USAGE_SOURCE_UNAVAILABLE`, changed no store metadata, and disclosed no private
record. That historical failed read predates the inactive-window repair and is
not itself live-route proof. The Account Manager reader repair and the
corresponding AI Development OS inactive-window contract are now both published
and exact-head hosted-green, including the first-party packed-consumer gate.
One further separately authorized read then ran once on 2026-08-16 through the
maintained reader against the real store: the required five-hour window was
genuinely inactive and was normalized as null-capacity, non-allocatable
evidence instead of refusing, the weekly window projected normally, store
metadata was byte-identical before and after, and no credential, profile
enumeration, UI, or browser state was touched. That is the live-route proof,
so `AM-02` is proven.

## Future Windows computer and internet authority

The product will present three permission profiles. These are future policy
profiles, not a claim that the current sandbox can enforce them.

| Profile | Intended authority |
| --- | --- |
| **Contained** | Default Normal-mode policy limited to approved workspace roots and approved network destinations. |
| **Scoped autonomous** | Developer option limited to explicitly named filesystem roots and domain groups. |
| **Trusted Full Access** | Explicit, prominent, revocable high-risk option for broad local filesystem and network authority. |

Trusted Full Access must not silently authorize UAC/elevation, security-setting
changes, destructive deletion, credential export, purchases, publication,
signing, or communication to a new recipient. Those actions retain separate
typed controls, approvals, and audit records. The active high-risk state must be
continuously visible and revocable, with a one-click pause/kill mechanism.

Repository text, web content, tool output, model output, plugins, and inbound
messages are untrusted input. None can grant, expand, or persist authority.

## Typed command and communication boundary: Stages 20 and 22

Stage 20 must establish one typed loopback command/notification boundary before
any external messaging adapter exists. It owns schema validation, authentication,
idempotency, replay protection, approval binding, recipient/channel identity,
notification redaction, and durable emergency-stop state. Free-form inbound
text is always untrusted task input, never direct authority.

Stage 22 adds adapters in this order:

1. **Discord first:** a private allowlisted bot/channel with outbound progress,
   approval, and completion notifications; typed slash commands; idempotency
   and replay protection; emergency stop; and configurable tone and
   notification policy.
2. **Telegram second:** an adapter behind the same typed command and
   notification boundary, with no broader authority.
3. **WhatsApp later:** investigation only after a separate current assessment
   of its API, business requirements, costs, privacy, retention, and operational
   constraints.

Default outbound messages must exclude source code, raw logs, secrets,
credentials, and sensitive artifacts. Adding an adapter cannot weaken the
Stage 20 boundary or convert a chat identity into execution authority.

## Stage ownership summary

| Stage | Product-direction ownership |
| --- | --- |
| 17W | Windows secure-execution proof and release gate; production remains unavailable until it passes. |
| 18 | Durable orchestration, usage-aware authorized-profile routing, and Account Manager investigation/adapter. |
| 20 | Typed local command/notification, approvals, replay protection, and emergency-stop boundary. |
| 21 | Windows Normal/Developer desktop experience and future Fable 5 review gates. |
| 22 | Discord, then Telegram, with WhatsApp deferred to a separate assessment. |
| 23–24W | Windows packaging, operations, hardening, and release readiness. |
| 25 | Linux/macOS portability, L-02, packaging, and parity evidence. |

The detailed dependency order and acceptance gates remain in the
[implementation roadmap](implementation-roadmap.md).

## Explicit non-claims

No UI, messaging integration, installer, update mechanism, production sandbox,
or Fable review is implemented by this document. The Stage 18 scheduler and
usage contracts remain production-disabled, and no borrowed profile is
authorized by documentation alone. Windows production availability remains
false, Linux and macOS remain unavailable/deferred, and historical Stage 17
evidence remains unchanged.
