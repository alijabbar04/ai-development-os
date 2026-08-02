/**
 * Stage 9 adapter configuration.
 *
 * The configuration is versioned, validated at runtime, and deeply immutable.
 * It states exactly which executable may run, which models and effort levels
 * may be requested, and what the finite ceilings on turns, budget, time,
 * output, and stream size are.
 *
 * Several things are deliberately unrepresentable rather than merely defaulted
 * off: an arbitrary CLI argument array, a shell command string, a permission
 * bypass mode, Chrome, ambient MCP or hooks, and any inline credential. There
 * is no field that turns them on, so no configuration file can enable them.
 *
 * Monetary caps are integer micro-dollars. The adapter never performs
 * floating-point arithmetic on money; the only float that exists is the one
 * Claude reports, which is converted once, defensively, at the boundary.
 */

import { DATA_CLASSIFICATIONS, validation, type DataClassification } from "@ai-dev-os/domain";
import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { invalidConfigurationError } from "./errors.js";
import { ProviderError } from "@ai-dev-os/providers";

const {
  ensureArray,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
} = validation;

export const CLAUDE_ADAPTER_SCHEMA_VERSION = 1 as const;
export const CLAUDE_EXTENSION_NAMESPACE = "claude-code";
export const CLAUDE_PROVIDER_ID = "claude-code";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * Model identifiers and aliases. A leading `-` is impossible by construction,
 * so a model value can never be read by the CLI as a flag, and control
 * characters are excluded by the character class.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MICROS_PER_DOLLAR = 1_000_000;

export const MAX_BUDGET_MICROS = 1_000_000_000; // 1,000 USD, integer micros.
export const MAX_PERMITTED_MODELS = 32;
export const MAX_TURN_CAP = 200;

/** Effort levels the documented CLI accepts for `--effort`. */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/**
 * How this deployment authenticates. The adapter never handles credential
 * material: it only records which mechanism the composition layer arranged, so
 * a session can be refused before launch when the mechanism is not
 * distributable.
 */
export const CLAUDE_AUTHENTICATION_MODES = Object.freeze([
  "api-key-secret-ref",
  "cloud-provider-credential",
  "enterprise-gateway",
  "personal-local-cli-login",
] as const);
export type ClaudeAuthenticationMode = (typeof CLAUDE_AUTHENTICATION_MODES)[number];

/**
 * Whether the deployment is a distributable product surface. Personal
 * installed-CLI login is permitted only for the explicitly personal,
 * local, opt-in development canary; it is never a distributable mechanism.
 */
export function isDistributableAuthentication(mode: ClaudeAuthenticationMode): boolean {
  return mode !== "personal-local-cli-login";
}

export const CLAUDE_SESSION_PERSISTENCE_POLICIES = Object.freeze([
  "never",
  "explicit-continuation-only",
] as const);
export type ClaudeSessionPersistencePolicy = (typeof CLAUDE_SESSION_PERSISTENCE_POLICIES)[number];

export const CLAUDE_TOOL_PLATFORMS = Object.freeze(["win32", "darwin", "linux"] as const);
export const CLAUDE_TOOL_ARCHITECTURES = Object.freeze(["x64", "arm64"] as const);

/**
 * The trusted executable. There is no name to look up: the composition layer
 * supplies an absolute path to a real image, and on Windows a `.cmd`/`.bat`
 * shim is refused here as well as by the process broker.
 */
export interface ClaudeExecutableDescriptor {
  readonly toolId: string;
  readonly executablePath: string;
  readonly platform: (typeof CLAUDE_TOOL_PLATFORMS)[number];
  readonly architecture: (typeof CLAUDE_TOOL_ARCHITECTURES)[number];
  /** Lowercase sha-256 hex of the image, when the deployment pins one. */
  readonly expectedDigestHex: string | null;
  /** Backend-supplied immutable reference, when a secure backend provides one. */
  readonly immutableReference: string | null;
  /** Absolute directory the resolved image must stay inside, when required. */
  readonly containmentRoot: string | null;
  /**
   * Pinned argv prefix, used when the entry point is a script that must run
   * under a trusted interpreter. The adapter appends only its own finite
   * argument vector after this prefix.
   */
  readonly pinnedLeadingArguments: readonly string[] | null;
}

