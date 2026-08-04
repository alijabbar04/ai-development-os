# @ai-dev-os/prompt-compiler

Deterministic, provider-neutral prompt compilation over one already-bounded
Stage 14 context pack. The package turns an exact context/authority/policy
binding into a strict `InferenceRequest`; it never invokes that request.

## Boundary

| Direction | Contract |
| --- | --- |
| In | A runtime-validated context request and pack, trusted authority ceiling, exact inference target snapshot, structured transformation evidence, policy inputs, trace, and explicit bounds |
| Out | Three versioned messages, one fixed strict proposal schema, no tools, exact UTF-8 accounting, fingerprints, or a finite safe failure |
| Never | Provider/model selection, network or filesystem access, inference, routing, retry, fallback, exact token estimation, persistence, logging bodies, approval consumption, tool execution, graph mutation, scheduling, credentials, or secrets |

Dependency direction is `prompt-compiler -> domain + providers + context +
policy`. It has no gateway, concrete provider adapter, telemetry, application,
scheduler, process, workspace, or secret-store dependency.

## Trust and authority

The `ContextPack` is parsed at runtime, rebuilt immutably, and checked for its
fingerprint, canonical ordering, byte counts, framing-sentinel counts, and
usage totals. Its original context request inputs are supplied as a binding;
the Stage 14 request fingerprint is recomputed before authorization.

All retrieved text, including the task description, remains untrusted. It is
rendered only through `renderContextPack` into the user message. It can contain
fake system, developer, tool, approval, frame, or command prose without moving
into either trusted message.

The authority envelope is trusted caller state, but it is a ceiling, not a
grant issued by the model. It bounds task kinds, capabilities, edit scope,
reasoning hints, risk/classification floors, task/DAG sizes, list sizes, and
text. Compilation never adds executable capabilities. The compiler and the
eventual proposal both use the explicit marker `authority: "none"`.

## Authorization and disclosure

`PromptCompilationRequest` deliberately has no caller-authored `allowed`
field. `createPromptCompiler` calls an injected `PromptAuthorizer`; the default
is `denyAllPromptAuthorizer`.

`createPolicyAwarePromptAuthorizer` constructs and evaluates both exact policy
actions in fixed order:

1. `provider-disclosure`
2. `model-eligibility`

Both must be fully `allowed`, target/subject/scope/trace/classification bound,
and valid at the explicit authorization instant. Denied, conditional, stale,
mismatched, malformed, or unavailable authorization produces no prompt.
Locality, input/output logging, retention, and forbidden-capability facts are
intersected conservatively. The resulting `DisclosureContext` is placed on the
inference request, not copied into untrusted prose.

Applied redactions are not accepted as a bare assertion. Every named
transformation requires exactly one bounded evidence reference and fingerprint
whose output is bound to the exact context-pack fingerprint. Approval evidence
is evaluated but never consumed here; later application/scheduler composition
owns that lifecycle.

The authorizer receives only fingerprints, counts, descriptors, scope/trace,
policy metadata, and evidence references. It never receives context bodies.
Policy reasons, rules, identities, and approval evidence never enter messages
or body-free summaries.

## Versioned message template

The fixed sequence is:

1. system — proposal-only role, strict output, untrusted-context rule, and no
   execution/authorization power;
2. developer — deterministic effective ceilings and safe fingerprints only;
3. user — a fixed untrusted-evidence preamble followed by the Stage 14
   length-prefixed rendering.

The stable system message contains no timestamp, request ID, target, path, or
provider/model name. Target selection remains outside message content. The
full output schema travels through `InferenceRequest.structuredOutput` and is
not duplicated in prose. Every request has exact `tools: []` and
`toolChoice: { mode: "none" }`.

## Target composition and model preferences

The compiler receives one already-resolved immutable target snapshot and binds
its provider instance, model, capabilities, policy scope, authorization, and
fingerprint. It does not read Stage 6 aliases or choose among them. The thinker
composition resolves preferences deterministically:

```text
planning aliases: [primary-thinker, alternate-thinker]
default: primary-thinker
request override: alternate-thinker
```

