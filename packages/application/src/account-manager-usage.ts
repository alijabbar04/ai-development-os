import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute } from "node:path";
import { types as utilTypes } from "node:util";
import { Script } from "node:vm";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import {
  USAGE_SNAPSHOT_SCHEMA_VERSION,
  parseCanonicalUsageSnapshot,
  type NormalizedCanonicalUsageSnapshot,
  type UsageSnapshotAdapter,
  type UsageSnapshotReadRequest,
} from "@ai-dev-os/scheduler";
import { ApplicationError } from "./errors.js";

const {
  ensureArray,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
} = validation;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const ACCOUNT_MANAGER_REPOSITORY_URL =
  "https://github.com/alijabbar04/ai-account-manager.git" as const;
export const ACCOUNT_MANAGER_COMMIT =
  "99be1cc6fa0fbbcfffcb4b7042d9bf0bf5ae0ae0" as const;
export const ACCOUNT_MANAGER_TREE =
  "49eb2f93f3012836b9a88ac705de8a9df1e8646f" as const;
export const ACCOUNT_MANAGER_INVENTORY_SHA256 =
  "1898a7fdbe6236828d6bfac7b6064e94fe65a3859d56ae5fff86061906f129ff" as const;
export const ACCOUNT_MANAGER_RUNTIME_VERSION = "1.4.1" as const;
export const ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION = 1 as const;
export const ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED = false as const;
export const ACCOUNT_MANAGER_READER_ID =
  "ai-account-manager.usage-reader" as const;
export const ACCOUNT_MANAGER_SUPPORTED_READER_ENABLED = true as const;
export const ACCOUNT_MANAGER_SUPPORTED_COMMIT =
  "5279113728a344a87a7e49c4222741a618b67dd5" as const;
export const ACCOUNT_MANAGER_SUPPORTED_TREE =
  "e8c342a77eaf01535db2bed2819e5ad87e1876df" as const;
export const ACCOUNT_MANAGER_SUPPORTED_INVENTORY_SHA256 =
  "df89d81c692f298b56ead07c4822a8efc87113919d5594ec0069df59d1161bf3" as const;
export const ACCOUNT_MANAGER_SUPPORTED_READER_SHA256 =
  "7626a6e24a10cf479983de7a1c7882ebf87a4ae45bf442c1b1f5a9d65ed04e40" as const;

export interface AccountManagerFixtureReader {
  readonly fixtureOnly: true;
  readScopedUsage(profileId: string): Promise<unknown | null>;
}

export interface AccountManagerUsageAdapterOptions {
  readonly reader: AccountManagerFixtureReader;
}

export interface AccountManagerSupportedReader {
  readonly fixtureOnly: false;
  readonly readerId: typeof ACCOUNT_MANAGER_READER_ID;
  readonly protocolVersion: typeof ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION;
  readonly runtimeVersion: typeof ACCOUNT_MANAGER_RUNTIME_VERSION;
  readonly repositoryUrl: typeof ACCOUNT_MANAGER_REPOSITORY_URL;
  readonly configurationFingerprint: string;
  readScopedUsage(
    profileId: string,
    request?: UsageSnapshotReadRequest,
  ): Promise<unknown | null>;
}

export interface AccountManagerReaderConfiguration {
  readonly schemaVersion: typeof ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION;
  readonly dataDirectory: string;
  readonly profileAllowlist: readonly AccountManagerAuthorizedProfile[];
  readonly freshnessMs: number;
}

export interface AccountManagerAuthorizedProfile {
  readonly profileId: string;
  readonly providerId: "claude-code";
  readonly ownership: "owned" | "authorized-borrowed";
  readonly authorization: "authorized" | "unauthorized" | "ambiguous";
  readonly revocation: "not-revoked" | "revoked" | "unknown";
}

export interface AccountManagerSupportedUsageAdapterOptions {
  readonly readerModulePath: string;
  readonly readerConfiguration: AccountManagerReaderConfiguration;
  readonly authorizedProfile: AccountManagerAuthorizedProfile;
  readonly expectedConfigurationFingerprint: string;
  readonly maximumSourceFreshnessMs: number;
  readonly now?: () => Date;
}

interface ParsedSupportedUsageAdapterOptions {
  readonly reader: AccountManagerSupportedReader;
  readonly authorizedProfile: AccountManagerAuthorizedProfile;
  readonly expectedConfigurationFingerprint: string;
  readonly maximumSourceFreshnessMs: number;
  readonly now: () => Date;
}

function finiteId(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID,
    patternName: "identifier",
  });
}

