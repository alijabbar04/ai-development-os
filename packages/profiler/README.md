# @ai-dev-os/profiler

`@ai-dev-os/profiler` is the Stage 16 deterministic task-profiling and token-estimation package. It turns trusted task requirements, authority ceilings, repository/context/prompt snapshots, an authority-free Stage 15 thinker proposal, and an optional structural classifier hint into one immutable evidence-bound `TaskProfile`.

The package grants no authority. It does not select or invoke a provider, resolve credentials, read ambient files or environment variables, inspect model names, mutate a repository or task graph, reserve budget, consume quota, or execute a proposal.

## Provenance and conservative effective requirements

Profiles preserve five categories rather than blending evidence:

- `declared` contains the caller's validated Stage 2 task requirements;
- `measured` contains body-free counts and fingerprints from repository index, context pack, compiled prompt, and thinker proposal snapshots;
- `inferred` contains finite deterministic floors derived from trusted facts;
- `classifierHint` is an independently validated, untrusted structural suggestion;
- `unknownFields` names unavailable evidence explicitly.

The effective profile may only tighten trusted requirements. Authority ceilings, compiled-prompt risk/classification, exhausted index limits, and required capabilities can raise the effective floors. A thinker proposal or classifier cannot lower risk or classification, widen edit scope, add authority, alter measured counts, select a provider/model, or invent price, capacity, quota, or tokenizer facts. Every profile has `authority: "none"`, source fingerprints, a configuration fingerprint, confidence/completeness, and a canonical SHA-256 fingerprint.

Measurements contain counts, finite categories, versions, and digests. They exclude repository bodies, file paths, prompt text, context bodies, model output, task prose, user identifiers, and secrets. Fixed validated inputs and the explicit `profiledAt` instant produce byte-identical output.

## Optional classifier boundary

`createDeterministicClassifierFallback` accepts only an injected narrow port. The profiler never creates a hidden provider call. Its input is an exact-key structural record with a request fingerprint, a bounded set of unknown fields, and nullable counts. Its output schema can contain only task kind, complexity, reasoning, coding requirement, bounded confidence, finite reason codes, and a fingerprint.

Classifier use is disabled by default. Disabled, unnecessary, absent, throwing, malformed, and low-confidence outcomes fail closed with a finite structured code. `TaskProfile.classifierCode` preserves the actual conservative outcome; port exceptions and returned objects are never inspected or serialized into errors. Even an accepted hint remains separate from trusted effective requirements.

## Evidence-bound token estimators

The estimator registry keys descriptors by the complete opaque tuple of provider ID, transport/profile ID, contract model ID, and catalog model fingerprint. There is no substring or commercial-family matching.

Each descriptor binds an algorithm version, evidence kind/version/fingerprint, input-byte bound, safety margin, accuracy class, and narrow synchronous counting port. The finite accuracy classes are:

- `exact`: allowed only with tokenizer and complete request-framing evidence;
- `proven-upper-bound`: a reviewed conservative bound with non-heuristic evidence;
- `heuristic`: explicitly unable to prove hard context fit.

Estimates account separately for message bytes, structured-output schema, tools, image metadata, artifact metadata, fixed framing, safety margin, cached input when known, output allowance, and reasoning allowance. BigInt intermediates and safe-integer conversion reject overflow. Stage 14 context units are never relabelled as tokens. An estimator cannot call a provider, inspect credentials, or read ambient state.

## Configuration and public API

Profiler schema, profile algorithm, provenance, estimator contract, and token-estimate schema versions are all `1`. Configuration is immutable, bounded, fingerprinted, and conservative. It controls classifier enablement/confidence, repository/context/proposal bounds, maximum estimator input bytes, and heuristic safety margin. The router's separately locked configuration sets the minimum estimator accuracy permitted for hard context proof.

`parseProfilerConfigurationExtension` accepts the Stage 6 `profiler` extension only from a system layer whose provider field is locked. Lower-priority layers cannot weaken profiling semantics.

The main entry point exports the version constants and cohesive parsers/constructors, including:

- `parseTaskProfileRequest`, `profileTask`, `createTaskProfiler`, `parseTaskProfile`, `summarizeTaskProfile`;
- `parseClassifierHint`, `createClassifierHint`, `createDeterministicClassifierFallback`;
- `validateTokenEstimator`, `createTokenEstimatorRegistry`, `estimateCompiledPromptTokens`;
- exact-descriptor and conservative-estimator construction helpers;
- configuration, authority-ceiling, estimate, and profile fingerprint helpers.

## Testing entry points

- `@ai-dev-os/profiler/testing` exports the reusable Vitest contract suite.
- `@ai-dev-os/profiler/testing/fixtures` exports deterministic Vitest-free profiles, repositories, prompts, proposals, classifiers, and estimator fixtures.

The seeded property corpus records `160316`, `160317`, and `1051920`. Tests prove canonical replay, conservative floors, classifier containment, exact binding, complete overhead accounting, safe arithmetic, observer containment, body-free outputs, and no authority.

## Deferred work

Provider registration remains composition data. This release contains no live commercial tokenizer/provider canary and therefore labels its synthetic complete-framing fixture exact only for that reviewed fake contract. Concrete remote-family exact estimators require separate tokenizer and full-framing evidence. Stage 16 routing consumes profiles; Stage 17 supplies enforcing coding-agent isolation; Stage 18 revalidates and performs durable reservation/dispatch.