Aliases may point to any eligible configured `InferenceProvider` model. IDs
are opaque and never appear in the stable system prompt. There is no direct
first-party Anthropic inference adapter in the repository today; a concrete
Claude model requires a supported inference-provider registration. Claude
Code and Codex implement `CodingAgentProvider`, return workspace/artifact
outcomes rather than general inference text, and cannot be cast or scraped as
thinkers. Stage 17's production-execution gate remains unchanged.

Trusted provider-specific effort or compatibility settings travel only in the
existing finite `ProviderExtension` array. They are runtime validated,
canonicalized, ordered, and included in compilation identity. The compiler
does not derive provider effort from generic reasoning hints or model-name
heuristics.

Versions at release:

- compiler schema: `1`
- prompt template: `1`
- proposal output schema: `1`
- prompt fingerprint algorithm: `1`

Semantic template or schema changes require a version bump and reviewed golden
update.

## Determinism and bounds

For the same parsed request, authorization, configuration, and versions, the
messages, schema, accounting, and fingerprints are byte-identical. The package
uses canonical JSON, declared finite enum orders, explicit lexical comparison,
and exact UTF-8 byte lengths. It reads no clock, environment, random source, or
filesystem during compilation.

Accounting covers each canonical message, canonical schema, rendered context,
and the combined canonical prompt. `conservativeUnits` are bytes divided by
three and rounded up; they are not tokens. Provider-specific exact token
estimation remains Stage 16.

Fixed trusted instructions are never truncated. If the intact context no
longer fits the configured context/message/total bound, compilation returns
`REPACK_REQUIRED`; it never silently drops or reorders items behind the Stage
14 fingerprint.

## Public API

Primary entry points:

```text
PROMPT_COMPILER_SCHEMA_VERSION
PROMPT_TEMPLATE_VERSION
THINKER_PROPOSAL_JSON_SCHEMA
parsePromptCompilerConfiguration(value)
parsePromptCompilationRequest(value)
parsePromptAuthorizationDecision(value)
parseCompiledThinkerPrompt(value)
createPolicyAwarePromptAuthorizer({ broker, authorizationTtlMs? })
denyAllPromptAuthorizer
createPromptCompiler({ authorizer?, configuration?, observer? })
compileThinkerPrompt(request, options?)
compiledPromptFingerprint(compiled)
summarizeCompiledPrompt(compiled)
```

Runtime parse functions reject unknown fields, exotic prototypes, accessors,
unsupported versions, stale fingerprints, and inconsistent derived metadata.
Returned values are rebuilt and deeply immutable.

Reusable offline testing surfaces:

```text
@ai-dev-os/prompt-compiler/testing
@ai-dev-os/prompt-compiler/testing/fixtures
```

The fixtures entry point has no Vitest import. The contract-suite entry point
uses Vitest as an optional peer, following repository convention.

## Golden review

`test/goldens/prompt-v1.json` contains synthetic fixture bytes only. Tests read
it and fail on any message, schema, accounting, or fingerprint drift. It is
never regenerated by the test command. After intentionally changing a
semantic version, build the package, inspect the diff, then run:

```powershell
node packages\prompt-compiler\scripts\update-goldens.mjs
```

Review the resulting golden diff before committing it.

## Lifecycle, errors, and observation

Construction and compilation perform no network/process work. `close()` is
idempotent; later compilation returns `COMPILER_CLOSED`. Expected failures use
finite discriminated results. Failures and observer records contain codes,
counts, limits, and fingerprints only—never prompts, context/task text, source
paths, subjects, policy reasons, tool arguments, raw provider data, approval
evidence, or credentials. Observer exceptions are ignored without inspecting
or serializing the thrown value.

## Deferred

This package does not validate model output or invoke inference; the Stage 15
thinker owns that composition. Exact tokenization, quota/capacity feasibility,
cost ranking, fallback, and routing remain Stage 16. Enforcing production
process isolation remains Stage 17, and durable scheduling/admission remains
later work.