function finiteSha(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 64,
    pattern: SHA256,
    patternName: "lowercase SHA-256",
  });
}

function parseWindow(value: unknown, path: string): {
  readonly windowId: string;
  readonly usedBasisPoints: number;
  readonly remainingBasisPoints: number;
  readonly resetAt: string;
} {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    ["windowId", "usedBasisPoints", "remainingBasisPoints", "resetAt"],
    path,
  );
  return Object.freeze({
    windowId: finiteId(input["windowId"], `${path}.windowId`),
    usedBasisPoints: ensureSafeInteger(
      input["usedBasisPoints"],
      `${path}.usedBasisPoints`,
      0,
      10_000,
    ),
    remainingBasisPoints: ensureSafeInteger(
      input["remainingBasisPoints"],
      `${path}.remainingBasisPoints`,
      0,
      10_000,
    ),
    resetAt: ensureTimestamp(input["resetAt"], `${path}.resetAt`),
  });
}

function sourceIdentity(value: unknown): void {
  const source = ensureRecord(value, "fixture.source");
  ensureExactKeys(
    source,
    ["repositoryUrl", "commitSha", "treeSha", "inventorySha256", "runtimeVersion"],
    "fixture.source",
  );
  const matches =
    source["repositoryUrl"] === ACCOUNT_MANAGER_REPOSITORY_URL &&
    source["commitSha"] === ACCOUNT_MANAGER_COMMIT &&
    source["treeSha"] === ACCOUNT_MANAGER_TREE &&
    source["inventorySha256"] === ACCOUNT_MANAGER_INVENTORY_SHA256 &&
    source["runtimeVersion"] === ACCOUNT_MANAGER_RUNTIME_VERSION;
  if (!matches) {
    throw new ApplicationError(
      "USAGE_SOURCE_MISMATCH",
      "The fixture is not bound to the reviewed Account Manager source identity.",
    );
  }
}

function normalizeFixture(value: unknown, requestedProfileId: string): NormalizedCanonicalUsageSnapshot {
  try {
    const input = ensureRecord(value, "fixture");
    ensureExactKeys(
      input,
      [
        "schemaVersion",
        "observationId",
        "source",
        "requestedProfileId",
        "profile",
        "observation",
      ],
      "fixture",
    );
    if (input["schemaVersion"] !== ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION) {
      throw new ApplicationError(
        "INVALID_USAGE_FIXTURE",
        "The fixture protocol version is unsupported.",
      );
    }
    sourceIdentity(input["source"]);
    const boundRequest = finiteId(input["requestedProfileId"], "fixture.requestedProfileId");
    const profile = ensureRecord(input["profile"], "fixture.profile");
    ensureExactKeys(
      profile,
      [
        "scopedProfileId",
        "scopeClass",
        "providerId",
        "ownership",
        "authorization",
        "revocation",
      ],
      "fixture.profile",
    );
    const scopedProfileId = finiteId(
      profile["scopedProfileId"],
      "fixture.profile.scopedProfileId",
    );
    if (
      boundRequest !== requestedProfileId ||
      scopedProfileId !== requestedProfileId ||
      profile["scopeClass"] !== "opaque-local-id"
    ) {
      throw new ApplicationError(
        "USAGE_PROFILE_MISMATCH",
        "The fixture is bound to a different or non-opaque profile scope.",
      );
    }
    const observation = ensureRecord(input["observation"], "fixture.observation");
    ensureExactKeys(
      observation,
      [
        "sourceClass",
        "confidence",
        "timezone",
        "observedAt",
        "freshUntil",
        "fiveHour",
        "weekly",
      ],
      "fixture.observation",
    );
    const sourceClass = ensureEnum(
      observation["sourceClass"],
      "fixture.observation.sourceClass",
      [
        "provider-authoritative",
        "provider-cached",
        "locally-observed",
        "calculated",
        "estimated",
      ] as const,
    );
    const material = Object.freeze({
      schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
      compatibility: "native-v2" as const,
      observationId: finiteId(input["observationId"], "fixture.observationId"),
      sourceAdapterId: "usage:account-manager-fixture" as const,
      sourceAdapterVersion: `v${ACCOUNT_MANAGER_RUNTIME_VERSION}:${ACCOUNT_MANAGER_COMMIT.slice(0, 12)}`,
      sourceFingerprint: finiteSha(
        ACCOUNT_MANAGER_INVENTORY_SHA256,
        "fixture.source.inventorySha256",
      ),
      sourceClass,
      authoritative: sourceClass === "provider-authoritative",
      confidence: ensureEnum(
        observation["confidence"],
        "fixture.observation.confidence",
        ["high", "medium", "low"] as const,
      ),
      profileId: scopedProfileId,
      providerId: finiteId(profile["providerId"], "fixture.profile.providerId"),
      ownership: ensureEnum(
        profile["ownership"],
        "fixture.profile.ownership",
        ["owned", "authorized-borrowed"] as const,
      ),
      authorization: ensureEnum(
        profile["authorization"],
        "fixture.profile.authorization",
        ["authorized", "unauthorized", "ambiguous"] as const,
      ),
      revocation: ensureEnum(
        profile["revocation"],
        "fixture.profile.revocation",
        ["not-revoked", "revoked", "unknown"] as const,
      ),
      timezone: ensureEnum(
        observation["timezone"],
        "fixture.observation.timezone",
        ["Europe/London"] as const,
      ),
      observedAt: ensureTimestamp(
        observation["observedAt"],
        "fixture.observation.observedAt",
      ),
      freshUntil: ensureTimestamp(
        observation["freshUntil"],
        "fixture.observation.freshUntil",
      ),
      fiveHour: parseWindow(observation["fiveHour"], "fixture.observation.fiveHour"),
      weekly: parseWindow(observation["weekly"], "fixture.observation.weekly"),
    });
    const snapshotId = `usage:${createHash("sha256")
      .update(toCanonicalJson(material))
      .digest("hex")
      .slice(0, 40)}`;
    const { observationId: _observationId, ...snapshot } = material;
    return parseCanonicalUsageSnapshot({ ...snapshot, snapshotId });
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "INVALID_USAGE_FIXTURE",
      "The usage fixture is malformed or outside the reviewed protocol.",
    );
  }
}

