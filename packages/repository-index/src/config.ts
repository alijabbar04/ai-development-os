/**
 * Repository-index configuration.
 *
 * Strictly schema-versioned, runtime-validated, deeply frozen, and reducible
 * to a fingerprint. The fingerprint is part of the index identity: change a
 * bound, an exclusion, or a parser selection and the resulting index is a
 * different index, not a silently different one.
 *
 * Exclusion matching is intentionally not a glob engine. Three finite forms —
 * exact path, path prefix, and base-name suffix — cover the cases that matter
 * (administrative metadata, build output, vendored trees, credential-shaped
 * files) without introducing a pattern language whose cost is unbounded.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { indexFailure, type RepositoryIndexFailure, type RepositoryIndexResult } from "./errors.js";
import { failed, ok } from "./errors.js";
import { MANIFEST_FORMAT_IDS, type ManifestFormatId } from "./manifest-formats.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnumArray,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  fail,
} = validation;

export const REPOSITORY_INDEX_CONFIG_SCHEMA_VERSION = 1 as const;

/**
 * Bumped whenever indexing output could change for identical input. Consumers
 * compare these rather than trusting that "the same code" produced two
 * indexes.
 */
export const REPOSITORY_INDEX_ALGORITHM_VERSIONS = Object.freeze({
  index: 1,
  path: 1,
  classifier: 1,
  tokenizer: 1,
  scoring: 1,
  manifest: 1,
});

export type RepositoryIndexAlgorithmVersions = typeof REPOSITORY_INDEX_ALGORITHM_VERSIONS;

export interface RepositoryIndexLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxIndexedTextBytes: number;
  readonly maxTermsPerEntry: number;
  readonly maxDistinctTerms: number;
  readonly maxPostingsPerTerm: number;
  readonly maxManifestBytes: number;
  readonly maxDependenciesPerManifest: number;
  readonly maxDiagnostics: number;
  readonly maxProcessingMs: number;
}

export const DEFAULT_REPOSITORY_INDEX_LIMITS: RepositoryIndexLimits = Object.freeze({
  maxFiles: 20_000,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 268_435_456,
  maxIndexedTextBytes: 262_144,
  maxTermsPerEntry: 2_048,
  maxDistinctTerms: 200_000,
  maxPostingsPerTerm: 4_096,
  maxManifestBytes: 1_048_576,
  maxDependenciesPerManifest: 2_048,
  maxDiagnostics: 1_000,
  maxProcessingMs: 120_000,
});

export interface ExclusionRules {
  /** Canonical paths excluded exactly. */
  readonly paths: readonly string[];
  /** Canonical path prefixes; a prefix matches the directory and everything under it. */
  readonly directories: readonly string[];
  /** Lowercase base-name suffixes, for example ".min.js" or ".pem". */
  readonly nameSuffixes: readonly string[];
}

/**
 * Deliberately conservative defaults. Administrative metadata and anything
 * credential-shaped is excluded before it is ever read, so a stray key file
 * cannot reach a context pack through the index.
 */
export const DEFAULT_EXCLUSION_RULES: ExclusionRules = Object.freeze({
  paths: Object.freeze([
    ".env",
    ".env.local",
    ".netrc",
    ".npmrc",
    "_netrc",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
  ]),
  directories: Object.freeze([
    ".bzr",
    ".git",
    ".hg",
    ".svn",
    ".yarn/cache",
    "bower_components",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
  ]),
  nameSuffixes: Object.freeze([
    ".asc",
    ".bundle.js",
    ".jks",
    ".key",
    ".keystore",
    ".map",
    ".min.css",
    ".min.js",
    ".p12",
    ".pem",
    ".pfx",
    ".ppk",
  ]),
});

export interface RepositoryIndexConfiguration {
  readonly schemaVersion: typeof REPOSITORY_INDEX_CONFIG_SCHEMA_VERSION;
  readonly limits: RepositoryIndexLimits;
  readonly exclusions: ExclusionRules;
  /** Manifest formats this index is permitted to parse. Nothing else is attempted. */
  readonly manifestFormats: readonly ManifestFormatId[];
  /** When false, symlink and submodule entries are dropped rather than recorded as metadata. */
  readonly recordLinkMetadata: boolean;
  /** When false, binary and undecodable files are recorded by metadata only. */
  readonly indexBinaryMetadata: boolean;
}