export interface ClaudeAdapterConfiguration {
  readonly schemaVersion: typeof CLAUDE_ADAPTER_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly executable: ClaudeExecutableDescriptor;
  /** Minimum CLI version accepted, as `major.minor.patch`. */
  readonly minimumCliVersion: string;
  /** Highest CLI version this compatibility matrix was validated against. */
  readonly validatedCliVersion: string;
  /** Model IDs or aliases callers may request. Empty means none may be named. */
  readonly permittedModels: readonly string[];
  readonly defaultModel: string | null;
  readonly permittedEffortLevels: readonly ClaudeEffortLevel[];
  readonly defaultEffort: ClaudeEffortLevel | null;
  readonly maxTurns: number;
  /** Hard monetary ceiling in integer micro-dollars. */
  readonly maxBudgetMicros: number;
  readonly processDeadlineMs: number;
  readonly operationDeadlineMs: number;
  readonly maxOutputBytes: number;
  readonly maxRecordBytes: number;
  readonly maxStreamBytes: number;
  readonly maxRecordCount: number;
  readonly maxDiagnosticBytes: number;
  readonly maxPatchBytes: number;
  readonly sessionPersistence: ClaudeSessionPersistencePolicy;
  /** Age at which a capacity observation stops being reportable as current. */
  readonly capacityStalenessMs: number;
  readonly authenticationMode: ClaudeAuthenticationMode;
  readonly supportedClassifications: readonly DataClassification[];
  /** Where the Claude service endpoint sits, for later routing decisions. */
  readonly endpointClassification: "anthropic-first-party" | "cloud-provider" | "enterprise-gateway";
  /**
   * Workspace-relative machine-readable test report the adapter reads as
   * verifiable evidence after a run. Null disables structured test results.
   */
  readonly testReportPath: string | null;
}

const CONFIGURATION_KEYS = [
  "schemaVersion",
  "instanceId",
  "executable",
  "minimumCliVersion",
  "validatedCliVersion",
  "permittedModels",
  "defaultModel",
  "permittedEffortLevels",
  "defaultEffort",
  "maxTurns",
  "maxBudgetMicros",
  "processDeadlineMs",
  "operationDeadlineMs",
  "maxOutputBytes",
  "maxRecordBytes",
  "maxStreamBytes",
  "maxRecordCount",
  "maxDiagnosticBytes",
  "maxPatchBytes",
  "sessionPersistence",
  "capacityStalenessMs",
  "authenticationMode",
  "supportedClassifications",
  "endpointClassification",
  "testReportPath",
] as const;

const EXECUTABLE_KEYS = [
  "toolId",
  "executablePath",
  "platform",
  "architecture",
  "expectedDigestHex",
  "immutableReference",
  "containmentRoot",
  "pinnedLeadingArguments",
] as const;

/**
 * Field names that would carry credential material. Their presence anywhere in
 * the configuration is a rejection, not a warning: an adapter that silently
 * ignored an `apiKey` field would still have accepted a document that put one
 * on disk.
 */
const CREDENTIAL_LIKE_KEYS: ReadonlySet<string> = Object.freeze(
  new Set([
    "apikey",
    "api_key",
    "apikeyhelper",
    "authtoken",
    "auth_token",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "bearertoken",
    "credential",
    "credentials",
    "credentialsfile",
    "oauth",
    "oauthtoken",
    "password",
    "secret",
    "sessioncookie",
    "sessionkey",
    "token",
    "anthropic_api_key",
    "claude_code_oauth_token",
  ]),
);

/**
 * Field names that would re-enable a capability this stage refuses to
 * represent. Rejecting the names keeps "unrepresentable" true against a
 * configuration document written by hand.
 */
