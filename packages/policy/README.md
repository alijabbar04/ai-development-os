# @ai-dev-os/policy

The central provider-neutral policy broker for AI Development OS. It combines
Stage 2 classifications and handling policies with provider/model capability
facts, locality, action intent, task risk, configured rules, transformations,
and structured approval evidence. It depends only on domain and provider
contracts, never on a concrete provider or execution adapter.

## Rules and decisions

The finite action vocabulary covers provider disclosure, model eligibility,
cloud/local execution, artifact persistence, input/output logging, workspace
read/write, commands, network, tools, secrets, approvals, retention, export,
deletion, package installation, and Git writes.

Rules have organization, project, or user authority and an allow, deny, or
conditional effect. Matching is deterministic: organization rules first,
then project rules, then user rules; IDs break ties. Restrictions accumulate
conservatively. Any matching deny wins, and a lower-authority allow cannot
erase a mandatory locality, transformation, approval, logging, persistence,
retention, or capability restriction. With no matching allow, the result is
deny-by-default.

```ts
const broker = createDeterministicPolicyBroker({
  policyVersion: "organization-policy-v1",
  rules,
  clock: createManualPolicyClock(),
});

const decision = broker.evaluate(request);
```

Every decision is deeply frozen and contains an `allowed`, `denied`, or
`conditional` outcome, stable code and ordered reasons, matched rule IDs,
required transformations and approvals, locality/logging/retention limits,
capability constraints, policy version, safe audit record, and deterministic
SHA-256 fingerprint. The fingerprint uses canonical structural inputs only;
the request model has no place for prompts, source, tool arguments, artifacts,
paths, or secret values. Semantically equivalent insertion orders replay to
the same fingerprint.

## Approval evidence

Conditional rules produce structured approval requirements with a derived or
injected request ID, action/risk, exact scope, required approver class,
one-shot/reusable usage, expiry, and the SHA-256 digest of the normalized action
subject. The trusted caller normalizes a path, argument structure, artifact, or
other action subject and supplies only its digest; raw values never enter the
policy request. Evidence carries the same subject digest, an identity reference,
approved or denied result, decision/expiry/revocation/consumption timestamps,
evidence reference, and the same bounded scope vocabulary.

Plain booleans are not accepted. An approval rule denies requests that lack a
normalized-subject digest. Evidence must match action, risk, subject digest,
approver class, scope, and trace-related identifiers; it must be live,
unrevoked, and unconsumed for one-shot use. Any action or subject change derives
a different approval ID. Explicit denial wins. Model-originated requests cannot
approve their own requirement. Decisions return one-shot approval IDs that the
caller must consume transactionally; Stage 6 does not persist approval state or
build an approval UI.

## Data policy and audit safety

Provider disclosure reuses Stage 2 handling-policy evaluation. Model and
provider capabilities, cloud retention/training declarations, required
redactions, artifact/logging permissions, locality, and retention bounds are
checked before an allow. An injected clock makes expiry and audit timestamps
deterministic. An optional observer receives safe decision records only; an
observer failure becomes a bounded `PolicyError` and never gains access to raw
content.

`@ai-dev-os/policy/testing` exports a reusable broker contract suite. This
stage evaluates policy but does not execute tools, commands, filesystem, Git,
packages, networking, or lifecycle actions and does not persist audit or
approval evidence. Trusted workspace/process layers must normalize action
subjects before hashing them; this package validates and binds the digest but
does not normalize platform paths or command arguments. It also does not mint
expiring execution-capability grants or reserve/commit budgets: those require
the Stage 8 isolation and Stage 12 scheduler ledgers. Stage 6 decisions and
configured budget defaults provide their policy inputs.
