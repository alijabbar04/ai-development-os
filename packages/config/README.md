# @ai-dev-os/config

Provider-neutral, schema-versioned application configuration, deterministic
layer resolution, per-leaf provenance, canonical output, and change planning.
The package depends only on `@ai-dev-os/domain` and `@ai-dev-os/secrets`; it
does not read files or environment variables and contains no provider SDK,
HTTP, database, process, or desktop integration.

## Configuration model

`ApplicationConfiguration` schema version 1 covers application identity,
provider instances, loopback local-model endpoints, model aliases and role
preferences, routing, run/task budgets, Stage 2 data handling, approval rules,
workspace bounds, artifact storage, persistence, observability, feature flags,
and genuine user preferences. Runtime state is deliberately absent.

Provider credentials are `SecretRef` values only. Inline fields such as
`apiKey`, `password`, `token`, `credential`, and `secretValue` are rejected.
Local endpoints are non-secret loopback HTTP URLs. Provider-specific values
must be bounded `ConfigExtension` records with a namespace, schema version,
canonical JSON value, maximum depth of 8, and maximum canonical size of 16 KiB.
Concrete adapters remain responsible for validating their extension schema.

Parsers reject unsupported schema versions, unknown fields, hostile
prototypes, duplicate identifiers, dangling references, unsafe source names,
non-loopback local endpoints, and out-of-bound values. Parsed and resolved
objects are deeply immutable.

## Layers and resolution

The exact precedence, from least to most specific, is:

1. compiled defaults
2. system
3. user
4. project
5. environment/launch-time
6. explicit runtime

Callers supply logical layer objects; this package does not discover physical
files or interpolate arbitrary environment variables. Input order does not
affect precedence. At most one layer of each kind is accepted. Source names are
bounded logical labels and cannot contain path separators or drive syntax.

Objects use field-level replacement. Collections require an explicit
`merge-by-id` or `replace` mode; there is no generic recursive merge. System or
higher layers can lock mandatory sections so later layers cannot override them.
`application` and `preferences` are not lockable policy sections: a preference
can express user intent but cannot weaken locked data, approval, workspace,
persistence, observability, or provider policy.

```ts
const layer = parseConfigurationLayer({
  schemaVersion: 1,
  kind: "project",
  sourceName: "project config",
  lockedFields: [],
  settings: {
    providers: { mode: "merge-by-id", items: [provider] },
    preferences: { theme: "dark" },
  },
});

const resolution = resolveConfiguration([layer], { clock });
if (resolution.configuration === null) handle(resolution.errors);
```

`resolveConfiguration` returns the immutable configuration, provenance for
every resolved leaf, stable ordered issues, sensitive-field classifications,
canonical JSON, a SHA-256 fingerprint in safe audit metadata, and explicit
restart-requirement vocabulary. Untouched fields keep their earlier source;
merge-by-ID items retain their source unless that identifier is replaced.
The current resolver has no deprecated schema aliases, so `warnings`,
`deprecations`, and resolution-time restart requirements are empty in a
successful schema-v1 resolution.

## Change planning

`planConfigurationChange` compares two validated resolved configurations and
returns sorted, frozen changes with redacted summaries, actions, policy review
markers, and affected provider/subsystem IDs. Changes are classified as:

- `safe-live-reload`
- `requires-provider-restart`
- `requires-workspace-restart`
- `requires-application-restart`
- `forbidden-while-operations-active`
- `invalid-transition`

Secret references, persistence location IDs, and extension values are never
placed in change summaries. The planner describes lifecycle work; it does not
perform reloads or restarts.

## Test support and limitations

`@ai-dev-os/config/testing` exports the reusable configuration contract suite.
`createInMemoryConfigurationSource` provides a deterministic source with a
fixed layer kind. Physical configuration loading, file watching, environment
sanitization, profile/run aliases, and lifecycle execution belong to later
application adapters. The roadmap's profile and run concepts map here to the
more explicit project/environment/runtime layers rather than separate hidden
merge rules.
