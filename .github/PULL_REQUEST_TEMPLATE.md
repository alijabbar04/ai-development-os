## What changed

<!-- What this does, and why. If it is part of a stage, say which. -->

## Validation

<!--
Measured results, with numbers. "Tests pass" is not a validation record.
Delete rows that genuinely do not apply; do not delete rows to avoid filling them.
-->

- [ ] `npm run check` passes locally
- [ ] Coverage floors met (no threshold was lowered)
- [ ] Tests added or updated for the changed behaviour

| Gate | Result |
| --- | --- |
| Tests | |
| Coverage (stmt/branch/func/line) | |

## Security-relevant? 

<!-- Delete this whole section only if the change touches no boundary at all. -->

- [ ] This change does **not** weaken a production refusal gate
- [ ] This change does **not** delete or weaken a security assertion
- [ ] No live provider or model call runs in an ordinary test
- [ ] No credential, token, or generated artifact is added
- [ ] An ADR is added or amended if a security boundary moved

### Defect proofs

<!--
Required for security-relevant changes. For each guard added or changed:
reintroduce the defect, run the suite, and record what you OBSERVED.

The bar is not "the suite went red" — it is "the suite went red for THIS reason".
A vector that fails because an unrelated mechanism produced the same refusal code
has stopped discriminating and needs fixing before it counts.
-->

| Defect reintroduced | Vectors that failed | Expected vs observed |
| --- | --- | --- |
| | | |

## What this does NOT do

<!--
Name the limitations, especially any that this change could be mistaken for
closing. An accurate description of a partial change is worth more than a
confident description of a complete one — this project's audit history is mostly a
history of confident comments that outran their code.
-->

## ADRs

<!-- Added or amended ADRs, or "none". -->
