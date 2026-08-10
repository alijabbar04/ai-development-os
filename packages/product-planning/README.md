# `@ai-dev-os/product-planning`

Stage 18B production-disabled product-completeness planning. The package turns
validated product intent and untrusted model contribution drafts into explicit,
human-authorized scope decisions, an approved specification, and bounded tasks
in the existing `@ai-dev-os/task-graph`.

The public coordinator is deliberately unavailable for execution. Automated
integration is exposed only from `@ai-dev-os/product-planning/testing` and
requires injected persistence, scheduler, inference, time, and trusted route
evidence. It performs no Git, workspace, native, account, credential, UI, or
network operation.

Model output always has `authority: "none"`. Every candidate, provenance item,
dissent item, unresolved question, decision digest, phase checkpoint, and
requirement-to-task mapping is bounded and durable. Budget values are preview,
reservation-intent, and reconciliation-intent records only; this package never
mutates an external account or usage ledger.

Plans persist under the distinct `product-plan` aggregate discriminator. Exact
planning-event envelopes and the complete embedded task-graph journal replay to
the checkpoint before hydration. Replay validates one command delta and its
exact graph-version delta; hydration rebuilds admission, cumulative limits,
phase/result/attempt linkage, scope and approval policy, canonical Unicode
ordering, structurally encoded stable IDs, and the complete generated product
task set. Mandatory phase calls, token/cost ceilings,
turns, and retry attempts are partitioned from plan-wide bounds; observed usage
is cumulative across retries. One phase may have only one staged result, and a
terminal failure records one finite failed phase while blocking dependants.

```powershell
npm run typecheck --workspace @ai-dev-os/product-planning
npm test --workspace @ai-dev-os/product-planning
npm run test:coverage --workspace @ai-dev-os/product-planning
npm run build --workspace @ai-dev-os/product-planning
```