export function createAccountManagerFixtureUsageAdapter(
  options: AccountManagerUsageAdapterOptions,
): UsageSnapshotAdapter {
  if (
    options === null ||
    typeof options !== "object" ||
    options.reader === null ||
    typeof options.reader !== "object" ||
    options.reader.fixtureOnly !== true ||
    typeof options.reader.readScopedUsage !== "function"
  ) {
    throw new ApplicationError(
      "INVALID_COMMAND",
      "Only an explicitly fixture-only usage reader is accepted.",
    );
  }
  return Object.freeze({
    adapterId: "usage:account-manager-fixture",
    schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
    async readAuthorizedSnapshot(profileId: string): Promise<NormalizedCanonicalUsageSnapshot | null> {
      let requestedProfileId: string;
      try {
        requestedProfileId = finiteId(profileId, "profileId");
      } catch {
        throw new ApplicationError(
          "INVALID_COMMAND",
          "The requested usage profile identity is invalid.",
        );
      }
      let raw: unknown | null;
      try {
        raw = await options.reader.readScopedUsage(requestedProfileId);
      } catch {
        throw new ApplicationError(
          "USAGE_SOURCE_UNAVAILABLE",
          "The fixture usage source is unavailable.",
        );
      }
      try {
        if (raw === null) return null;
        const items = Array.isArray(raw)
          ? ensureArray(raw, "fixtureBatch", 2)
          : [raw];
        if (items.length === 0) return null;
        if (items.length !== 1) {
          throw new ApplicationError(
            "USAGE_DUPLICATE",
            "Exactly one scoped usage observation is required.",
          );
        }
        return normalizeFixture(items[0], requestedProfileId);
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "INVALID_USAGE_FIXTURE",
          "The usage fixture batch is malformed or outside the reviewed protocol.",
        );
      }
    },
  });
}

function supportedSourceFingerprint(options: ParsedSupportedUsageAdapterOptions): string {
  return createHash("sha256")
    .update(toCanonicalJson({
      repositoryUrl: ACCOUNT_MANAGER_REPOSITORY_URL,
      sourceCommit: ACCOUNT_MANAGER_SUPPORTED_COMMIT,
      sourceTree: ACCOUNT_MANAGER_SUPPORTED_TREE,
      sourceInventorySha256: ACCOUNT_MANAGER_SUPPORTED_INVENTORY_SHA256,
      readerArtifactSha256: ACCOUNT_MANAGER_SUPPORTED_READER_SHA256,
      readerConfigurationFingerprint:
        options.expectedConfigurationFingerprint,
      runtimeVersion: ACCOUNT_MANAGER_RUNTIME_VERSION,
      readerId: ACCOUNT_MANAGER_READER_ID,
      protocolVersion: ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION,
    }))
    .digest("hex");
}