const FORBIDDEN_CAPABILITY_KEYS: ReadonlySet<string> = Object.freeze(
  new Set([
    "additionalarguments",
    "extraarguments",
    "args",
    "argv",
    "rawarguments",
    "shell",
    "command",
    "commandline",
    "allowdangerouslyskippermissions",
    "dangerouslyskippermissions",
    "bypasspermissions",
    "permissionmode",
    "automode",
    "chrome",
    "mcpconfig",
    "mcpservers",
    "hooks",
    "plugins",
    "pluginurl",
    "plugindir",
    "settings",
    "settingsources",
    "agents",
    "advisor",
    "fallbackmode",
    "fallbackmodel",
    "systemprompt",
    "appendsystemprompt",
    "continue",
  ]),
);

function assertNoForbiddenKeys(record: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(record)) {
    const folded = key.replace(/[-_\s]/g, "").toLowerCase();
    if (CREDENTIAL_LIKE_KEYS.has(folded) || CREDENTIAL_LIKE_KEYS.has(key.toLowerCase())) {
      throw invalidConfigurationError("configuration-invalid", { field: path, reason: "inline-credential" });
    }
    if (FORBIDDEN_CAPABILITY_KEYS.has(folded)) {
      throw invalidConfigurationError("configuration-invalid", {
        field: path,
        reason: "forbidden-capability",
      });
    }
  }
}

const VERSION_PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** Parses `major.minor.patch` into comparable components. */
export function parseCliVersion(value: string): readonly [number, number, number] | null {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return [major, minor, patch] as const;
}

export function compareCliVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = parseCliVersion(left);
  const b = parseCliVersion(right);
  if (a === null || b === null) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    const lhs = a[index] ?? 0;
    const rhs = b[index] ?? 0;
    if (lhs < rhs) {
      return -1;
    }
    if (lhs > rhs) {
      return 1;
    }
  }
  return 0;
}

function ensureVersion(value: unknown, path: string): string {
  const text = ensureString(value, path, { maxLength: 32 });
  if (parseCliVersion(text) === null) {
    throw invalidConfigurationError("configuration-invalid", { field: path, reason: "bad-version" });
  }
  return text;
}

function ensureModelValue(value: unknown, path: string): string {
  const text = ensureString(value, path, {
    maxLength: 64,
    pattern: MODEL_PATTERN,
    patternName: "Claude model identifier or alias",
  });
  return text;
}

function ensureAbsolutePath(value: unknown, path: string): string {
  const text = ensureString(value, path, { maxLength: 1_024 });
  if (text.includes("\u0000")) {
    throw invalidConfigurationError("configuration-invalid", { field: path, reason: "nul-character" });
  }
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
  const posixAbsolute = text.startsWith("/");
  if (!windowsAbsolute && !posixAbsolute) {
    throw invalidConfigurationError("executable-not-absolute", { field: path });
  }
  return text;
}

/** Windows command-script shims only work through a shell and are refused. */
export const WINDOWS_SHELL_SHIM_PATTERN = /\.(cmd|bat)$/i;

function parseExecutable(value: unknown, path: string): ClaudeExecutableDescriptor {
  const record = ensureRecord(value, path);
  assertNoForbiddenKeys(record, path);
  ensureExactKeys(record, EXECUTABLE_KEYS, path);
  const platform = ensureEnum(record["platform"], `${path}.platform`, CLAUDE_TOOL_PLATFORMS);
  const executablePath = ensureAbsolutePath(record["executablePath"], `${path}.executablePath`);
  if (platform === "win32" && WINDOWS_SHELL_SHIM_PATTERN.test(executablePath)) {
    throw invalidConfigurationError("executable-shell-shim", { field: `${path}.executablePath` });
  }
  const digest = record["expectedDigestHex"];
  const immutable = record["immutableReference"];
  const containment = record["containmentRoot"];
  const pinned = record["pinnedLeadingArguments"];
  return Object.freeze({
    toolId: ensureString(record["toolId"], `${path}.toolId`, {
      maxLength: 64,
      pattern: /^[a-z][a-z0-9._-]{0,63}$/,
      patternName: "tool identifier",
    }),
    executablePath,
    platform,
    architecture: ensureEnum(record["architecture"], `${path}.architecture`, CLAUDE_TOOL_ARCHITECTURES),
    expectedDigestHex:
      digest === undefined || digest === null
        ? null
        : ensureString(digest, `${path}.expectedDigestHex`, {
            minLength: 64,
            maxLength: 64,
            pattern: /^[a-f0-9]{64}$/,
            patternName: "lowercase sha-256 digest",
          }),
    immutableReference:
      immutable === undefined || immutable === null
        ? null
        : ensureString(immutable, `${path}.immutableReference`, { maxLength: 256 }),
    containmentRoot:
      containment === undefined || containment === null
        ? null
        : ensureAbsolutePath(containment, `${path}.containmentRoot`),
    pinnedLeadingArguments:
      pinned === undefined || pinned === null
        ? null
        : Object.freeze(
            ensureArray(pinned, `${path}.pinnedLeadingArguments`, 8).map((entry, index) =>
              ensureAbsoluteOrPlainArgument(entry, `${path}.pinnedLeadingArguments[${index}]`),
            ),
          ),
  });
}

