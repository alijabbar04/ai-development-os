# Opus review prompt — Stage 18 ANT-02 source/security and evidence derivation

Perform a fresh, independent, read-only source/security and evidence-derivation
review of the final branch `feat/stage-18-development-acceptance-closure`.

The operator must supply or freeze the final review HEAD at invocation. Resolve
and report:

```text
git rev-parse HEAD
git rev-parse HEAD^{tree}
git status --porcelain=v1 --untracked-files=all
git rev-parse --abbrev-ref HEAD
```

Refuse to transfer any verdict across changed bytes. The closure must descend
directly from reviewed source base
`f90a779fce8c14cb6c4c3166ed89b0af5355b660`, tree
`f4a0035c03150970f700435af64cd2bd4e0968e4`, manifest aggregate
`0cb4729cc4211dca11ef1f166ccd4340ad82db4ba50310c6b5e97244fcbd1d66`.

Baseline reviews apply only to that source base:

- Fable: 19,718 bytes, SHA-256
  `46b5750d227815c08d6b41acd7dbf46941eebed286cb0a8658bd50b94bdcc585`,
  PASS, zero must-fix.
- Opus: 30,135 bytes, SHA-256
  `505fb7028c54e09c3d543052bf3e45a16128078d93928fd085b8a9cff1340f7a`,
  PASS, zero must-fix.

Review the complete base-to-final diff and, at minimum:

1. Verify that no provider, credential, vault, marker, receipt producer,
   transport, retry, timeout, production-admission, or UI behavior was changed
   by the closure. Separately inspect the changed build/publication scripts:
   the exact verifier must remain pinned to reviewed HEAD
   `f90a779fce8c14cb6c4c3166ed89b0af5355b660`, tree
   `f4a0035c03150970f700435af64cd2bd4e0968e4`, and manifest SHA-256
   `f296c931bd9fa924126c9ff39a518f1a3d438b28ba76dd33580e0743c8a1b57d`;
   the conditional
   gate must accept only ancestry-preserving descendants with the identical
   committed manifest blob; and every descendant build/package must omit the
   live-validation candidate binding so changed bytes cannot be used for
   another validation.
2. Recompute the tracked receipt identity. It must be exactly 1,707 bytes,
   SHA-256
   `9f5083f92b5616fd9b34d28d9dd75b333514c9e74b9bc15914d4c27ae4ffe0b4`,
   canonical with one trailing LF, and accepted by
   `parseCanonicalAnthropicValidationSuccessReceipt` as exactly 38 fields.
   Confirm the repository's single-path `.gitattributes` rule pins this receipt
   to `text eol=lf` without installing a filter, diff or merge driver.
3. Re-derive rather than trust the narrative proof chain: the reviewed strict
   provider parser can emit success only after response receipt, HTTP 200,
   exact media type, exact pinned model echo, and exactly one text block whose
   complete text is `OK`; the application success projection independently
   pins the 17-field result; receipt commit precedes `valid` /
   `VALIDATION_OK`; the sidecar/body agreement is required by the named
   projection.
4. Verify exact candidate, packet, marker digest and request bindings; the exact
   statement “One provider dispatch attempt was made.” against
   `dispatchCount=1`; no retry/fallback; bounded duration and token values;
   terminal state; non-retention; and production-disabled state.
5. Treat the committed receipt as the authority. Ensure UI copy, historical
   reduced metadata, and the earlier `BLOCKED_EVIDENCE` attempt are not used as
   substitutes or reconstructed evidence.
6. Inspect the matrix derivation and focused regression test. `ANT-02`,
   `AM-02`, and `INT-01` must be proven; every development-blocking row must be
   proven; `developmentAccepted=true` and `stage20AEligible=true` must be
   derived; `PLN-02=incomplete`, `productionAdmitted=false`, and Stage 20A not
   started must remain explicit.
7. Verify no frozen historical evidence was edited, no secret-shaped material
   or credential-derived field entered Git, and the evidence packet does not
   overclaim its post-commit exact-head CI identity.
8. Check the reported local gates and the final exact-head hosted CI supplied
   by the operator against the actual final HEAD. Baseline run `32818821252` is
   evidence for the source base only.
9. Exercise or inspect the focused manifest/publication regressions. Confirm
   the strict exact-head verifier still refuses a descendant, the conditional
   verifier reports a preserved descendant, and the packed-host gate refuses a
   binding on all non-reviewed heads.

Do not launch Electron, access application data, read metadata or the vault,
inspect any marker or sidecar directly, invoke the receipt projection, contact
Anthropic, use a credential, make a provider request, modify files, or rerun any
stateful operation. Tracked receipt validation and ordinary deterministic tests
are allowed.

Return:

- exact reviewed HEAD/tree and changed-path inventory;
- `PASS` or `FAIL`;
- must-fix findings with file/line evidence;
- non-blocking advisories separately;
- explicit conclusions for receipt integrity, ANT-02 derivation, no secret
  display/export/logging/evidence persistence or disclosure beyond the
  authorized request-scoped provider authentication, historical boundary,
  development acceptance, PLN-02,
  production admission, Stage 20A, ref cleanliness, and exact-head CI.