const CONFIG_KEYS = [
  "schemaVersion",
  "limits",
  "exclusions",
  "manifestFormats",
  "recordLinkMetadata",
  "indexBinaryMetadata",
] as const;

const LIMIT_BOUNDS: Readonly<Record<keyof RepositoryIndexLimits, readonly [number, number]>> =
  Object.freeze({
    maxFiles: [1, 200_000],
    maxFileBytes: [1, 67_108_864],
    maxTotalBytes: [1, 4_294_967_296],
    maxIndexedTextBytes: [1, 16_777_216],
    maxTermsPerEntry: [1, 65_536],
    maxDistinctTerms: [1, 5_000_000],
    maxPostingsPerTerm: [1, 200_000],
    maxManifestBytes: [1, 16_777_216],
    maxDependenciesPerManifest: [1, 65_536],
    maxDiagnostics: [1, 100_000],
    maxProcessingMs: [1, 3_600_000],
  });

const SAFE_RULE_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;

function parseRuleList(value: unknown, path: string, maxItems: number): readonly string[] {
  const items = ensureArray(value, path, maxItems).map((item, index) => {
    const rule = ensureString(item, `${path}[${index}]`, {
      maxLength: 255,
      pattern: SAFE_RULE_PATTERN,
      patternName: "exclusion rule",
    });
    // An exclusion rule is matched against canonical paths, which can never
    // contain a traversal segment. A rule that does is a configuration
    // mistake at best and an attempt to widen the read surface at worst.
    if (rule.split("/").some((segment) => segment === "." || segment === "..")) {
      fail(`${path}[${index}]`, "traversal_rule", "cannot contain '.' or '..' segments.");
    }
    return rule;
  });
  return Object.freeze([...new Set(items)].sort());
}

function parseLimits(value: unknown, path: string): RepositoryIndexLimits {
  const record = ensureRecord(value, path);
  const keys = Object.keys(LIMIT_BOUNDS) as (keyof RepositoryIndexLimits)[];
  ensureExactKeys(record, keys, path);
  const result: Record<string, number> = {};
  for (const key of keys) {
    const bounds = LIMIT_BOUNDS[key];
    result[key] = ensureSafeInteger(record[key], `${path}.${key}`, bounds[0], bounds[1]);
  }
  const limits = Object.freeze(result) as unknown as RepositoryIndexLimits;
  if (limits.maxIndexedTextBytes > limits.maxFileBytes) {
    fail(`${path}.maxIndexedTextBytes`, "inconsistent_limits", "cannot exceed maxFileBytes.");
  }
  if (limits.maxManifestBytes > limits.maxFileBytes) {
    fail(`${path}.maxManifestBytes`, "inconsistent_limits", "cannot exceed maxFileBytes.");
  }
  return limits;
}

function parseExclusions(value: unknown, path: string): ExclusionRules {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["paths", "directories", "nameSuffixes"], path);
  const nameSuffixes = parseRuleList(record["nameSuffixes"], `${path}.nameSuffixes`, 256).map(
    (suffix) => suffix.toLowerCase(),
  );
  return Object.freeze({
    paths: parseRuleList(record["paths"], `${path}.paths`, 512),
    directories: parseRuleList(record["directories"], `${path}.directories`, 512),
    nameSuffixes: Object.freeze([...new Set(nameSuffixes)].sort()),
  });
}

function parseStrict(value: unknown, path: string): RepositoryIndexConfiguration {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, CONFIG_KEYS, path);
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    REPOSITORY_INDEX_CONFIG_SCHEMA_VERSION,
  );
  return Object.freeze({
    schemaVersion: REPOSITORY_INDEX_CONFIG_SCHEMA_VERSION,
    limits: parseLimits(record["limits"], `${path}.limits`),
    exclusions: parseExclusions(record["exclusions"], `${path}.exclusions`),
    manifestFormats: ensureEnumArray(
      record["manifestFormats"],
      `${path}.manifestFormats`,
      MANIFEST_FORMAT_IDS,
      MANIFEST_FORMAT_IDS.length,
    ),
    recordLinkMetadata: ensureBoolean(record["recordLinkMetadata"], `${path}.recordLinkMetadata`),
    indexBinaryMetadata: ensureBoolean(record["indexBinaryMetadata"], `${path}.indexBinaryMetadata`),
  });
}

