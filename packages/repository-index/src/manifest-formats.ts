/**
 * Manifest and dependency extraction.
 *
 * The parser registry is finite and closed. There is no plugin mechanism, no
 * dynamic `require`, and no fallback "try to guess the format" path: a file
 * the registry does not name is simply not a manifest as far as this package
 * is concerned. Nothing here executes a manifest, a script, a lockfile hook,
 * a template, or a package manager; every supported format is read as inert
 * data.
 *
 * The four states a manifest can be in are kept distinct on purpose:
 *
 * - what a *manifest declares* (`source: "manifest"`)
 * - what a *lockfile records* (`source: "lockfile"`)
 * - what exists as a *workspace member* (`source: "workspace-member"`)
 * - what is *unresolved or unsupported* (`kind: "unresolved"`, or a
 *   `manifest-unsupported` / `manifest-partial` diagnostic)
 *
 * A partial result is only ever emitted alongside a diagnostic that says so,
 * and `status` never reads `parsed` when anything was skipped.
 */

import { parseJsonText, type JsonObject, type JsonValue } from "@ai-dev-os/domain";
import type { ArtifactDigest } from "@ai-dev-os/artifacts";
import { diagnostic, type IndexDiagnostic } from "./errors.js";
import { scanJsonStructure } from "./json-scan.js";
import { pathBaseName } from "./paths.js";

export const MANIFEST_FORMAT_IDS = Object.freeze([
  "npm-package-manifest",
  "npm-lockfile-v3",
  "typescript-project-config",
] as const);

export type ManifestFormatId = (typeof MANIFEST_FORMAT_IDS)[number];

export const MANIFEST_PARSER_VERSIONS: Readonly<Record<ManifestFormatId, number>> = Object.freeze({
  "npm-package-manifest": 1,
  "npm-lockfile-v3": 1,
  "typescript-project-config": 1,
});

export const DEPENDENCY_KINDS = Object.freeze([
  "runtime",
  "development",
  "peer",
  "optional",
  "workspace",
  "recorded",
  "unresolved",
] as const);

export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export const DEPENDENCY_SOURCES = Object.freeze([
  "manifest",
  "lockfile",
  "workspace-member",
] as const);

export type DependencySource = (typeof DEPENDENCY_SOURCES)[number];

export const MANIFEST_STATUSES = Object.freeze([
  "parsed",
  "partial",
  "malformed",
  "unsupported",
  "too-large",
] as const);

export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

export interface DependencyRecord {
  readonly manifestPath: string;
  readonly formatId: ManifestFormatId;
  readonly parserVersion: number;
  readonly kind: DependencyKind;
  readonly source: DependencySource;
  readonly name: string;
  /** Range text exactly as declared, sanitized and truncated. Never resolved. */
  readonly declaredRange: string | null;
  /** Only ever populated from a lockfile; a manifest cannot state this. */
  readonly resolvedVersion: string | null;
  readonly optional: boolean;
  /** Digest of the file this fact was extracted from. */
  readonly sourceDigestHex: string;
}

export interface ManifestRecord {
  readonly path: string;
  readonly formatId: ManifestFormatId;
  readonly parserVersion: number;
  readonly sourceDigestHex: string;
  readonly status: ManifestStatus;
  readonly declaredName: string | null;
  readonly declaredVersion: string | null;
  readonly isPrivate: boolean | null;
  readonly workspacePatterns: readonly string[];
  /** Top-level keys, exposed as a lexical field. Values are never exposed here. */
  readonly topLevelKeys: readonly string[];
  readonly dependencyCount: number;
  readonly diagnostics: readonly IndexDiagnostic[];
}

export interface ManifestExtraction {
  readonly record: ManifestRecord;
  readonly dependencies: readonly DependencyRecord[];
}

/**
 * Format detection by exact base name only. Extension sniffing would let a
 * hostile repository nominate arbitrary files for parsing.
 */
export function detectManifestFormat(canonicalPath: string): ManifestFormatId | null {
  const base = pathBaseName(canonicalPath);
  if (base === "package.json") {
    return "npm-package-manifest";
  }
  if (base === "package-lock.json") {
    return "npm-lockfile-v3";
  }
  if (base === "tsconfig.json" || (base.startsWith("tsconfig.") && base.endsWith(".json"))) {
    return "typescript-project-config";
  }
  return null;
}

const MAX_RANGE_LENGTH = 128;
const MAX_NAME_LENGTH = 214;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION_LIKE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

