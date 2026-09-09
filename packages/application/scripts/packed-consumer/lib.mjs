"use strict";

/**
 * Deterministic helpers for the AM-02 first-party packed-consumer gate.
 *
 * This module is imported by two callers with different lifetimes:
 *   - `verify-packed-consumer.mjs`, the repository-side orchestrator that the
 *     dedicated hosted CI job runs; and
 *   - `probe.mjs`, which the orchestrator copies (together with this file)
 *     into the fresh consumer directory so the probe and the orchestrator
 *     share one source of truth for pins, shapes, and argument vectors.
 *
 * Everything here is pure with respect to its inputs except `sha256Hex`
 * (node:crypto) — no filesystem, process, network, or environment access —
 * so the unit suite can exercise it with inert fixtures only.
 */

import { createHash } from "node:crypto";

/**
 * Explicit first-party consumer inventory, including the application runtime
 * closure and the existing task-graph consumer package. The manifest guard
 * below refuses a newly required tarball before npm can consult a registry.
 */
export const REPOSITORY_PACKAGES = Object.freeze([
  Object.freeze({ name: "@ai-dev-os/domain", directory: "packages/domain" }),
  Object.freeze({ name: "@ai-dev-os/artifacts", directory: "packages/artifacts" }),
  Object.freeze({ name: "@ai-dev-os/persistence", directory: "packages/persistence" }),
  Object.freeze({
    name: "@ai-dev-os/persistence-sqlite",
    directory: "packages/persistence-sqlite",
  }),
  Object.freeze({
    name: "@ai-dev-os/persistence-postgres",
    directory: "packages/persistence-postgres",
  }),
  Object.freeze({ name: "@ai-dev-os/scheduler", directory: "packages/scheduler" }),
  Object.freeze({ name: "@ai-dev-os/providers", directory: "packages/providers" }),
  Object.freeze({ name: "@ai-dev-os/task-graph", directory: "packages/task-graph" }),
  Object.freeze({ name: "@ai-dev-os/project", directory: "packages/project" }),
  Object.freeze({ name: "@ai-dev-os/intake", directory: "packages/intake" }),
  Object.freeze({ name: "@ai-dev-os/plan", directory: "packages/plan" }),
  Object.freeze({ name: "@ai-dev-os/approval", directory: "packages/approval" }),
  Object.freeze({ name: "@ai-dev-os/artifact-store", directory: "packages/artifact-store" }),
  Object.freeze({ name: "@ai-dev-os/config", directory: "packages/config" }),
  Object.freeze({ name: "@ai-dev-os/context", directory: "packages/context" }),
  Object.freeze({ name: "@ai-dev-os/memory", directory: "packages/memory" }),
  Object.freeze({ name: "@ai-dev-os/policy", directory: "packages/policy" }),
  Object.freeze({ name: "@ai-dev-os/process-broker", directory: "packages/process-broker" }),
  Object.freeze({ name: "@ai-dev-os/prompt-compiler", directory: "packages/prompt-compiler" }),
  Object.freeze({ name: "@ai-dev-os/provider-catalog", directory: "packages/provider-catalog" }),
  Object.freeze({ name: "@ai-dev-os/provider-claude-code", directory: "packages/provider-claude-code" }),
  Object.freeze({ name: "@ai-dev-os/provider-gateway", directory: "packages/provider-gateway" }),
  Object.freeze({ name: "@ai-dev-os/repository-index", directory: "packages/repository-index" }),
  Object.freeze({ name: "@ai-dev-os/secrets", directory: "packages/secrets" }),
  Object.freeze({ name: "@ai-dev-os/thinker", directory: "packages/thinker" }),
  Object.freeze({ name: "@ai-dev-os/workspace", directory: "packages/workspace" }),
  Object.freeze({ name: "@ai-dev-os/application", directory: "packages/application" }),
]);

