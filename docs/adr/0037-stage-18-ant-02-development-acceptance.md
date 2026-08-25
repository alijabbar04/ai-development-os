# ADR 0037: Stage 18 ANT-02 proof and development acceptance

- Status: Accepted development-scope decision; production remains refused.
- Date: 2026-08-25.
- Source candidate: `f90a779fce8c14cb6c4c3166ed89b0af5355b660`, tree
  `f4a0035c03150970f700435af64cd2bd4e0968e4`, manifest aggregate
  `0cb4729cc4211dca11ef1f166ccd4340ad82db4ba50310c6b5e97244fcbd1d66`.

## Context

Stage 18 development acceptance had one remaining development blocker:
`ANT-02`. An earlier candidate-bound Anthropic validation returned a real
success, but its complete duration and usage envelope was reduced before durable
evidence persistence. That attempt remains `BLOCKED_EVIDENCE`; its authorization
and marker are permanently consumed, and no field is reconstructed from it.

ADR 0036 added a production-disabled, create-only sanitized receipt body and
terminal digest sidecar. Its exact candidate passed hosted CI and separate Fable
and Opus reviews with zero must-fix findings. The later operation recorded here
used a fresh packet, marker namespace, and receipt identity.

## Decision

The fresh one-shot receipt is accepted as the `ANT-02` proof. The committed
38-field validator accepted canonical receipt SHA-256
`9f5083f92b5616fd9b34d28d9dd75b333514c9e74b9bc15914d4c27ae4ffe0b4`.
It binds the exact reviewed candidate, packet, hashed marker namespace, fixed
116-byte request, direct transport, standard retention, 774 ms provider
duration, 12 input tokens, 4 output tokens, and terminal `validated-success`
state. One provider dispatch attempt was made; no retry or fallback occurred.

The reviewed producer can reach that terminal receipt only after receiving HTTP
200 from the pinned endpoint, rejecting model substitution, and accepting
exactly one text block whose complete text is `OK`. Receipt commit then maps the
result to `valid` / `VALIDATION_OK`. No credential or response body is retained.

Therefore:

- `ANT-02=proven`;
- `AM-02=proven` and `INT-01=proven` remain unchanged;
- every row with `blocksDevelopmentAcceptance=true` is now proven;
- `developmentAccepted=true` is derived rather than asserted;
- `PLN-02=incomplete` and `productionAdmitted=false` remain unchanged;
- Stage 20A is eligible, but no Stage 20A work starts in this decision.

## Consequences and nonclaims

The application admission schema remains refusal-only and Stage 17W remains the
production gate. This decision enables no provider for production inference,
does not authorize another provider request, and grants no task, repository,
messaging, installation, release, or deployment authority.

Historical failed and evidence-incomplete attempts remain frozen as recorded.
Their markers are neither inspected nor reinterpreted. The new receipt and its
closure record are forward evidence only; they do not rewrite any frozen audit
subject or promote `PLN-02`.

The reviewed Stage 18E-I head remains the only commit allowed to emit its
candidate-bound live-validation artifact. Closure descendants must preserve
that exact head as an ancestor and its exact manifest blob, but their builds
remove the binding because their bytes are no longer the externally reviewed
candidate. The exact-head manifest verifier remains strict; the ordinary
conditional verifier reports an ancestry-preserving descendant without
transferring the baseline reviews or enabling another operation.