function snapshotSupportedReaderInput(value: unknown): unknown {
  try {
    let nodes = 0;
    let textUnits = 0;
    const active = new WeakSet<object>();
    const copy = (item: unknown, depth: number): unknown => {
      nodes += 1;
      if (nodes > 256 || depth > 12) {
        throw new ApplicationError(
          "INVALID_USAGE_FIXTURE",
          "The Account Manager reader result exceeds its structural bound.",
        );
      }
      if (typeof item === "string") {
        textUnits += item.length;
        if (textUnits > 16_384) {
          throw new ApplicationError(
            "INVALID_USAGE_FIXTURE",
            "The Account Manager reader result exceeds its text bound.",
          );
        }
        return item;
      }
      if (item === null || typeof item !== "object") return item;
      if (utilTypes.isProxy(item)) {
        throw new ApplicationError(
          "INVALID_USAGE_FIXTURE",
          "The Account Manager reader result is not plain data.",
        );
      }
      if (active.has(item)) {
        throw new ApplicationError(
          "INVALID_USAGE_FIXTURE",
          "The Account Manager reader result contains a cycle.",
        );
      }
      active.add(item);
      try {
        if (Array.isArray(item)) {
          if (item.length > 64) {
            throw new ApplicationError(
              "INVALID_USAGE_FIXTURE",
              "The Account Manager reader result exceeds its collection bound.",
            );
          }
          const keys = Reflect.ownKeys(item);
          if (
            keys.length !== item.length + 1 ||
            keys.some((key) => typeof key !== "string")
          ) {
            throw new ApplicationError(
              "INVALID_USAGE_FIXTURE",
              "The Account Manager reader result is not plain data.",
            );
          }
          const descriptors = Object.getOwnPropertyDescriptors(item);
          const result: unknown[] = [];
          for (let index = 0; index < item.length; index += 1) {
            const descriptor = descriptors[String(index)];
            if (
              descriptor === undefined ||
              !("value" in descriptor) ||
              descriptor.enumerable !== true
            ) {
              throw new ApplicationError(
                "INVALID_USAGE_FIXTURE",
                "The Account Manager reader result is not plain data.",
              );
            }
            result.push(copy(descriptor.value, depth + 1));
          }
          return result;
        }
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new ApplicationError(
            "INVALID_USAGE_FIXTURE",
            "The Account Manager reader result is not plain data.",
          );
        }
        const keys = Reflect.ownKeys(item);
        if (
          keys.length > 64 ||
          keys.some((key) => typeof key !== "string")
        ) {
          throw new ApplicationError(
            "INVALID_USAGE_FIXTURE",
            "The Account Manager reader result exceeds its field bound.",
          );
        }
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const result = Object.create(null) as Record<string, unknown>;
        for (const key of keys as string[]) {
          const descriptor = descriptors[key];
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true
          ) {
            throw new ApplicationError(
              "INVALID_USAGE_FIXTURE",
              "The Account Manager reader result is not plain data.",
            );
          }
          textUnits += key.length;
          if (textUnits > 16_384) {
            throw new ApplicationError(
              "INVALID_USAGE_FIXTURE",
              "The Account Manager reader result exceeds its text bound.",
            );
          }
          result[key] = copy(descriptor.value, depth + 1);
        }
        return result;
      } finally {
        active.delete(item);
      }
    };
    return copy(value, 0);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "INVALID_USAGE_FIXTURE",
      "The Account Manager reader result is not safely inspectable.",
    );
  }
}

function parseAuthorizedProfile(value: unknown): AccountManagerAuthorizedProfile {
  try {
    const input = ensureRecord(
      snapshotSupportedReaderInput(value),
      "options.authorizedProfile",
    );
    ensureExactKeys(
      input,
      ["profileId", "providerId", "ownership", "authorization", "revocation"],
      "options.authorizedProfile",
    );
    return Object.freeze({
      profileId: finiteId(input["profileId"], "options.profileId"),
      providerId: ensureEnum(
        input["providerId"],
        "options.providerId",
        ["claude-code"] as const,
      ),
      ownership: ensureEnum(
        input["ownership"],
        "options.ownership",
        ["owned", "authorized-borrowed"] as const,
      ),
      authorization: ensureEnum(
        input["authorization"],
        "options.authorization",
        ["authorized", "unauthorized", "ambiguous"] as const,
      ),
      revocation: ensureEnum(
        input["revocation"],
        "options.revocation",
        ["not-revoked", "revoked", "unknown"] as const,
      ),
    });
  } catch {
    throw new ApplicationError(
      "INVALID_COMMAND",
      "The Account Manager reader authority configuration is invalid.",
    );
  }
}