/**
 * Registry dependencies pinned to the exact versions the repository lockfile
 * resolves, so the consumer install is reproducible rather than range-floating.
 */
export const REGISTRY_PINS = Object.freeze({
  "better-sqlite3": "12.11.1",
  "pg": "8.23.0",
  "pg-pool": "3.14.0",
});

/** Required peers participate in an install; isolated optional test peers do not. */
function runtimeDependencies(manifest) {
  const peers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true));
  return { ...peers, ...manifest.dependencies, ...manifest.optionalDependencies };
}

/**
 * Pure preflight over the exact manifests and lockfile read by the orchestrator.
 * Every first-party edge must have a local tarball, and each registry edge must
 * resolve to its existing exact consumer pin. Dev dependencies and optional
 * testing peers never expand this production consumer.
 */
export function validateConsumerRuntimeClosure(manifestsByName, lockfile, definitions = REPOSITORY_PACKAGES, registryPins = REGISTRY_PINS) {
  const supplied = new Set(definitions.map(definition => definition.name));
  if (supplied.size !== definitions.length) throw new Error("Duplicate first-party consumer package.");
  const registryNames = new Set();
  let firstPartyEdges = 0;
  for (const definition of definitions) {
    const manifest = manifestsByName[definition.name];
    if (manifest?.name !== definition.name) throw new Error(`Missing or mismatched manifest for ${definition.name}.`);
    for (const dependency of Object.keys(runtimeDependencies(manifest))) {
      if (dependency.startsWith("@ai-dev-os/")) {
        if (!supplied.has(dependency)) throw new Error(`Missing first-party tarball ${dependency} required by ${definition.name}.`);
        firstPartyEdges += 1;
      } else {
        const locked = lockfile.packages?.[`${definition.directory}/node_modules/${dependency}`]
          ?? lockfile.packages?.[`node_modules/${dependency}`];
        if (typeof locked?.version !== "string" || registryPins[dependency] !== locked.version) {
          throw new Error(`Missing or mismatched registry pin for ${dependency} required by ${definition.name}.`);
        }
        registryNames.add(dependency);
      }
    }
  }
  for (const name of Object.keys(registryPins)) {
    if (!registryNames.has(name)) throw new Error(`Registry pin ${name} is outside the consumer runtime closure.`);
  }
  return Object.freeze({ packageCount: supplied.size, firstPartyEdges, registryPackageCount: registryNames.size });
}

/** Exact pinned Account Manager identities (must equal the application constants). */
export const EXPECTED_SUPPORTED_COMMIT =
  "f958ccaee81452f919e7321078899de692f0c81c";
export const EXPECTED_SUPPORTED_TREE =
  "04c22c65d5839a2c80f716e55f4f41d5ab79c6a7";
export const EXPECTED_SUPPORTED_INVENTORY_SHA256 =
  "1c22b7d9ed06654563254f37495a774f7c81c7dd6bc376b5af43c84ff710c9e4";
export const EXPECTED_SUPPORTED_READER_SHA256 =
  "ba17ed90c603351c0e3737d9d10552b7571fecd19ff4fd451820111857d3b894";
export const EXPECTED_USAGE_PROTOCOL_VERSION = 2;
export const EXPECTED_RUNTIME_VERSION = "1.4.1";
export const EXPECTED_REPOSITORY_URL =
  "https://github.com/alijabbar04/ai-account-manager.git";

/** Production symbols that must exist on the installed package roots. */
export const REQUIRED_APPLICATION_EXPORTS = Object.freeze([
  "ACCOUNT_MANAGER_SUPPORTED_COMMIT",
  "ACCOUNT_MANAGER_SUPPORTED_TREE",
  "ACCOUNT_MANAGER_SUPPORTED_INVENTORY_SHA256",
  "ACCOUNT_MANAGER_SUPPORTED_READER_SHA256",
  "ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION",
  "ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED",
  "createAccountManagerFixtureUsageAdapter",
  "createAccountManagerSupportedUsageAdapter",
]);
export const REQUIRED_SCHEDULER_EXPORTS = Object.freeze([
  "routeTask",
  "parseCanonicalUsageSnapshot",
  "validateUsageFreshness",
  "isLondonWorkHours",
]);

