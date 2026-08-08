/**
 * Child-process environment construction.
 *
 * The child never inherits the caller's environment. The environment is built
 * from an empty baseline and contains only what was named explicitly: a small
 * set of platform variables the operating system needs to create a process,
 * broker-owned temporary and profile directories, deterministic locale
 * values, and the caller's explicitly configured bindings.
 *
 * Honest limitation: once the operating system creates the child, the
 * environment block has been copied into another address space. JavaScript
 * cannot erase it, and a child may re-export any value it received. Secret
 * bindings are therefore resolved late, scoped to one invocation, and
 * redacted from captured output; they are not recoverable after the fact.
 */

import { validation } from "@ai-dev-os/domain";
import { ProcessBrokerError, invalidRequest } from "./errors.js";
import { fingerprintOf } from "./fingerprint.js";
import { parseWorkspaceRelativePath } from "./paths.js";

const { ensureExactKeys, ensureRecord, ensureString } = validation;

export const MAX_ENVIRONMENT_BINDINGS = 256;
export const MAX_ENVIRONMENT_NAME_LENGTH = 256;
export const MAX_ENVIRONMENT_VALUE_BYTES = 32_768;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

/**
 * Names that must never be taken from the caller's environment or set from
 * ordinary configuration. Each one either redirects where a tool looks for
 * credentials and configuration, or hands the child an ambient authority the
 * grant did not include.
 */
export const FORBIDDEN_ENVIRONMENT_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    // Home and profile redirection.
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    // Claude credential/configuration redirection and subscription tokens.
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    // Interactive credential and agent access.
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "SSH_ASKPASS",
    "GIT_ASKPASS",
    "GIT_CREDENTIAL_HELPER",
    "GIT_TERMINAL_PROMPT",
    "GPG_AGENT_INFO",
    "GNUPGHOME",
    // Git repository and configuration redirection.
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CEILING_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_TEMPLATE_DIR",
    "GIT_EXEC_PATH",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
    "GIT_ALLOW_PROTOCOL",
    "GIT_PROTOCOL_FROM_USER",
    // Cloud and registry credentials.
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AZURE_CLIENT_SECRET",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GCLOUD_PROJECT",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "PIP_INDEX_URL",
    "CARGO_REGISTRY_TOKEN",
    "DOCKER_CONFIG",
    "KUBECONFIG",
    // Continuous-integration and forge tokens.
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITLAB_TOKEN",
    "CI_JOB_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    // Language and package-manager startup hooks.
    "NODE_OPTIONS",
    "NODE_REPL_EXTERNAL_MODULE",
    "PYTHONSTARTUP",
    "PYTHONPATH",
    "RUBYOPT",
    "PERL5OPT",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    // Ambient proxy configuration.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]),
);

const FORBIDDEN_ENVIRONMENT_NAMES_CASE_INSENSITIVE: ReadonlySet<string> = Object.freeze(
  new Set([...FORBIDDEN_ENVIRONMENT_NAMES].map((name) => name.toUpperCase())),
);

function assertRequestEnvironmentNameAllowed(name: string): void {
  if (FORBIDDEN_ENVIRONMENT_NAMES_CASE_INSENSITIVE.has(name.toUpperCase())) {
    throw new ProcessBrokerError(
      "ENVIRONMENT_REJECTED",
      "This environment variable redirects credentials, configuration, or runtime behaviour and cannot be set from a request.",
      { name },
    );
  }
}

/**
 * Windows requires a small number of system values to create a usable
 * process. Nothing here identifies the interactive user or grants credential
 * access; the values are read from the host once and validated.
 */