/**
 * A pinned prefix entry is either an absolute path (a script entry point) or a
 * plain non-option token. It can never introduce a caller-controlled flag.
 */
function ensureAbsoluteOrPlainArgument(value: unknown, path: string): string {
  const text = ensureString(value, path, { maxLength: 1_024 });
  if (text.startsWith("-")) {
    throw invalidConfigurationError("configuration-invalid", { field: path, reason: "option-argument" });
  }
  // eslint-disable-next-line no-control-regex -- control characters are the thing being rejected.
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw invalidConfigurationError("configuration-invalid", { field: path, reason: "control-character" });
  }
  return text;
}

function ensureRelativeReportPath(value: unknown, path: string): string {
  const text = ensureString(value, path, { maxLength: 256 });
  if (
    text.includes("\\") ||
    text.startsWith("/") ||
    text.endsWith("/") ||
    /^[A-Za-z]:/.test(text) ||
    // eslint-disable-next-line no-control-regex -- control characters are the thing being rejected.
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw invalidConfigurationError("configuration-invalid", { field: path, reason: "unsafe-path" });
  }
  for (const segment of text.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw invalidConfigurationError("configuration-invalid", { field: path, reason: "unsafe-path" });
    }
  }
  return text;
}

export function parseClaudeAdapterConfiguration(
  value: unknown,
  path = "claudeConfiguration",
): ClaudeAdapterConfiguration {
  try {
    const record = ensureRecord(value, path);
    assertNoForbiddenKeys(record, path);
    ensureExactKeys(record, CONFIGURATION_KEYS, path);
    ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, CLAUDE_ADAPTER_SCHEMA_VERSION);

    const permittedModels = Object.freeze([
      ...new Set(
        ensureArray(record["permittedModels"], `${path}.permittedModels`, MAX_PERMITTED_MODELS).map(
          (entry, index) => ensureModelValue(entry, `${path}.permittedModels[${index}]`),
        ),
      ),
    ]);
    const defaultModelValue = record["defaultModel"];
    const defaultModel =
      defaultModelValue === undefined || defaultModelValue === null
        ? null
        : ensureModelValue(defaultModelValue, `${path}.defaultModel`);
    if (defaultModel !== null && !permittedModels.includes(defaultModel)) {
      throw invalidConfigurationError("model-not-permitted", { field: `${path}.defaultModel` });
    }

    const permittedEffortLevels = ensureEnumArray(
      record["permittedEffortLevels"],
      `${path}.permittedEffortLevels`,
      CLAUDE_EFFORT_LEVELS,
      CLAUDE_EFFORT_LEVELS.length,
    );
    const defaultEffortValue = record["defaultEffort"];
    const defaultEffort =
      defaultEffortValue === undefined || defaultEffortValue === null
        ? null
        : ensureEnum(defaultEffortValue, `${path}.defaultEffort`, CLAUDE_EFFORT_LEVELS);
    if (defaultEffort !== null && !permittedEffortLevels.includes(defaultEffort)) {
      throw invalidConfigurationError("effort-not-permitted", { field: `${path}.defaultEffort` });
    }

    const maxRecordBytes = ensureSafeInteger(record["maxRecordBytes"], `${path}.maxRecordBytes`, 1_024, 4_194_304);
    const maxStreamBytes = ensureSafeInteger(
      record["maxStreamBytes"],
      `${path}.maxStreamBytes`,
      maxRecordBytes,
      268_435_456,
    );
    const maxOutputBytes = ensureSafeInteger(
      record["maxOutputBytes"],
      `${path}.maxOutputBytes`,
      maxRecordBytes,
      268_435_456,
    );
    const processDeadlineMs = ensureSafeInteger(
      record["processDeadlineMs"],
      `${path}.processDeadlineMs`,
      1_000,
      86_400_000,
    );
    const operationDeadlineMs = ensureSafeInteger(
      record["operationDeadlineMs"],
      `${path}.operationDeadlineMs`,
      processDeadlineMs,
      86_400_000,
    );
    const reportPath = record["testReportPath"];

    return Object.freeze({
      schemaVersion: CLAUDE_ADAPTER_SCHEMA_VERSION,
      instanceId: ensureString(record["instanceId"], `${path}.instanceId`, {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "ProviderInstanceId",
      }),
      executable: parseExecutable(record["executable"], `${path}.executable`),
      minimumCliVersion: ensureVersion(record["minimumCliVersion"], `${path}.minimumCliVersion`),
      validatedCliVersion: ensureVersion(record["validatedCliVersion"], `${path}.validatedCliVersion`),
      permittedModels,
      defaultModel,
      permittedEffortLevels,
      defaultEffort,
      maxTurns: ensureSafeInteger(record["maxTurns"], `${path}.maxTurns`, 1, MAX_TURN_CAP),
      maxBudgetMicros: ensureSafeInteger(
        record["maxBudgetMicros"],
        `${path}.maxBudgetMicros`,
        0,
        MAX_BUDGET_MICROS,
      ),
      processDeadlineMs,
      operationDeadlineMs,
      maxOutputBytes,
      maxRecordBytes,
      maxStreamBytes,
      maxRecordCount: ensureSafeInteger(record["maxRecordCount"], `${path}.maxRecordCount`, 1, 200_000),
      maxDiagnosticBytes: ensureSafeInteger(
        record["maxDiagnosticBytes"],
        `${path}.maxDiagnosticBytes`,
        512,
        4_194_304,
      ),
      maxPatchBytes: ensureSafeInteger(record["maxPatchBytes"], `${path}.maxPatchBytes`, 1_024, 268_435_456),
      sessionPersistence: ensureEnum(
        record["sessionPersistence"],
        `${path}.sessionPersistence`,
        CLAUDE_SESSION_PERSISTENCE_POLICIES,
      ),
      capacityStalenessMs: ensureSafeInteger(
        record["capacityStalenessMs"],
        `${path}.capacityStalenessMs`,
        1_000,
        86_400_000,
      ),
      authenticationMode: ensureEnum(
        record["authenticationMode"],
        `${path}.authenticationMode`,
        CLAUDE_AUTHENTICATION_MODES,
      ),
      supportedClassifications: ensureEnumArray(
        record["supportedClassifications"],
        `${path}.supportedClassifications`,
        DATA_CLASSIFICATIONS,
        DATA_CLASSIFICATIONS.length,
      ),
      endpointClassification: ensureEnum(record["endpointClassification"], `${path}.endpointClassification`, [
        "anthropic-first-party",
        "cloud-provider",
        "enterprise-gateway",
      ] as const),
      testReportPath:
        reportPath === undefined || reportPath === null
          ? null
          : ensureRelativeReportPath(reportPath, `${path}.testReportPath`),
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof Error && error.name === "ValidationError") {
      const issues = (error as { issues?: readonly { code?: string; path?: string }[] }).issues;
      const issue = issues?.[0];
      throw invalidConfigurationError("configuration-invalid", {
        reason: issue?.code ?? "invalid",
        field: issue?.path ?? path,
      });
    }
    throw invalidConfigurationError("configuration-invalid", { reason: "unparseable" });
  }
}