/** Testing-only symbols that must NOT be reachable through production roots. */
export const FORBIDDEN_PRODUCTION_EXPORTS = Object.freeze([
  "createAccountManagerSupportedUsageAdapterForTesting",
  "runApplicationPersistenceContractSuite",
  "createApplicationContractDefinition",
]);

/**
 * Fixed instants for the deterministic routing proofs. 2026-08-12 is a
 * Wednesday; 09:30Z is 10:30 in Europe/London (BST) — inside the weekday
 * 09:00–17:00 borrowed working-hours window — and 19:30Z is 20:30 — outside
 * it. The probe additionally asserts both classifications through the
 * installed `isLondonWorkHours` export rather than trusting this comment.
 */
export const WORK_HOURS_NOW = "2026-08-12T09:30:00.000Z";
export const OUTSIDE_WORK_HOURS_NOW = "2026-08-12T19:30:00.000Z";

export const PROBE_PROFILE_ID = "profile:packed-consumer-owned";
export const PROBE_FRESHNESS_MS = 300_000;

/** Tarball payload policy: compiled output plus the two declared documents. */
export function validateTarballFileList(paths) {
  const offending = [];
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) {
      offending.push(String(path));
      continue;
    }
    const normalized = path.replaceAll("\\", "/");
    const allowed =
      !normalized.split("/").includes("..") &&
      (normalized === "package.json" ||
        normalized === "README.md" ||
        normalized.startsWith("dist/"));
    if (!allowed) offending.push(normalized);
  }
  return Object.freeze({ ok: offending.length === 0, offending: Object.freeze(offending) });
}

/** Every declared runtime/type/testing entry must exist in the packed output. */
export function validateTarballExportTargets(packageExports, paths) {
  const targets = [];
  function visit(value) {
    if (typeof value === "string") targets.push(value);
    else if (value !== null && typeof value === "object") for (const nested of Object.values(value)) visit(nested);
  }
  visit(packageExports);
  const files = new Set(paths.map(path => path.replaceAll("\\", "/")));
  const missing = [...new Set(targets.filter(target => !target.startsWith("./dist/") || !files.has(target.slice(2))))];
  return Object.freeze({ ok: targets.length > 0 && missing.length === 0, missing: Object.freeze(missing) });
}

/**
 * Exact consumer manifest. Tarballs are referenced by consumer-relative
 * `file:` paths so the manifest (and its digest in the evidence) never embeds
 * a runner-specific absolute path.
 */
export function buildConsumerManifest(tarballRelativePathsByName) {
  const dependencies = {};
  for (const definition of REPOSITORY_PACKAGES) {
    const relative = tarballRelativePathsByName[definition.name];
    if (typeof relative !== "string" || relative.length === 0 || relative.includes("..")) {
      throw new Error(`Missing or invalid tarball path for ${definition.name}.`);
    }
    dependencies[definition.name] = `file:${relative.replaceAll("\\", "/")}`;
  }
  for (const [name, version] of Object.entries(REGISTRY_PINS)) {
    dependencies[name] = version;
  }
  return Object.freeze({
    name: "ai-dev-os-packed-consumer-check",
    version: "0.0.0",
    private: true,
    description:
      "Task-owned fresh consumer for the AM-02 hosted packed-consumer gate. Never published.",
    type: "module",
    dependencies: Object.freeze(dependencies),
  });
}