/** Strips anything unprintable and truncates. Used on every value taken from a manifest. */
function sanitize(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  let result = "";
  for (let index = 0; index < value.length && result.length < maxLength; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    result += value.charAt(index);
  }
  return result.length === 0 ? null : result;
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  // `Array.isArray` does not narrow a `readonly` array out of a union, so the
  // cast below is guarded by this check rather than by control flow.
  if (Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

interface DependencyCollector {
  readonly manifestPath: string;
  readonly formatId: ManifestFormatId;
  readonly sourceDigestHex: string;
  readonly limit: number;
  readonly items: DependencyRecord[];
  readonly diagnostics: IndexDiagnostic[];
  truncated: boolean;
  skipped: number;
}

function addDependency(
  collector: DependencyCollector,
  input: {
    readonly kind: DependencyKind;
    readonly source: DependencySource;
    readonly rawName: unknown;
    readonly rawRange: JsonValue | undefined;
    readonly resolvedVersion?: string | null;
    readonly optional?: boolean;
  },
): void {
  if (collector.items.length >= collector.limit) {
    collector.truncated = true;
    return;
  }
  const name = sanitize(input.rawName, MAX_NAME_LENGTH);
  if (name === null || !PACKAGE_NAME_PATTERN.test(name)) {
    collector.skipped += 1;
    return;
  }
  // A range that is not a plain string (an object, an array, a computed
  // construct in a converted manifest) is recorded as unresolved rather than
  // guessed at.
  const rangeIsScalar = typeof input.rawRange === "string";
  const declaredRange = rangeIsScalar ? sanitize(input.rawRange, MAX_RANGE_LENGTH) : null;
  const kind: DependencyKind =
    input.rawRange !== undefined && !rangeIsScalar ? "unresolved" : input.kind;
  if (kind === "unresolved" && input.rawRange !== undefined && !rangeIsScalar) {
    collector.diagnostics.push(
      diagnostic(
        "manifest-dynamic-construct",
        collector.manifestPath,
        `non-scalar dependency specifier for ${name.length} character name`,
      ),
    );
  }
  collector.items.push(
    Object.freeze({
      manifestPath: collector.manifestPath,
      formatId: collector.formatId,
      parserVersion: MANIFEST_PARSER_VERSIONS[collector.formatId],
      kind,
      source: input.source,
      name,
      declaredRange,
      resolvedVersion: input.resolvedVersion ?? null,
      optional: input.optional ?? false,
      sourceDigestHex: collector.sourceDigestHex,
    }),
  );
}

const NPM_DEPENDENCY_SECTIONS: readonly (readonly [string, DependencyKind, boolean])[] =
  Object.freeze([
    ["dependencies", "runtime", false],
    ["devDependencies", "development", false],
    ["peerDependencies", "peer", false],
    ["optionalDependencies", "optional", true],
  ]);

function parseNpmManifest(
  canonicalPath: string,
  root: JsonObject,
  collector: DependencyCollector,
): Omit<ManifestRecord, "diagnostics" | "dependencyCount" | "status"> {
  for (const [section, kind, optional] of NPM_DEPENDENCY_SECTIONS) {
    const table = asObject(root[section]);
    if (root[section] !== undefined && table === null) {
      collector.diagnostics.push(
        diagnostic("manifest-partial", canonicalPath, `section ${section} is not an object`),
      );
      continue;
    }
    if (table === null) {
      continue;
    }
    // Canonical JSON already sorted the keys, so iteration order is stable.
    for (const name of Object.keys(table)) {
      addDependency(collector, {
        kind,
        source: "manifest",
        rawName: name,
        rawRange: table[name],
        optional,
      });
    }
  }

  const workspaces = root["workspaces"];
  const patterns: string[] = [];
  const workspaceList = Array.isArray(workspaces)
    ? workspaces
    : Array.isArray(asObject(workspaces)?.["packages"])
      ? (asObject(workspaces)?.["packages"] as readonly JsonValue[])
      : null;
  if (workspaces !== undefined && workspaceList === null) {
    collector.diagnostics.push(
      diagnostic("manifest-partial", canonicalPath, "workspaces field has an unsupported shape"),
    );
  }
  for (const entry of workspaceList ?? []) {
    const pattern = sanitize(entry, 200);
    if (pattern !== null && patterns.length < 256) {
      patterns.push(pattern);
    }
  }

  return {
    path: canonicalPath,
    formatId: "npm-package-manifest",
    parserVersion: MANIFEST_PARSER_VERSIONS["npm-package-manifest"],
    sourceDigestHex: collector.sourceDigestHex,
    declaredName: sanitize(root["name"], MAX_NAME_LENGTH),
    declaredVersion: sanitize(root["version"], 64),
    isPrivate: typeof root["private"] === "boolean" ? root["private"] : null,
    workspacePatterns: Object.freeze([...new Set(patterns)].sort()),
    topLevelKeys: Object.freeze(Object.keys(root).slice(0, 128)),
  };
}

function parseNpmLockfile(
  canonicalPath: string,
  root: JsonObject,
  collector: DependencyCollector,
): Omit<ManifestRecord, "diagnostics" | "dependencyCount" | "status"> {
  const lockfileVersion = root["lockfileVersion"];
  if (typeof lockfileVersion !== "number" || lockfileVersion < 2 || lockfileVersion > 3) {
    collector.diagnostics.push(
      diagnostic(
        "manifest-unsupported",
        canonicalPath,
        `lockfileVersion outside the supported range 2-3`,
      ),
    );
  } else {
    const packages = asObject(root["packages"]);
    if (packages === null) {
      collector.diagnostics.push(
        diagnostic("manifest-partial", canonicalPath, "packages table is absent or not an object"),
      );
    } else {
      for (const key of Object.keys(packages)) {
        if (key === "") {
          // The root project entry describes the manifest, not a dependency.
          continue;
        }
        const entry = asObject(packages[key]);
        if (entry === null) {
          collector.skipped += 1;
          continue;
        }
        // `node_modules/<name>` and `node_modules/@scope/<name>` are the two
        // shapes npm writes for installed packages. Any other key is a
        // workspace member, whose *path* is not its identity: the declared
        // name is used, falling back to the final path segment.
        const marker = "node_modules/";
        const markerIndex = key.lastIndexOf(marker);
        const isWorkspaceMember = markerIndex === -1 && entry["link"] !== true;
        const name = isWorkspaceMember
          ? (sanitize(entry["name"], MAX_NAME_LENGTH) ?? key.slice(key.lastIndexOf("/") + 1))
          : key.slice(markerIndex + marker.length);
        const resolved = sanitize(entry["version"], 64);
        addDependency(collector, {
          kind: isWorkspaceMember ? "workspace" : "recorded",
          source: isWorkspaceMember ? "workspace-member" : "lockfile",
          rawName: name,
          rawRange: undefined,
          resolvedVersion: resolved !== null && VERSION_LIKE_PATTERN.test(resolved) ? resolved : null,
          optional: entry["optional"] === true,
        });
      }
    }
  }

  return {
    path: canonicalPath,
    formatId: "npm-lockfile-v3",
    parserVersion: MANIFEST_PARSER_VERSIONS["npm-lockfile-v3"],
    sourceDigestHex: collector.sourceDigestHex,
    declaredName: sanitize(root["name"], MAX_NAME_LENGTH),
    declaredVersion: sanitize(root["version"], 64),
    isPrivate: null,
    workspacePatterns: Object.freeze([]),
    topLevelKeys: Object.freeze(Object.keys(root).slice(0, 128)),
  };
}

function parseTypescriptConfig(
  canonicalPath: string,
  root: JsonObject,
  collector: DependencyCollector,
): Omit<ManifestRecord, "diagnostics" | "dependencyCount" | "status"> {
  // A TypeScript project config declares no packages. Project references are
  // paths, not dependency identities, so they are reported as unresolved
  // rather than misrepresented as resolvable names.
  const references = root["references"];
  if (Array.isArray(references)) {
    for (const entry of references) {
      const record = asObject(entry);
      const target = sanitize(record?.["path"], 200);
      if (target !== null) {
        collector.diagnostics.push(
          diagnostic(
            "manifest-partial",
            canonicalPath,
            `project reference recorded as unresolved (${target.length} character path)`,
          ),
        );
      }
    }
  }
  return {
    path: canonicalPath,
    formatId: "typescript-project-config",
    parserVersion: MANIFEST_PARSER_VERSIONS["typescript-project-config"],
    sourceDigestHex: collector.sourceDigestHex,
    declaredName: null,
    declaredVersion: null,
    isPrivate: null,
    workspacePatterns: Object.freeze([]),
    topLevelKeys: Object.freeze(Object.keys(root).slice(0, 128)),
  };
}

function malformed(
  canonicalPath: string,
  formatId: ManifestFormatId,
  digest: ArtifactDigest,
  status: ManifestStatus,
  diagnostics: readonly IndexDiagnostic[],
): ManifestExtraction {
  return Object.freeze({
    record: Object.freeze({
      path: canonicalPath,
      formatId,
      parserVersion: MANIFEST_PARSER_VERSIONS[formatId],
      sourceDigestHex: digest.hex,
      status,
      declaredName: null,
      declaredVersion: null,
      isPrivate: null,
      workspacePatterns: Object.freeze([]),
      topLevelKeys: Object.freeze([]),
      dependencyCount: 0,
      diagnostics: Object.freeze([...diagnostics]),
    }),
    dependencies: Object.freeze([]),
  });
}

/**
 * Parses one manifest. Fail-closed: any structural surprise downgrades the
 * status and the caller can see exactly why, but no partial result is ever
 * labelled `parsed`.
 */
export function extractManifest(input: {
  readonly canonicalPath: string;
  readonly formatId: ManifestFormatId;
  readonly text: string;
  readonly digest: ArtifactDigest;
  readonly maxBytes: number;
  readonly maxDependencies: number;
  readonly byteLength: number;
}): ManifestExtraction {
  const { canonicalPath, formatId, digest } = input;

  if (input.byteLength > input.maxBytes) {
    return malformed(canonicalPath, formatId, digest, "too-large", [
      diagnostic(
        "manifest-malformed",
        canonicalPath,
        `manifest exceeds the ${input.maxBytes} byte parse bound`,
      ),
    ]);
  }

  const scan = scanJsonStructure(input.text);
  if (!scan.ok) {
    return malformed(canonicalPath, formatId, digest, "malformed", [
      diagnostic("manifest-malformed", canonicalPath, `json scan: ${scan.reason}`),
    ]);
  }

  const preDiagnostics: IndexDiagnostic[] = [];
  if (scan.duplicateKeyPaths.length > 0) {
    // A duplicate key means the document reads differently to a human than to
    // a parser. That is a forgery primitive, so the manifest is refused.
    return malformed(canonicalPath, formatId, digest, "malformed", [
      diagnostic(
        "manifest-duplicate-key",
        canonicalPath,
        `${scan.duplicateKeyPaths.length} duplicate object keys`,
      ),
    ]);
  }

  let parsed: JsonValue;
  try {
    // `parseJsonText` rejects prototype-pollution keys, exotic objects,
    // oversized payloads, and cycles, and returns a frozen, key-sorted value.
    parsed = parseJsonText(input.text, canonicalPath);
  } catch {
    return malformed(canonicalPath, formatId, digest, "malformed", [
      diagnostic("manifest-malformed", canonicalPath, "canonical json parse rejected the document"),
    ]);
  }

  const root = asObject(parsed);
  if (root === null) {
    return malformed(canonicalPath, formatId, digest, "malformed", [
      diagnostic("manifest-malformed", canonicalPath, "document root is not an object"),
    ]);
  }

  const collector: DependencyCollector = {
    manifestPath: canonicalPath,
    formatId,
    sourceDigestHex: digest.hex,
    limit: input.maxDependencies,
    items: [],
    diagnostics: preDiagnostics,
    truncated: false,
    skipped: 0,
  };

  const base =
    formatId === "npm-package-manifest"
      ? parseNpmManifest(canonicalPath, root, collector)
      : formatId === "npm-lockfile-v3"
        ? parseNpmLockfile(canonicalPath, root, collector)
        : parseTypescriptConfig(canonicalPath, root, collector);

  if (collector.truncated) {
    collector.diagnostics.push(
      diagnostic(
        "manifest-partial",
        canonicalPath,
        `dependency list truncated at ${input.maxDependencies}`,
      ),
    );
  }
  if (collector.skipped > 0) {
    collector.diagnostics.push(
      diagnostic(
        "manifest-partial",
        canonicalPath,
        `${collector.skipped} entries skipped as unrecognizable identities`,
      ),
    );
  }

  const hasUnsupported = collector.diagnostics.some(
    (item) => item.code === "manifest-unsupported",
  );
  const status: ManifestStatus = hasUnsupported
    ? "unsupported"
    : collector.diagnostics.length > 0
      ? "partial"
      : "parsed";

  const dependencies = Object.freeze(
    [...collector.items].sort(
      (a, b) =>
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
    ),
  );

  return Object.freeze({
    record: Object.freeze({
      ...base,
      status,
      dependencyCount: dependencies.length,
      diagnostics: Object.freeze(
        [...collector.diagnostics].sort(
          (a, b) =>
            (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
            (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0),
        ),
      ),
    }),
    dependencies,
  });
}
