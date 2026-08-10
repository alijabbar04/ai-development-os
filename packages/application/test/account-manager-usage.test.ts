import { describe, expect, it } from "vitest";
import { validateUsageFreshness } from "@ai-dev-os/scheduler";
import {
  ACCOUNT_MANAGER_COMMIT,
  ACCOUNT_MANAGER_INVENTORY_SHA256,
  ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED,
  ACCOUNT_MANAGER_REPOSITORY_URL,
  ACCOUNT_MANAGER_RUNTIME_VERSION,
  ACCOUNT_MANAGER_TREE,
  ApplicationError,
  createAccountManagerFixtureUsageAdapter,
  type AccountManagerFixtureReader,
} from "../src/index.js";

const NOW = "2026-08-10T10:00:00.000Z";

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    observationId: "observation:one",
    source: {
      repositoryUrl: ACCOUNT_MANAGER_REPOSITORY_URL,
      commitSha: ACCOUNT_MANAGER_COMMIT,
      treeSha: ACCOUNT_MANAGER_TREE,
      inventorySha256: ACCOUNT_MANAGER_INVENTORY_SHA256,
      runtimeVersion: ACCOUNT_MANAGER_RUNTIME_VERSION,
    },
    requestedProfileId: "profile:borrowed",
    profile: {
      scopedProfileId: "profile:borrowed",
      scopeClass: "opaque-local-id",
      providerId: "provider:claude-code",
      ownership: "authorized-borrowed",
      authorization: "authorized",
      revocation: "not-revoked",
    },
    observation: {
      sourceClass: "provider-authoritative",
      confidence: "high",
      timezone: "Europe/London",
      observedAt: "2026-08-10T09:59:00.000Z",
      freshUntil: "2026-08-10T10:14:00.000Z",
      fiveHour: {
        windowId: "window:five-hour:one",
        usedBasisPoints: 2_000,
        remainingBasisPoints: 8_000,
        resetAt: "2026-08-10T13:00:00.000Z",
      },
      weekly: {
        windowId: "window:weekly:one",
        usedBasisPoints: 3_000,
        remainingBasisPoints: 7_000,
        resetAt: "2026-08-17T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

function reader(value: unknown | null): AccountManagerFixtureReader {
  return Object.freeze({
    fixtureOnly: true as const,
    readScopedUsage: async () => value,
  });
}

describe("commit-pinned Account Manager fixture adapter", () => {
  it("normalizes one source-bound opaque profile observation without secret fields", async () => {
    const adapter = createAccountManagerFixtureUsageAdapter({ reader: reader(fixture()) });
    const snapshot = await adapter.readAuthorizedSnapshot("profile:borrowed");
    expect(ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED).toBe(false);
    expect(adapter.schemaVersion).toBe(2);
    expect(snapshot).toEqual(expect.objectContaining({
      schemaVersion: 2,
      compatibility: "native-v2",
      sourceFingerprint: ACCOUNT_MANAGER_INVENTORY_SHA256,
      profileId: "profile:borrowed",
      authorization: "authorized",
      revocation: "not-revoked",
    }));
    expect(JSON.stringify(snapshot)).not.toMatch(/credential|cookie|token|session|email/i);
    expect(validateUsageFreshness(snapshot as never, new Date(NOW), 120_000).eligible).toBe(true);
  });

  it("returns null for missing data and rejects duplicate observations", async () => {
    await expect(
      createAccountManagerFixtureUsageAdapter({ reader: reader(null) })
        .readAuthorizedSnapshot("profile:borrowed"),
    ).resolves.toBeNull();
    await expect(
      createAccountManagerFixtureUsageAdapter({ reader: reader([fixture(), fixture()]) })
        .readAuthorizedSnapshot("profile:borrowed"),
    ).rejects.toMatchObject({ code: "USAGE_DUPLICATE" });
  });

  it("fails closed for cross-profile and non-opaque identity", async () => {
    const crossProfile = fixture({ requestedProfileId: "profile:other" });
    await expect(
      createAccountManagerFixtureUsageAdapter({ reader: reader(crossProfile) })
        .readAuthorizedSnapshot("profile:borrowed"),
    ).rejects.toMatchObject({ code: "USAGE_PROFILE_MISMATCH" });
    const badScope = fixture({
      profile: { ...(fixture()["profile"] as object), scopeClass: "email" },
    });
    await expect(
      createAccountManagerFixtureUsageAdapter({ reader: reader(badScope) })
        .readAuthorizedSnapshot("profile:borrowed"),
    ).rejects.toMatchObject({ code: "USAGE_PROFILE_MISMATCH" });
  });

  it("rejects source drift, malformed data, partial windows, and contradictory totals", async () => {
    const drift = fixture({
      source: { ...(fixture()["source"] as object), commitSha: "b".repeat(40) },
    });
    await expect(
      createAccountManagerFixtureUsageAdapter({ reader: reader(drift) })
        .readAuthorizedSnapshot("profile:borrowed"),
    ).rejects.toMatchObject({ code: "USAGE_SOURCE_MISMATCH" });

    for (const invalid of [
      { ...fixture(), credential: "canary-secret" },
      { ...fixture(), schemaVersion: 9 },
      fixture({ observation: { ...(fixture()["observation"] as object), fiveHour: null } }),
      fixture({
        observation: {
          ...(fixture()["observation"] as object),
          fiveHour: {
            windowId: "window:five-hour:one",
            usedBasisPoints: -1,
            remainingBasisPoints: 10_001,
            resetAt: "2026-08-10T13:00:00.000Z",
          },
        },
      }),
      fixture({
        observation: {
          ...(fixture()["observation"] as object),
          weekly: {
            windowId: "window:weekly:one",
            usedBasisPoints: 3_000,
            remainingBasisPoints: 6_999,
            resetAt: "2026-08-17T00:00:00.000Z",
          },
        },
      }),
    ]) {
      await expect(
        createAccountManagerFixtureUsageAdapter({ reader: reader(invalid) })
          .readAuthorizedSnapshot("profile:borrowed"),
      ).rejects.toMatchObject({ code: "INVALID_USAGE_FIXTURE" });
    }
  });

  it("preserves estimated, revoked, future, and stale evidence so policy can refuse it", async () => {
    const baseProfile = fixture()["profile"] as Record<string, unknown>;
    const baseObservation = fixture()["observation"] as Record<string, unknown>;
    const cases = [
      fixture({ observation: { ...baseObservation, sourceClass: "estimated", confidence: "low" } }),
      fixture({ profile: { ...baseProfile, revocation: "revoked" } }),
      fixture({ observation: { ...baseObservation, observedAt: "2026-08-10T10:01:00.000Z" } }),
      fixture({ observation: { ...baseObservation, observedAt: "2026-08-10T09:00:00.000Z" } }),
    ];
    const expectedRules = [
      "usage.authority.required",
      "usage.revocation.refused",
      "usage.future.refused",
      "usage.stale.refused",
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const snapshot = await createAccountManagerFixtureUsageAdapter({ reader: reader(cases[index]) })
        .readAuthorizedSnapshot("profile:borrowed");
      expect(
        validateUsageFreshness(snapshot as never, new Date(NOW), 120_000).ruleIds,
      ).toContain(expectedRules[index]);
    }
  });

  it("exposes only finite redacted errors", async () => {
    const canary = "secret-canary-property";
    let caught: unknown;
    try {
      await createAccountManagerFixtureUsageAdapter({
        reader: reader({ ...fixture(), [canary]: true }),
      }).readAuthorizedSnapshot("profile:borrowed");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationError);
    expect(JSON.stringify(caught)).not.toContain(canary);
    expect(String((caught as Error).message)).not.toContain(canary);

    const throwingReader: AccountManagerFixtureReader = Object.freeze({
      fixtureOnly: true,
      readScopedUsage: async () => {
        throw new Error(canary);
      },
    });
    let sourceFailure: unknown;
    try {
      await createAccountManagerFixtureUsageAdapter({ reader: throwingReader })
        .readAuthorizedSnapshot("profile:borrowed");
    } catch (error) {
      sourceFailure = error;
    }
    expect(sourceFailure).toMatchObject({ code: "USAGE_SOURCE_UNAVAILABLE" });
    expect(JSON.stringify(sourceFailure)).not.toContain(canary);
    expect(String((sourceFailure as Error).message)).not.toContain(canary);
  });

  it("rejects invalid construction, profile commands, and oversized batches with finite codes", async () => {
    expect(() => createAccountManagerFixtureUsageAdapter({ reader: {} as never }))
      .toThrowError(expect.objectContaining({ code: "INVALID_COMMAND" }));
    const adapter = createAccountManagerFixtureUsageAdapter({ reader: reader(fixture()) });
    await expect(adapter.readAuthorizedSnapshot("bad profile"))
      .rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(createAccountManagerFixtureUsageAdapter({
      reader: reader([fixture(), fixture(), fixture()]),
    }).readAuthorizedSnapshot("profile:borrowed"))
      .rejects.toMatchObject({ code: "INVALID_USAGE_FIXTURE" });
  });
});