export const DEFAULT_REPOSITORY_INDEX_CONFIGURATION: RepositoryIndexConfiguration = parseStrict(
  {
    schemaVersion: REPOSITORY_INDEX_CONFIG_SCHEMA_VERSION,
    limits: DEFAULT_REPOSITORY_INDEX_LIMITS,
    exclusions: DEFAULT_EXCLUSION_RULES,
    manifestFormats: [...MANIFEST_FORMAT_IDS],
    recordLinkMetadata: true,
    indexBinaryMetadata: true,
  },
  "compiledDefaults",
);

/**
 * Validates configuration. Returns a failure variant rather than throwing:
 * invalid configuration is an expected outcome for a caller assembling
 * settings from layered sources.
 */
export function parseRepositoryIndexConfiguration(
  value: unknown,
  path = "repositoryIndexConfiguration",
): RepositoryIndexResult<RepositoryIndexConfiguration> {
  try {
    return ok(parseStrict(value, path));
  } catch (error) {
    return failed<RepositoryIndexConfiguration>(configurationFailure(error));
  }
}

function configurationFailure(error: unknown): RepositoryIndexFailure {
  const issues =
    error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? (error.issues as readonly { readonly code?: unknown; readonly path?: unknown }[])
      : [];
  const unsupportedVersion = issues.some((issue) => issue.code === "unsupported_schema_version");
  const paths = Object.freeze(
    issues
      .map((issue) => (typeof issue.path === "string" ? issue.path : "?"))
      .slice(0, 16)
      .sort(),
  );
  return indexFailure(
    unsupportedVersion ? "UNSUPPORTED_SCHEMA_VERSION" : "INVALID_CONFIGURATION",
    unsupportedVersion
      ? "The repository-index configuration schema version is unsupported."
      : "The repository-index configuration is invalid.",
    { issueCount: issues.length, issuePaths: paths },
  );
}

/** Deep merge is deliberately absent: a partial override replaces whole sections. */
export function withRepositoryIndexOverrides(
  base: RepositoryIndexConfiguration,
  overrides: {
    readonly limits?: Partial<RepositoryIndexLimits>;
    readonly exclusions?: Partial<ExclusionRules>;
    readonly manifestFormats?: readonly ManifestFormatId[];
    readonly recordLinkMetadata?: boolean;
    readonly indexBinaryMetadata?: boolean;
  },
): RepositoryIndexResult<RepositoryIndexConfiguration> {
  return parseRepositoryIndexConfiguration({
    schemaVersion: REPOSITORY_INDEX_CONFIG_SCHEMA_VERSION,
    limits: { ...base.limits, ...overrides.limits },
    exclusions: { ...base.exclusions, ...overrides.exclusions },
    manifestFormats: overrides.manifestFormats ?? base.manifestFormats,
    recordLinkMetadata: overrides.recordLinkMetadata ?? base.recordLinkMetadata,
    indexBinaryMetadata: overrides.indexBinaryMetadata ?? base.indexBinaryMetadata,
  });
}

/**
 * Binds the configuration *and* the algorithm versions. Two indexes with the
 * same configuration fingerprint were produced by the same rules.
 */
export function repositoryIndexConfigurationFingerprint(
  configuration: RepositoryIndexConfiguration,
): string {
  return createHash("sha256")
    .update(
      toCanonicalJson({
        algorithms: REPOSITORY_INDEX_ALGORITHM_VERSIONS,
        configuration,
      }),
      "utf8",
    )
    .digest("hex");
}

/** True when the entry is excluded by configuration and must never be read. */
export function isExcludedPath(
  canonicalPath: string,
  exclusions: ExclusionRules,
): boolean {
  if (exclusions.paths.includes(canonicalPath)) {
    return true;
  }
  for (const directory of exclusions.directories) {
    if (canonicalPath === directory || canonicalPath.startsWith(`${directory}/`)) {
      return true;
    }
  }
  const lower = canonicalPath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  for (const suffix of exclusions.nameSuffixes) {
    if (base.length > suffix.length && base.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}
