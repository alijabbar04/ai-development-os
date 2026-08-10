import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import {
  USAGE_SNAPSHOT_SCHEMA_VERSION,
  parseCanonicalUsageSnapshot,
  type NormalizedCanonicalUsageSnapshot,
  type UsageSnapshotAdapter,
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

export interface AccountManagerFixtureReader {
  readonly fixtureOnly: true;
  readScopedUsage(profileId: string): Promise<unknown | null>;
}

export interface AccountManagerUsageAdapterOptions {
  readonly reader: AccountManagerFixtureReader;
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