const WINDOWS_SYSTEM_NAMES: readonly string[] = Object.freeze([
  "SystemRoot",
  "windir",
  "SystemDrive",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

export const ENVIRONMENT_BINDING_KINDS = Object.freeze([
  "literal",
  "workspace-path",
  "secret",
] as const);
export type EnvironmentBindingKind = (typeof ENVIRONMENT_BINDING_KINDS)[number];

/**
 * One environment entry.
 *
 * A `secret` binding carries only a reference. The value is resolved after
 * policy approval, immediately before the process starts, and is never stored
 * on the request, the result, an audit record, or an error.
 */
export type EnvironmentBinding =
  | { readonly kind: "literal"; readonly name: string; readonly value: string }
  | { readonly kind: "workspace-path"; readonly name: string; readonly value: string }
  | { readonly kind: "secret"; readonly name: string; readonly secretRefFingerprint: string };

/**
 * Body-free digest over every security-relevant environment binding field.
 *
 * Names alone are insufficient: changing a literal value or swapping a secret
 * reference changes the command authority even when the variable name stays
 * the same. The digest, never the values, is carried into policy/session
 * evidence.
 */
export function environmentBindingsFingerprint(
  bindings: readonly EnvironmentBinding[],
): string {
  return fingerprintOf(
    bindings.map((binding) =>
      binding.kind === "secret"
        ? {
            kind: binding.kind,
            name: binding.name,
            secretRefFingerprint: binding.secretRefFingerprint,
          }
        : { kind: binding.kind, name: binding.name, value: binding.value },
    ),
  );
}

function ensureName(value: unknown, path: string): string {
  const name = ensureString(value, path, { maxLength: MAX_ENVIRONMENT_NAME_LENGTH });
  if (!NAME_PATTERN.test(name)) {
    throw invalidRequest("An environment variable name is not a portable identifier.", {
      field: path,
    });
  }
  return name;
}

function ensureValue(value: unknown, path: string): string {
  const text = ensureString(value, path, { minLength: 0, maxLength: MAX_ENVIRONMENT_VALUE_BYTES });
  if (text.includes("\u0000")) {
    throw invalidRequest("An environment value contains a NUL character.", { field: path });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES) {
    throw invalidRequest("An environment value exceeds the byte limit.", { field: path });
  }
  return text;
}

export function parseEnvironmentBinding(value: unknown, path = "binding"): EnvironmentBinding {
  const record = ensureRecord(value, path);
  const kind = validation.ensureEnum(record["kind"], `${path}.kind`, ENVIRONMENT_BINDING_KINDS);
  if (kind === "secret") {
    ensureExactKeys(record, ["kind", "name", "secretRefFingerprint"], path);
    return Object.freeze({
      kind,
      name: ensureName(record["name"], `${path}.name`),
      secretRefFingerprint: ensureString(
        record["secretRefFingerprint"],
        `${path}.secretRefFingerprint`,
        { minLength: 64, maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "sha-256 digest" },
      ),
    });
  }
  ensureExactKeys(record, ["kind", "name", "value"], path);
  return Object.freeze({
    kind,
    name: ensureName(record["name"], `${path}.name`),
    value:
      kind === "workspace-path"
        ? parseWorkspaceRelativePath(record["value"], `${path}.value`)
        : ensureValue(record["value"], `${path}.value`),
  });
}

export function parseEnvironmentBindings(
  value: unknown,
  path = "environment",
): readonly EnvironmentBinding[] {
  const entries = validation.ensureArray(value, path, MAX_ENVIRONMENT_BINDINGS);
  const bindings = entries.map((entry, index) =>
    parseEnvironmentBinding(entry, `${path}[${index}]`),
  );
  const seen = new Set<string>();
  for (const binding of bindings) {
    // Environment names are case-insensitive on Windows. Reserve every
    // security-sensitive name case-insensitively on all platforms so one
    // portable request cannot become hostile only when it reaches Windows.
    assertRequestEnvironmentNameAllowed(binding.name);
    if (seen.has(binding.name)) {
      throw invalidRequest("Environment bindings contain a duplicate name.", {
        name: binding.name,
      });
    }
    seen.add(binding.name);
  }
  // Deterministic ordering so canonical fingerprints replay identically.
  return Object.freeze([...bindings].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

export interface WorkspaceEnvironmentPaths {
  /** Workspace-scoped temporary directory. Absolute. */
  readonly tempDir: string;
  /** Trusted empty profile directory presented to tools that insist on a home. */
  readonly homeDir: string | null;
  readonly configDir: string | null;
  readonly cacheDir: string | null;
}

export interface EnvironmentBuildInput {
  readonly bindings: readonly EnvironmentBinding[];
  readonly paths: WorkspaceEnvironmentPaths;
  /** Resolved secret values, keyed by binding name. Never logged. */
  readonly secretValues?: ReadonlyMap<string, string>;
  readonly platform?: NodeJS.Platform;
  /** Host environment consulted only for the Windows system allowlist. */
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Adds a PATH containing only the given absolute directories. */
  readonly pathEntries?: readonly string[];
}

export interface BuiltEnvironment {
  /** The exact block handed to the operating system. */
  readonly variables: Readonly<Record<string, string>>;
  /** Names only, for audit records. Values are never included. */
  readonly names: readonly string[];
  /** Secret values present in the block, for deterministic output redaction. */
  readonly secretValues: readonly string[];
}

/**
 * Builds the child environment. The result's `variables` is the complete
 * block: anything absent here is absent for the child.
 */
export function buildEnvironment(input: EnvironmentBuildInput): BuiltEnvironment {
  const platform = input.platform ?? process.platform;
  const host = input.hostEnvironment ?? process.env;
  const variables: Record<string, string> = Object.create(null) as Record<string, string>;

  // 1. Deterministic locale. Tools that emit human text stay parseable.
  variables["LANG"] = "C";
  variables["LC_ALL"] = "C";

  // 2. The minimum platform values needed to create a process.
  if (platform === "win32") {
    for (const name of WINDOWS_SYSTEM_NAMES) {
      const value = host[name];
      if (typeof value === "string" && value.length > 0 && !value.includes("\u0000")) {
        variables[name] = value;
      }
    }
  }

  // 3. Broker-owned locations. No ambient temp or profile directory.
  variables["TMPDIR"] = input.paths.tempDir;
  variables["TMP"] = input.paths.tempDir;
  variables["TEMP"] = input.paths.tempDir;
  if (input.paths.homeDir !== null) {
    if (platform === "win32") {
      variables["USERPROFILE"] = input.paths.homeDir;
    } else {
      variables["HOME"] = input.paths.homeDir;
    }
  }
  if (input.paths.configDir !== null) {
    variables["XDG_CONFIG_HOME"] = input.paths.configDir;
  }
  if (input.paths.cacheDir !== null) {
    variables["XDG_CACHE_HOME"] = input.paths.cacheDir;
  }

  // 4. An explicit PATH built only from granted directories. Never inherited.
  if (input.pathEntries !== undefined && input.pathEntries.length > 0) {
    variables["PATH"] = input.pathEntries.join(platform === "win32" ? ";" : ":");
  }

  // 5. Caller bindings last, so a permitted request value is not silently
  // overridden. Recheck the forbidden set here because buildEnvironment is a
  // public boundary and must remain safe even if a typed binding did not come
  // from parseEnvironmentBindings.
  const secretValues: string[] = [];
  for (const binding of input.bindings) {
    assertRequestEnvironmentNameAllowed(binding.name);
    if (binding.kind === "secret") {
      const value = input.secretValues?.get(binding.name);
      if (value === undefined) {
        throw new ProcessBrokerError(
          "ENVIRONMENT_REJECTED",
          "A secret environment binding was not resolved before process start.",
          { name: binding.name },
        );
      }
      variables[binding.name] = value;
      if (value.length > 0) {
        secretValues.push(value);
      }
      continue;
    }
    variables[binding.name] = binding.value;
  }

  return Object.freeze({
    variables: Object.freeze({ ...variables }),
    names: Object.freeze(Object.keys(variables).sort()),
    secretValues: Object.freeze(secretValues),
  });
}

/**
 * Names that were present in the caller's environment and deliberately not
 * passed through. Used by tests and audit to prove non-inheritance.
 */
export function strippedNames(
  hostEnvironment: Readonly<Record<string, string | undefined>>,
  built: BuiltEnvironment,
): readonly string[] {
  const kept = new Set(built.names);
  return Object.freeze(
    Object.keys(hostEnvironment)
      .filter((name) => !kept.has(name))
      .sort(),
  );
}

export function isSensitiveEnvironmentName(name: string): boolean {
  return FORBIDDEN_ENVIRONMENT_NAMES_CASE_INSENSITIVE.has(name.toUpperCase());
}