export interface ClaudeAdapterConfigurationInput {
  readonly instanceId: string;
  readonly executable: ClaudeExecutableDescriptor | Record<string, unknown>;
  readonly minimumCliVersion?: string;
  readonly validatedCliVersion?: string;
  readonly permittedModels?: readonly string[];
  readonly defaultModel?: string | null;
  readonly permittedEffortLevels?: readonly ClaudeEffortLevel[];
  readonly defaultEffort?: ClaudeEffortLevel | null;
  readonly maxTurns?: number;
  readonly maxBudgetMicros?: number;
  readonly processDeadlineMs?: number;
  readonly operationDeadlineMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxStreamBytes?: number;
  readonly maxRecordCount?: number;
  readonly maxDiagnosticBytes?: number;
  readonly maxPatchBytes?: number;
  readonly sessionPersistence?: ClaudeSessionPersistencePolicy;
  readonly capacityStalenessMs?: number;
  readonly authenticationMode?: ClaudeAuthenticationMode;
  readonly supportedClassifications?: readonly DataClassification[];
  readonly endpointClassification?: ClaudeAdapterConfiguration["endpointClassification"];
  readonly testReportPath?: string | null;
}

/**
 * The compatibility floor. 2.1.201 is the version this matrix was written and
 * verified against; every flag the adapter sends was confirmed present in that
 * CLI's own `--help` output rather than assumed from documentation.
 */