function normalizeSupportedReader(
  value: unknown,
  options: ParsedSupportedUsageAdapterOptions,
): NormalizedCanonicalUsageSnapshot {
  try {
    const input = ensureRecord(
      snapshotSupportedReaderInput(value),
      "readerResult",
    );
    ensureExactKeys(
      input,
      ["schemaVersion", "reader", "requestedProfileId", "profile", "observation"],
      "readerResult",
    );
    if (input["schemaVersion"] !== ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION) {
      throw new ApplicationError(
        "USAGE_SOURCE_MISMATCH",
        "The Account Manager reader protocol version is unsupported.",
      );
    }
    const reader = ensureRecord(input["reader"], "readerResult.reader");
    ensureExactKeys(
      reader,
      [
        "readerId",
        "protocolVersion",
        "runtimeVersion",
        "repositoryUrl",
        "configurationFingerprint",
      ],
      "readerResult.reader",
    );
    if (
      reader["readerId"] !== ACCOUNT_MANAGER_READER_ID ||
      reader["protocolVersion"] !== ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION ||
      reader["runtimeVersion"] !== ACCOUNT_MANAGER_RUNTIME_VERSION ||
      reader["repositoryUrl"] !== ACCOUNT_MANAGER_REPOSITORY_URL ||
      reader["configurationFingerprint"] !==
        options.expectedConfigurationFingerprint
    ) {
      throw new ApplicationError(
        "USAGE_SOURCE_MISMATCH",
        "The Account Manager reader identity is not the reviewed protocol.",
      );
    }
    const requestedProfileId = finiteId(
      input["requestedProfileId"],
      "readerResult.requestedProfileId",
    );
    const profile = ensureRecord(input["profile"], "readerResult.profile");
    ensureExactKeys(
      profile,
      [
        "scopedProfileId",
        "providerId",
        "ownership",
        "authorization",
        "revocation",
        "authorityEstimate",
      ],
      "readerResult.profile",
    );
    const expected = options.authorizedProfile;
    if (
      requestedProfileId !== expected.profileId ||
      profile["scopedProfileId"] !== expected.profileId ||
      profile["providerId"] !== expected.providerId ||
      profile["ownership"] !== expected.ownership ||
      profile["authorization"] !== expected.authorization ||
      profile["revocation"] !== expected.revocation ||
      profile["authorityEstimate"] !== "caller-allowlist"
    ) {
      throw new ApplicationError(
        "USAGE_PROFILE_MISMATCH",
        "The Account Manager observation does not match the trusted profile authority.",
      );
    }
    const observation = ensureRecord(
      input["observation"],
      "readerResult.observation",
    );
    ensureExactKeys(
      observation,
      [
        "observationId",
        "sourceClass",
        "confidence",
        "timezone",
        "observedAt",
        "freshUntil",
        "fiveHour",
        "weekly",
      ],
      "readerResult.observation",
    );
    const observedAt = ensureTimestamp(
      observation["observedAt"],
      "readerResult.observation.observedAt",
    );
    const freshUntil = ensureTimestamp(
      observation["freshUntil"],
      "readerResult.observation.freshUntil",
    );
    if (
      Date.parse(freshUntil) - Date.parse(observedAt) >
      options.maximumSourceFreshnessMs
    ) {
      throw new ApplicationError(
        "INVALID_USAGE_FIXTURE",
        "The Account Manager source freshness exceeds the configured bound.",
      );
    }
    const sourceClass = ensureEnum(
      observation["sourceClass"],
      "readerResult.observation.sourceClass",
      ["provider-authoritative", "provider-cached"] as const,
    );
    const observationId = finiteId(
      observation["observationId"],
      "readerResult.observation.observationId",
    );
    const fiveHour = parseWindow(
      observation["fiveHour"],
      "readerResult.observation.fiveHour",
    );
    const weekly = parseWindow(
      observation["weekly"],
      "readerResult.observation.weekly",
    );
    const normalizedObservation = Object.freeze({
      observationId,
      sourceClass,
      confidence: ensureEnum(
        observation["confidence"],
        "readerResult.observation.confidence",
        ["high", "low"] as const,
      ),
      timezone: ensureEnum(
        observation["timezone"],
        "readerResult.observation.timezone",
        ["Europe/London"] as const,
      ),
      observedAt,
      freshUntil,
      fiveHour,
      weekly,
    });
    const sourceFingerprint = supportedSourceFingerprint(options);
    const projection = Object.freeze({
      schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
      compatibility: "native-v2" as const,
      sourceAdapterId: "usage:account-manager-reader" as const,
      sourceAdapterVersion: `v${ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION}:${ACCOUNT_MANAGER_RUNTIME_VERSION}`,
      sourceFingerprint,
      sourceClass,
      authoritative: sourceClass === "provider-authoritative",
      confidence: normalizedObservation.confidence,
      profileId: expected.profileId,
      providerId: expected.providerId,
      ownership: expected.ownership,
      authorization: expected.authorization,
      revocation: expected.revocation,
      timezone: normalizedObservation.timezone,
      observedAt,
      freshUntil,
      fiveHour,
      weekly,
    });
    const material = Object.freeze({
      ...projection,
      snapshotId: `usage:${createHash("sha256")
        .update(toCanonicalJson(projection))
        .digest("hex")
        .slice(0, 40)}`,
    });
    return parseCanonicalUsageSnapshot(material);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "INVALID_USAGE_FIXTURE",
      "The Account Manager reader result is malformed or outside the reviewed protocol.",
    );
  }
}