/** Synthetic Account Manager profile store (never real installed state). */
export function buildProfilesStore(profileId) {
  return Object.freeze({
    version: 1,
    profiles: Object.freeze([
      Object.freeze({
        id: profileId,
        name: "synthetic-packed-consumer-profile",
        configDir: "C:\\synthetic\\never-a-real-path",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ]),
  });
}

/**
 * Synthetic usage snapshot store in the exact shape the pinned reader parses.
 * `fiveHour`/`weekly` accept either an active descriptor
 * `{ percent, resetsAtIso }` or the literal string "inactive".
 */
export function buildUsageStore(profileId, options) {
  const limits = [];
  const pushLimit = (kind, window) => {
    if (window === "inactive") {
      limits.push(Object.freeze({ kind, severity: "normal", isActive: false }));
      return;
    }
    limits.push(Object.freeze({
      kind,
      percent: window.percent,
      severity: "normal",
      resetsAt: window.resetsAtIso,
    }));
  };
  pushLimit("session", options.fiveHour);
  pushLimit("weekly_all", options.weekly);
  const record = {
    fetchedAt: options.fetchedAtIso,
    ok: options.ok !== false,
    limits: Object.freeze(limits),
  };
  if (options.ok === false) {
    record.error = "synthetic-provider-refresh-failed";
  }
  return Object.freeze({ [profileId]: Object.freeze(record) });
}

export function buildAuthorizedProfile(profileId, ownership) {
  return Object.freeze({
    profileId,
    providerId: "claude-code",
    ownership,
    authorization: "authorized",
    revocation: "not-revoked",
  });
}

export function buildReaderConfiguration(dataDirectory, authorizedProfile) {
  return Object.freeze({
    schemaVersion: 2,
    dataDirectory,
    profileAllowlist: Object.freeze([authorizedProfile]),
    freshnessMs: PROBE_FRESHNESS_MS,
  });
}

/** Minimal valid orchestration task envelope (mirrors the reviewed fixtures). */
export function buildTaskEnvelope(idSuffix, nowIso, deadlineIso) {
  return Object.freeze({
    schemaVersion: 1,
    taskId: `task:packed-consumer:${idSuffix}`,
    parentTaskId: null,
    correlationId: `correlation:packed-consumer:${idSuffix}`,
    idempotencyKey: `idempotency:packed-consumer:${idSuffix}`,
    objective: "Exercise one deterministic packed-consumer routing decision.",
    workspace: Object.freeze({
      projectId: "project:packed-consumer",
      workspaceId: "workspace:packed-consumer",
      snapshotId: "snapshot:packed-consumer",
      baseRevision: "0123456789abcdef0123456789abcdef01234567",
    }),
    requestedRoute: Object.freeze({
      providerId: null,
      modelId: null,
      profileId: null,
      ownership: null,
    }),
    capabilities: Object.freeze(["repository-read", "structured-output"]),
    permissionMode: "contained-default",
    budget: Object.freeze({
      maximumInputTokens: 100_000,
      maximumOutputTokens: 20_000,
      maximumCostMicros: 10_000_000,
      maximumToolCalls: 100,
      maximumTurns: 4,
    }),
    retry: Object.freeze({
      maximumAttempts: 3,
      initialBackoffMs: 100,
      maximumBackoffMs: 1_000,
      retryableFailures: Object.freeze(["capacity", "disconnected", "provider"]),
    }),
    timeout: Object.freeze({ dispatchMs: 1_000, attemptMs: 60_000 }),
    expectedResultSchema: Object.freeze({ type: "object", additionalProperties: false }),
    priority: "normal",
    createdAt: nowIso,
    deadline: deadlineIso,
  });
}

export function buildRouteCandidate(overrides = {}) {
  const ownership = overrides.ownership ?? "owned";
  const candidate = {
    schemaVersion: 1,
    candidateId: "candidate:packed-consumer",
    providerId: "provider:packed-consumer",
    modelId: "model:packed-consumer",
    profileId: PROBE_PROFILE_ID,
    ownership,
    borrowedPolicy:
      ownership === "authorized-borrowed"
        ? Object.freeze({ taskClass: "claude-code", taskAuthorized: true, modelAllowed: true })
        : null,
    authorized: true,
    availability: "available",
    health: "healthy",
    healthObservedAt: WORK_HOURS_NOW,
    capabilities: Object.freeze(["repository-read", "structured-output"]),
    permissionModes: Object.freeze(["contained-default"]),
    qualityScore: 800,
    costScore: 600,
    predictedFiveHourBasisPoints: 100,
    predictedWeeklyBasisPoints: 100,
    ...overrides,
    ownership,
  };
  return Object.freeze(candidate);
}

/** Synthetic native-v3 snapshot for deterministic routing-rule proofs. */
export function buildRoutingSnapshot(overrides = {}) {
  const nowIso = overrides.nowIso ?? WORK_HOURS_NOW;
  const nowMs = Date.parse(nowIso);
  const window = (windowId, usedBasisPoints, resetOffsetMs) =>
    Object.freeze({
      windowId,
      status: "active",
      usedBasisPoints,
      remainingBasisPoints: 10_000 - usedBasisPoints,
      resetAt: new Date(nowMs + resetOffsetMs).toISOString(),
    });
  const snapshot = {
    schemaVersion: 3,
    compatibility: "native-v3",
    snapshotId: overrides.snapshotId ?? "usage:packed-consumer:routing",
    sourceAdapterId: "adapter:packed-consumer",
    sourceAdapterVersion: "version:3",
    sourceFingerprint: "a".repeat(64),
    sourceClass: "provider-authoritative",
    authoritative: true,
    confidence: "high",
    profileId: PROBE_PROFILE_ID,
    providerId: "provider:packed-consumer",
    ownership: overrides.ownership ?? "owned",
    authorization: "authorized",
    revocation: "not-revoked",
    timezone: "Europe/London",
    observedAt: new Date(nowMs - 1_000).toISOString(),
    freshUntil: new Date(nowMs + 60_000).toISOString(),
    fiveHour:
      overrides.fiveHour ??
      window("window:packed-consumer:five-hour", overrides.fiveHourUsedBasisPoints ?? 1_000, 3_600_000),
    weekly:
      overrides.weekly ??
      window("window:packed-consumer:weekly", overrides.weeklyUsedBasisPoints ?? 2_000, 7 * 86_400_000),
  };
  return Object.freeze(snapshot);
}

/** Fixed npm argument vectors — literals only, never composed from input. */
export function npmPackArgs(workspaceName, destination) {
  return Object.freeze([
    "pack",
    "--workspace",
    workspaceName,
    "--json",
    "--pack-destination",
    destination,
  ]);
}
export const NPM_INSTALL_ARGS = Object.freeze([
  "install",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--loglevel",
  "error",
]);
export const NPM_REBUILD_BETTER_SQLITE3_ARGS = Object.freeze([
  "rebuild",
  "better-sqlite3",
]);
export const NPM_LS_ARGS = Object.freeze(["ls", "--all", "--json"]);
export const NPM_AUDIT_ARGS = Object.freeze(["audit", "--audit-level=high"]);

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** CRLF-tolerant normalized reader identity, matching the adapter's rule. */
export function normalizedReaderIdentity(sourceText) {
  const normalized = sourceText.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    throw new Error("The reader artifact contains a bare carriage return.");
  }
  return Object.freeze({
    normalizedBytes: Buffer.byteLength(normalized, "utf8"),
    sha256: sha256Hex(normalized),
  });
}

/** Deterministic, sorted, single-line-per-fact evidence rendering. */
export function renderEvidence(entries) {
  const lines = entries.map(([key, value]) => {
    if (typeof key !== "string" || key.length === 0 || /[\r\n=]/.test(key)) {
      throw new Error("Evidence keys must be single-line and '='-free.");
    }
    const text = String(value);
    if (/[\r\n]/.test(text)) {
      throw new Error(`Evidence value for ${key} must be single-line.`);
    }
    return `${key}=${text}`;
  });
  return [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n");
}