export const DEFAULT_MINIMUM_CLI_VERSION = "2.1.100";
export const DEFAULT_VALIDATED_CLI_VERSION = "2.1.201";

export function createClaudeAdapterConfiguration(
  input: ClaudeAdapterConfigurationInput,
): ClaudeAdapterConfiguration {
  return parseClaudeAdapterConfiguration({
    schemaVersion: CLAUDE_ADAPTER_SCHEMA_VERSION,
    instanceId: input.instanceId,
    executable: input.executable,
    minimumCliVersion: input.minimumCliVersion ?? DEFAULT_MINIMUM_CLI_VERSION,
    validatedCliVersion: input.validatedCliVersion ?? DEFAULT_VALIDATED_CLI_VERSION,
    permittedModels: input.permittedModels ?? [],
    defaultModel: input.defaultModel ?? null,
    permittedEffortLevels: input.permittedEffortLevels ?? [],
    defaultEffort: input.defaultEffort ?? null,
    maxTurns: input.maxTurns ?? 12,
    maxBudgetMicros: input.maxBudgetMicros ?? 0,
    processDeadlineMs: input.processDeadlineMs ?? 900_000,
    operationDeadlineMs: input.operationDeadlineMs ?? 1_200_000,
    maxOutputBytes: input.maxOutputBytes ?? 8_388_608,
    maxRecordBytes: input.maxRecordBytes ?? 1_048_576,
    maxStreamBytes: input.maxStreamBytes ?? 8_388_608,
    maxRecordCount: input.maxRecordCount ?? 20_000,
    maxDiagnosticBytes: input.maxDiagnosticBytes ?? 65_536,
    maxPatchBytes: input.maxPatchBytes ?? 4_194_304,
    sessionPersistence: input.sessionPersistence ?? "never",
    capacityStalenessMs: input.capacityStalenessMs ?? 300_000,
    authenticationMode: input.authenticationMode ?? "api-key-secret-ref",
    supportedClassifications: input.supportedClassifications ?? ["public", "internal"],
    endpointClassification: input.endpointClassification ?? "anthropic-first-party",
    testReportPath: input.testReportPath ?? null,
  });
}

/**
 * Consumes the Stage 6 extension array structurally, without depending on
 * `@ai-dev-os/config`. Foreign namespaces are skipped; the owned namespace is
 * version-pinned; and an extension may not restate identity or the executable,
 * because those are trusted composition inputs rather than user settings.
 */