interface ReaderBackedSupportedOptions {
  readonly reader: AccountManagerSupportedReader;
  readonly authorizedProfile: AccountManagerAuthorizedProfile;
  readonly expectedConfigurationFingerprint: string;
  readonly maximumSourceFreshnessMs: number;
  readonly now?: () => Date;
}

function parseReaderBackedOptions(
  rawOptions: ReaderBackedSupportedOptions,
): ParsedSupportedUsageAdapterOptions {
  try {
    if (
      rawOptions === null ||
      typeof rawOptions !== "object" ||
      rawOptions.reader === null ||
      typeof rawOptions.reader !== "object" ||
      rawOptions.reader.fixtureOnly !== false ||
      rawOptions.reader.readerId !== ACCOUNT_MANAGER_READER_ID ||
      rawOptions.reader.protocolVersion !== ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION ||
      rawOptions.reader.runtimeVersion !== ACCOUNT_MANAGER_RUNTIME_VERSION ||
      rawOptions.reader.repositoryUrl !== ACCOUNT_MANAGER_REPOSITORY_URL ||
      typeof rawOptions.reader.readScopedUsage !== "function"
    ) {
      throw new ApplicationError(
        "INVALID_COMMAND",
        "The supported Account Manager reader identity is invalid.",
      );
    }
    const expectedConfigurationFingerprint = finiteSha(
      rawOptions.expectedConfigurationFingerprint,
      "options.expectedConfigurationFingerprint",
    );
    const readerConfigurationFingerprint = finiteSha(
      rawOptions.reader.configurationFingerprint,
      "options.reader.configurationFingerprint",
    );
    if (readerConfigurationFingerprint !== expectedConfigurationFingerprint) {
      throw new ApplicationError(
        "USAGE_SOURCE_MISMATCH",
        "The Account Manager reader configuration is not the trusted route.",
      );
    }
    const authorizedProfile = parseAuthorizedProfile(rawOptions.authorizedProfile);
    if (
      !Number.isSafeInteger(rawOptions.maximumSourceFreshnessMs) ||
      rawOptions.maximumSourceFreshnessMs < 1_000 ||
      rawOptions.maximumSourceFreshnessMs > 15 * 60_000 ||
      (rawOptions.now !== undefined && typeof rawOptions.now !== "function")
    ) {
      throw new ApplicationError(
        "INVALID_COMMAND",
        "The Account Manager reader authority configuration is invalid.",
      );
    }
    const capturedReader = rawOptions.reader;
    const originalRead = capturedReader.readScopedUsage;
    const capturedRead = originalRead.bind(capturedReader);
    const guardedReader: AccountManagerSupportedReader = Object.freeze({
      fixtureOnly: false,
      readerId: ACCOUNT_MANAGER_READER_ID,
      protocolVersion: ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION,
      runtimeVersion: ACCOUNT_MANAGER_RUNTIME_VERSION,
      repositoryUrl: ACCOUNT_MANAGER_REPOSITORY_URL,
      configurationFingerprint: expectedConfigurationFingerprint,
      async readScopedUsage(
        profileId: string,
        request?: UsageSnapshotReadRequest,
      ): Promise<unknown | null> {
        if (
          capturedReader.fixtureOnly !== false ||
          capturedReader.readerId !== ACCOUNT_MANAGER_READER_ID ||
          capturedReader.protocolVersion !== ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION ||
          capturedReader.runtimeVersion !== ACCOUNT_MANAGER_RUNTIME_VERSION ||
          capturedReader.repositoryUrl !== ACCOUNT_MANAGER_REPOSITORY_URL ||
          capturedReader.configurationFingerprint !==
            expectedConfigurationFingerprint ||
          capturedReader.readScopedUsage !== originalRead
        ) {
          throw new ApplicationError(
            "USAGE_SOURCE_MISMATCH",
            "The Account Manager reader identity changed after construction.",
          );
        }
        const result = await capturedRead(profileId, request);
        if (
          capturedReader.fixtureOnly !== false ||
          capturedReader.readerId !== ACCOUNT_MANAGER_READER_ID ||
          capturedReader.protocolVersion !== ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION ||
          capturedReader.runtimeVersion !== ACCOUNT_MANAGER_RUNTIME_VERSION ||
          capturedReader.repositoryUrl !== ACCOUNT_MANAGER_REPOSITORY_URL ||
          capturedReader.configurationFingerprint !==
            expectedConfigurationFingerprint ||
          capturedReader.readScopedUsage !== originalRead
        ) {
          throw new ApplicationError(
            "USAGE_SOURCE_MISMATCH",
            "The Account Manager reader identity changed during the read.",
          );
        }
        return result;
      },
    });
    return Object.freeze({
      reader: guardedReader,
      authorizedProfile,
      expectedConfigurationFingerprint,
      maximumSourceFreshnessMs: rawOptions.maximumSourceFreshnessMs,
      now: rawOptions.now ?? (() => new Date()),
    });
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "INVALID_COMMAND",
      "The Account Manager reader configuration is invalid.",
    );
  }
}

