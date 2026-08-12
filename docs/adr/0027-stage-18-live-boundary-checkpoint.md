# ADR 0027: Stage 18 live-boundary implementation checkpoint

- Status: Proposed implementation checkpoint; `ANT-02` and `AM-02` remain incomplete
- Date: 2026-08-12

## Context

Stage 18B shipped a production-disabled Anthropic provider with deterministic
transport tests but no reviewed opt-in path to the real service. Stage 18C
shipped a fixture-only Account Manager usage adapter after an exact repository
review, but the inspected revision exposed no maintained reader. The Stage 18
acceptance matrix correctly kept `ANT-02` and `AM-02` incomplete. Stage 19B has
since completed the external-Git crash/idempotency proof and promoted
`INT-01`, leaving those two live-evidence rows as the only development blockers.

Neither a deterministic fake nor the existence of a new file is live evidence.
The implementation must make a future authorized read/call narrow and
reviewable while preserving literal production refusal today. It must not find
credentials, reuse browser sessions, scrape an installed UI, infer profile
authority, or reinterpret Claude Code subscription usage as direct Anthropic
API usage.

## Decision

### Anthropic canary

Add one explicit canary only to `@ai-dev-os/provider-anthropic/testing`. The
production entry point remains unchanged and production-disabled. Each canary
instance accepts exactly one attempt after the literal
`AI_DEV_OS_ANTHROPIC_LIVE_CANARY_V1` sentinel. Before resolving a scoped
`SecretRef`, it requires an injected decision that exactly binds the catalog,
authorization reference, retention mode, endpoint, API version, pinned model,
and fixed-request fingerprint.

The only direct transport is `POST https://api.anthropic.com/v1/messages` with
`anthropic-version: 2023-06-01`, model
`claude-haiku-4-5-20251001`, `max_tokens: 4`, and the fixed harmless prompt
`Reply with exactly OK.`. It accepts no caller URL, headers, model, prompt,
tools, files, repository content, redirect, proxy, cookie, or retry. It disables
connection pooling, caps the response at 64 KiB/128 chunks, caps reported usage,
requires one exact `OK` text block and exact response-model identity, and has a
single 15-second wall timer propagated through preflight, secret access, and
transport. Returned evidence contains only fixed identities, duration, status
category, normalized token counts, and hashes. Response bytes are overwritten
after parsing; request/response bodies and secret material are not returned or
persisted.

The official Anthropic primary documentation was rechecked on 2026-08-12:

- <https://platform.claude.com/docs/en/api/messages/create>
- <https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions>
- <https://platform.claude.com/docs/en/api/errors>
- <https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data>
- <https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to>

The canary distinguishes the documented standard commercial API deletion
period from a separately contracted zero-data-retention mode. Selecting the
latter is not proof that such a contract exists; the preflight must bind it.

### Supported Account Manager reader

Add a maintained CommonJS library/CLI subpath to the separate Account Manager
repository and pin the AI Development OS adapter to its exact reviewed source:

- repository `https://github.com/alijabbar04/ai-account-manager`;
- commit `5279113728a344a87a7e49c4222741a618b67dd5`;
- tree `e8c342a77eaf01535db2bed2819e5ad87e1876df`;
- 29-path inventory SHA-256
  `df89d81c692f298b56ead07c4822a8efc87113919d5594ec0069df59d1161bf3`;
- normalized reader-source SHA-256
  `7626a6e24a10cf479983de7a1c7882ebf87a4ae45bf442c1b1f5a9d65ed04e40`.

The reader is read-only, uses a caller-provided explicit profile allowlist, and
emits only a versioned `claude-code` profile/quota observation. It excludes
credentials, sessions, cookies, prompts, response bodies, unrelated profiles,
and UI state. Handle-bound size/type checks, exact JSON parsing, structural and
text limits, profile/snapshot coherence rechecks, a freshness ceiling, and a
hashed canonical store/allowlist/freshness configuration identity make the
source finite and substitution-detecting. Cancellation/deadline is a bounded
non-preemptive filesystem contract: the reader yields before work and checks
again after the bounded synchronous read; it does not claim that JavaScript can
interrupt an in-progress synchronous filesystem call. UNC/device paths are
rejected. Drive mappings and mounted/network-backed local paths are outside the
reader's no-network claim and must be excluded by deployment policy.

The AI Development OS public adapter accepts only an explicit absolute reader
module path, verifies the exact normalized source digest with a bounded
handle-based read, and restricts that reviewed module's CommonJS `require`
resolution to `node:crypto`, `node:fs`, and `node:path`. This source-identity
boundary is not described as a general VM capability sandbox. Arbitrary
injected reader callbacks remain confined to the application testing subpath.
The adapter separately binds the reader's
nonsecret configuration fingerprint and one trusted profile authority
projection, snapshots returned plain data under cumulative bounds before
normalization, maps the provider to `claude-code`, and includes authority and
usage in canonical snapshot identity. Scheduler freshness, ownership,
authorization, revocation, weekday five-hour 50-percent, weekly 70-percent,
predicted-crossing, and Fable exclusions still run after normalization.

### Acceptance and production state

`ANT-02` remains `incomplete` until one eligible existing owned scoped-secret
route passes the reviewed canary. No secret search is permitted. `AM-02` remains
`incomplete` until an explicitly authorized installed-state read proves the
exact supported route without UI or credential extraction and exact-head
hosted evidence is available. The implementation/test anchors are recorded in
the matrix now so the rows describe the real remaining gap rather than claiming
the harnesses do not exist.

`developmentAccepted` therefore remains `false`. `productionAdmitted` remains
`false`; the version-1 application admission schema has no admitted member and
Stage 17W is still gated.

## Rejected alternatives

- Reusing a Claude Code login or labelling its quota as provider `anthropic`
  would conflate subscription and API-key routes.
- Reading Account Manager's installed UI, browser storage, or raw session files
  would widen authority and expose unrelated data.
- Accepting any module with self-asserted version strings would make the source
  pin decorative.
- Exporting the live canary from the production provider entry point would make
  a test/evidence boundary look like production transport authority.
- Promoting either row from deterministic tests, local implementation, review,
  or a blocked hosted job would substitute narrative for required live proof.

## Consequences and remaining work

The two previously missing live-boundary implementations are now reviewable and
finite, but they have not performed their live operations. A future operator
procedure may construct one canary instance and run that instance once only
when an already configured owned scoped secret and exact preflight are present.
A future Account Manager task
must explicitly authorize one local store/profile read and bind the resulting
nonsecret configuration identity. Both require exact-head hosted gates before
their matrix rows can become proven.

No production provider, worker, workspace, Git, native-execution, daemon, UI,
messaging, release, package publication, or Stage 20 authority follows from
this decision.