export function resolveClaudeConfiguration(options: {
  readonly instanceId: string;
  readonly executable: ClaudeExecutableDescriptor | Record<string, unknown>;
  readonly extensions?: unknown;
}): ClaudeAdapterConfiguration {
  let settings: Record<string, unknown> = {};
  if (options.extensions !== undefined && options.extensions !== null) {
    const entries = ensureArray(options.extensions, "extensions", 16);
    for (const [index, entry] of entries.entries()) {
      const record = ensureRecord(entry, `extensions[${index}]`);
      ensureExactKeys(record, ["namespace", "schemaVersion", "value"], `extensions[${index}]`);
      if (record["namespace"] !== CLAUDE_EXTENSION_NAMESPACE) {
        continue;
      }
      ensureSchemaVersion(
        record["schemaVersion"],
        `extensions[${index}].schemaVersion`,
        CLAUDE_ADAPTER_SCHEMA_VERSION,
      );
      settings = ensureRecord(record["value"], `extensions[${index}].value`);
      break;
    }
  }
  for (const key of ["schemaVersion", "instanceId", "executable"]) {
    if (key in settings) {
      throw invalidConfigurationError("configuration-invalid", {
        reason: "extension-overrides-trusted-field",
        field: key,
      });
    }
  }
  assertNoForbiddenKeys(settings, "extensions.value");
  try {
    return createClaudeAdapterConfiguration({
      instanceId: options.instanceId,
      executable: options.executable,
      ...(settings as Omit<ClaudeAdapterConfigurationInput, "instanceId" | "executable">),
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    throw invalidConfigurationError("configuration-invalid", { reason: "malformed-extension-value" });
  }
}

/**
 * Canonical fingerprint over the configuration's meaning. Volatile health,
 * capacity, and probe data are excluded, and there is no secret value in the
 * configuration to exclude — the authentication mode is a category, not a
 * credential.
 */
export function claudeConfigurationFingerprint(configuration: ClaudeAdapterConfiguration): string {
  return createHash("sha256")
    .update(
      toCanonicalJson({
        kind: "claude-code-adapter-configuration",
        version: CLAUDE_ADAPTER_SCHEMA_VERSION,
        instanceId: configuration.instanceId,
        executable: {
          toolId: configuration.executable.toolId,
          expectedDigestHex: configuration.executable.expectedDigestHex,
          immutableReference: configuration.executable.immutableReference,
          platform: configuration.executable.platform,
          architecture: configuration.executable.architecture,
          pinnedArgumentCount: configuration.executable.pinnedLeadingArguments?.length ?? 0,
        },
        minimumCliVersion: configuration.minimumCliVersion,
        validatedCliVersion: configuration.validatedCliVersion,
        permittedModels: [...configuration.permittedModels].sort(),
        defaultModel: configuration.defaultModel,
        permittedEffortLevels: [...configuration.permittedEffortLevels].sort(),
        defaultEffort: configuration.defaultEffort,
        maxTurns: configuration.maxTurns,
        maxBudgetMicros: configuration.maxBudgetMicros,
        processDeadlineMs: configuration.processDeadlineMs,
        operationDeadlineMs: configuration.operationDeadlineMs,
        maxOutputBytes: configuration.maxOutputBytes,
        maxRecordBytes: configuration.maxRecordBytes,
        maxStreamBytes: configuration.maxStreamBytes,
        maxRecordCount: configuration.maxRecordCount,
        maxDiagnosticBytes: configuration.maxDiagnosticBytes,
        maxPatchBytes: configuration.maxPatchBytes,
        sessionPersistence: configuration.sessionPersistence,
        authenticationMode: configuration.authenticationMode,
        supportedClassifications: [...configuration.supportedClassifications].sort(),
        endpointClassification: configuration.endpointClassification,
        testReportPath: configuration.testReportPath,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Converts a provider-reported floating-point dollar amount into integer
 * micro-dollars, refusing anything that is not a finite, non-negative,
 * representable value. Rounding is half-up at the micro, and the result is
 * capped so an absurd report cannot overflow downstream arithmetic.
 */
export function dollarsToMicros(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const micros = Math.round(value * MICROS_PER_DOLLAR);
  if (!Number.isSafeInteger(micros) || micros > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return micros;
}

/** Converts integer micro-dollars into the CLI's decimal dollar argument. */
export function microsToBudgetArgument(micros: number): string {
  const whole = Math.floor(micros / MICROS_PER_DOLLAR);
  const fraction = micros % MICROS_PER_DOLLAR;
  return `${whole}.${fraction.toString().padStart(6, "0")}`;
}