function createSupportedAdapter(
  options: ParsedSupportedUsageAdapterOptions,
): UsageSnapshotAdapter {
  const assertActive = (request?: UsageSnapshotReadRequest): void => {
    if (request === undefined) return;
    try {
      if (
        request.signal === null ||
        typeof request.signal !== "object" ||
        typeof request.signal.aborted !== "boolean" ||
        request.signal.aborted
      ) {
        throw new ApplicationError(
          "USAGE_SOURCE_UNAVAILABLE",
          "The Account Manager usage read was cancelled.",
        );
      }
      const deadline = ensureTimestamp(request.deadline, "request.deadline");
      const current = options.now();
      if (!(current instanceof Date) || !Number.isFinite(current.valueOf())) {
        throw new ApplicationError(
          "USAGE_SOURCE_UNAVAILABLE",
          "The Account Manager usage clock is unavailable.",
        );
      }
      if (current.toISOString() >= deadline) {
        throw new ApplicationError(
          "USAGE_SOURCE_UNAVAILABLE",
          "The Account Manager usage read deadline expired.",
        );
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "USAGE_SOURCE_UNAVAILABLE",
        "The Account Manager usage read boundary is invalid.",
      );
    }
  };

  return Object.freeze({
    adapterId: "usage:account-manager-reader",
    schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
    async readAuthorizedSnapshot(
      profileId: string,
      request?: UsageSnapshotReadRequest,
    ): Promise<NormalizedCanonicalUsageSnapshot | null> {
      let requestedProfileId: string;
      try {
        requestedProfileId = finiteId(profileId, "profileId");
      } catch {
        throw new ApplicationError(
          "INVALID_COMMAND",
          "The requested usage profile identity is invalid.",
        );
      }
      if (requestedProfileId !== options.authorizedProfile.profileId) {
        throw new ApplicationError(
          "USAGE_PROFILE_MISMATCH",
          "The requested profile is outside the configured Account Manager scope.",
        );
      }
      assertActive(request);
      let raw: unknown | null;
      try {
        raw = await options.reader.readScopedUsage(requestedProfileId, request);
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "USAGE_SOURCE_UNAVAILABLE",
          "The Account Manager usage source is unavailable.",
        );
      }
      assertActive(request);
      if (raw === null) return null;
      return normalizeSupportedReader(raw, options);
    },
  });
}

export function createAccountManagerSupportedUsageAdapterForTesting(
  rawOptions: ReaderBackedSupportedOptions,
): UsageSnapshotAdapter {
  return createSupportedAdapter(parseReaderBackedOptions(rawOptions));
}

function loadReviewedAccountManagerReader(
  modulePath: string,
  configuration: AccountManagerReaderConfiguration,
): AccountManagerSupportedReader {
  try {
    const parsedPath = ensureString(modulePath, "options.readerModulePath", {
      maxLength: 1_024,
    });
    if (
      !isAbsolute(parsedPath) ||
      parsedPath.startsWith("\\\\") ||
      parsedPath.startsWith("//")
    ) {
      throw new ApplicationError(
        "USAGE_SOURCE_MISMATCH",
        "The Account Manager reader module path is invalid.",
      );
    }
    const stat = lstatSync(parsedPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1_024) {
      throw new ApplicationError(
        "USAGE_SOURCE_MISMATCH",
        "The Account Manager reader module is not the reviewed artifact.",
      );
    }
    const canonicalPath = realpathSync.native(parsedPath);
    const descriptor = openSync(canonicalPath, "r");
    let sourceBytes: Uint8Array;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size > 64 * 1_024) {
        throw new ApplicationError(
          "USAGE_SOURCE_MISMATCH",
          "The Account Manager reader module is not the reviewed artifact.",
        );
      }
      const bounded = Buffer.alloc(64 * 1_024 + 1);
      let offset = 0;
      while (offset < bounded.byteLength) {
        const count = readSync(
          descriptor,
          bounded,
          offset,
          bounded.byteLength - offset,
          null,
        );
        if (count === 0) break;
        offset += count;
      }
      if (offset > 64 * 1_024 || offset !== opened.size) {
        throw new ApplicationError(
          "USAGE_SOURCE_MISMATCH",
          "The Account Manager reader module is not the reviewed artifact.",
        );
      }
      sourceBytes = bounded.subarray(0, offset);
    } finally {
      closeSync(descriptor);
    }
    const source = new TextDecoder("utf-8", { fatal: true })
      .decode(sourceBytes)
      .replaceAll("\r\n", "\n");
    if (
      source.includes("\r") ||
      createHash("sha256").update(source).digest("hex") !==
        ACCOUNT_MANAGER_SUPPORTED_READER_SHA256
    ) {
      throw new ApplicationError(
        "USAGE_SOURCE_MISMATCH",
        "The Account Manager reader module is not the reviewed artifact.",
      );
    }
    const hostRequire = createRequire(import.meta.url);
    const allowedModules = new Set(["node:crypto", "node:fs", "node:path"]);
    const reviewedRequire = (specifier: string): unknown => {
      if (!allowedModules.has(specifier)) {
        throw new ApplicationError(
          "USAGE_SOURCE_MISMATCH",
          "The Account Manager reader requested an unreviewed dependency.",
        );
      }
      return hostRequire(specifier);
    };
    const commonJsModule = { exports: {} as unknown };
    const wrapper = new Script(
      `(function (exports, require, module, __filename, __dirname) {${source}\n})`,
      { filename: "reviewed-account-manager-usage-reader.cjs" },
    ).runInThisContext() as (
      exports: object,
      require: (specifier: string) => unknown,
      module: { exports: unknown },
      filename: string,
      directory: string,
    ) => void;
    wrapper(
      commonJsModule.exports as object,
      reviewedRequire,
      commonJsModule,
      canonicalPath,
      dirname(canonicalPath),
    );
    const exported = ensureRecord(
      commonJsModule.exports,
      "accountManagerReaderModule",
    );
    if (typeof exported["createScopedUsageReader"] !== "function") {
      throw new ApplicationError(
        "USAGE_SOURCE_MISMATCH",
        "The Account Manager reader module surface is invalid.",
      );
    }
    return exported["createScopedUsageReader"](configuration) as
      AccountManagerSupportedReader;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "USAGE_SOURCE_MISMATCH",
      "The Account Manager reader module could not be verified.",
    );
  }
}

export function createAccountManagerSupportedUsageAdapter(
  rawOptions: AccountManagerSupportedUsageAdapterOptions,
): UsageSnapshotAdapter {
  try {
    const input = ensureRecord(rawOptions, "options");
    ensureExactKeys(
      input,
      [
        "readerModulePath",
        "readerConfiguration",
        "authorizedProfile",
        "expectedConfigurationFingerprint",
        "maximumSourceFreshnessMs",
        "now",
      ],
      "options",
    );
    const reader = loadReviewedAccountManagerReader(
      rawOptions.readerModulePath,
      rawOptions.readerConfiguration,
    );
    return createSupportedAdapter(parseReaderBackedOptions({
      reader,
      authorizedProfile: rawOptions.authorizedProfile,
      expectedConfigurationFingerprint:
        rawOptions.expectedConfigurationFingerprint,
      maximumSourceFreshnessMs: rawOptions.maximumSourceFreshnessMs,
      ...(rawOptions.now === undefined ? {} : { now: rawOptions.now }),
    }));
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "INVALID_COMMAND",
      "The Account Manager reader configuration is invalid.",
    );
  }
}
