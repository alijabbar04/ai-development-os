import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateUsageFreshness } from "@ai-dev-os/scheduler";
import {
  ACCOUNT_MANAGER_COMMIT,
  ACCOUNT_MANAGER_FIXTURE_PROTOCOL_VERSION,
  ACCOUNT_MANAGER_INVENTORY_SHA256,
  ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED,
  ACCOUNT_MANAGER_READER_ID,
  ACCOUNT_MANAGER_REPOSITORY_URL,
  ACCOUNT_MANAGER_RUNTIME_VERSION,
  ACCOUNT_MANAGER_SUPPORTED_READER_ENABLED,
  ACCOUNT_MANAGER_SUPPORTED_COMMIT,
  ACCOUNT_MANAGER_SUPPORTED_TREE,
  ACCOUNT_MANAGER_SUPPORTED_INVENTORY_SHA256,
  ACCOUNT_MANAGER_SUPPORTED_READER_SHA256,
  ACCOUNT_MANAGER_TREE,
  ApplicationError,
  createAccountManagerFixtureUsageAdapter,
  createAccountManagerSupportedUsageAdapter,
  type AccountManagerFixtureReader,
  type AccountManagerSupportedReader,
} from "../src/index.js";
import { createAccountManagerSupportedUsageAdapterForTesting } from "../src/testing/index.js";

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
    expect(ACCOUNT_MANAGER_FIXTURE_PROTOCOL_VERSION).toBe(1);
    expect(adapter.schemaVersion).toBe(3);
    expect(snapshot).toEqual(expect.objectContaining({
      schemaVersion: 3,
      compatibility: "native-v3",
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

const SUPPORTED_CONFIGURATION = "c".repeat(64);

function supportedResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    reader: {
      readerId: ACCOUNT_MANAGER_READER_ID,
      protocolVersion: 2,
      runtimeVersion: ACCOUNT_MANAGER_RUNTIME_VERSION,
      repositoryUrl: ACCOUNT_MANAGER_REPOSITORY_URL,
      configurationFingerprint: SUPPORTED_CONFIGURATION,
    },
    requestedProfileId: "profile:owned",
    profile: {
      scopedProfileId: "profile:owned",
      providerId: "claude-code",
      ownership: "owned",
      authorization: "authorized",
      revocation: "not-revoked",
      authorityEstimate: "caller-allowlist",
    },
    observation: {
      observationId: "am-usage:one",
      sourceClass: "provider-authoritative",
      confidence: "high",
      timezone: "Europe/London",
      observedAt: "2026-10-25T00:59:00.000Z",
      freshUntil: "2026-10-25T01:04:00.000Z",
      fiveHour: {
        windowId: "claude-code:five-hour:2026-10-25T04:00:00.000Z",
        status: "active",
        usedBasisPoints: 5_000,
        remainingBasisPoints: 5_000,
        resetAt: "2026-10-25T04:00:00.000Z",
      },
      weekly: {
        windowId: "claude-code:weekly:2026-10-26T00:00:00.000Z",
        status: "active",
        usedBasisPoints: 7_000,
        remainingBasisPoints: 3_000,
        resetAt: "2026-10-26T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

function supportedReader(
  read: AccountManagerSupportedReader["readScopedUsage"],
  configurationFingerprint = SUPPORTED_CONFIGURATION,
): AccountManagerSupportedReader {
  return Object.freeze({
    fixtureOnly: false,
    readerId: ACCOUNT_MANAGER_READER_ID,
    protocolVersion: 2,
    runtimeVersion: ACCOUNT_MANAGER_RUNTIME_VERSION,
    repositoryUrl: ACCOUNT_MANAGER_REPOSITORY_URL,
    configurationFingerprint,
    readScopedUsage: read,
  });
}

function supportedAdapter(
  read: AccountManagerSupportedReader["readScopedUsage"],
  overrides: Record<string, unknown> = {},
) {
  return createAccountManagerSupportedUsageAdapterForTesting({
    reader: supportedReader(read),
    authorizedProfile: {
      profileId: "profile:owned",
      providerId: "claude-code",
      ownership: "owned",
      authorization: "authorized",
      revocation: "not-revoked",
    },
    expectedConfigurationFingerprint: SUPPORTED_CONFIGURATION,
    maximumSourceFreshnessMs: 300_000,
    ...overrides,
  } as never);
}

describe("supported Account Manager usage-reader protocol", () => {
  it("binds the exact reader route and normalizes 50/70 percent windows across the DST edge", async () => {
    const adapter = supportedAdapter(async () => supportedResult());
    const snapshot = await adapter.readAuthorizedSnapshot("profile:owned");
    expect(ACCOUNT_MANAGER_SUPPORTED_READER_ENABLED).toBe(true);
    expect(ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED).toBe(false);
    expect(adapter.adapterId).toBe("usage:account-manager-reader");
    expect(ACCOUNT_MANAGER_SUPPORTED_COMMIT).toBe(
      "f958ccaee81452f919e7321078899de692f0c81c",
    );
    expect(ACCOUNT_MANAGER_SUPPORTED_TREE).toBe(
      "04c22c65d5839a2c80f716e55f4f41d5ab79c6a7",
    );
    expect(ACCOUNT_MANAGER_SUPPORTED_INVENTORY_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(ACCOUNT_MANAGER_SUPPORTED_READER_SHA256).toBe(
      "ba17ed90c603351c0e3737d9d10552b7571fecd19ff4fd451820111857d3b894",
    );
    expect(snapshot).toEqual(expect.objectContaining({
      schemaVersion: 3,
      compatibility: "native-v3",
      sourceAdapterVersion: "v2:1.4.1",
      sourceClass: "provider-authoritative",
      authoritative: true,
      profileId: "profile:owned",
      providerId: "claude-code",
      timezone: "Europe/London",
      fiveHour: expect.objectContaining({ usedBasisPoints: 5_000 }),
      weekly: expect.objectContaining({ usedBasisPoints: 7_000 }),
    }));
    expect(snapshot?.sourceFingerprint).toBe(
      "1cffe8603aebfb60f10fa2064bf8a85ee0df9bf398fb31ac15c97ee17b1a30de",
    );
    expect(validateUsageFreshness(
      snapshot as never,
      new Date("2026-10-25T01:00:00.000Z"),
      120_000,
    ).eligible).toBe(true);
  });

  it("preserves an inactive required window as null capacity and refuses it for scheduling", async () => {
    const observation = supportedResult().observation as Record<string, unknown>;
    const inactiveResult = supportedResult({
      observation: {
        ...observation,
        fiveHour: {
          windowId: "claude-code:five-hour:inactive",
          status: "inactive",
          usedBasisPoints: null,
          remainingBasisPoints: null,
          resetAt: null,
        },
      },
    });
    const snapshot = await supportedAdapter(async () => inactiveResult)
      .readAuthorizedSnapshot("profile:owned");
    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      compatibility: "native-v3",
      fiveHour: {
        windowId: "claude-code:five-hour:inactive",
        status: "inactive",
        usedBasisPoints: null,
        remainingBasisPoints: null,
        resetAt: null,
      },
      weekly: { status: "active", usedBasisPoints: 7_000 },
    });
    expect(validateUsageFreshness(
      snapshot as never,
      new Date("2026-10-25T01:00:00.000Z"),
      120_000,
    )).toMatchObject({
      eligible: false,
      ruleIds: expect.arrayContaining(["usage.window.inactive"]),
    });
  });

  it("rejects contradictory inactive windows without retaining their supplied values", async () => {
    const observation = supportedResult().observation as Record<string, unknown>;
    for (const fiveHour of [
      {
        windowId: "claude-code:five-hour:contradictory-capacity",
        status: "inactive",
        usedBasisPoints: 1,
        remainingBasisPoints: null,
        resetAt: null,
      },
      {
        windowId: "claude-code:five-hour:contradictory-reset",
        status: "inactive",
        usedBasisPoints: null,
        remainingBasisPoints: null,
        resetAt: "2099-01-01T00:00:00.000Z",
      },
      {
        windowId: "claude-code:five-hour:contradictory-remaining",
        status: "inactive",
        usedBasisPoints: null,
        remainingBasisPoints: 9_999,
        resetAt: null,
      },
    ] as const) {
      const invalid = supportedResult({
        observation: { ...observation, fiveHour },
      });
      const error = await supportedAdapter(async () => invalid)
        .readAuthorizedSnapshot("profile:owned")
        .then(
          () => null,
          (failure: unknown) => failure,
        );
      expect(error).toMatchObject({ code: "INVALID_USAGE_FIXTURE" });
      expect(String((error as Error).message)).not.toContain(
        String(
          fiveHour.usedBasisPoints ??
            fiveHour.remainingBasisPoints ??
            fiveHour.resetAt,
        ),
      );
    }
  });

  it("rejects source, version, profile, authority, and cross-profile substitution", async () => {
    expect(() => createAccountManagerSupportedUsageAdapterForTesting({
      reader: supportedReader(async () => supportedResult(), "d".repeat(64)),
      authorizedProfile: {
        profileId: "profile:owned",
        providerId: "claude-code",
        ownership: "owned",
        authorization: "authorized",
        revocation: "not-revoked",
      },
      expectedConfigurationFingerprint: SUPPORTED_CONFIGURATION,
      maximumSourceFreshnessMs: 300_000,
    })).toThrowError(expect.objectContaining({ code: "USAGE_SOURCE_MISMATCH" }));

    for (const invalid of [
      supportedResult({
        reader: { ...(supportedResult().reader as object), protocolVersion: 1 },
      }),
      supportedResult({
        reader: {
          ...(supportedResult().reader as object),
          configurationFingerprint: "e".repeat(64),
        },
      }),
      supportedResult({ requestedProfileId: "profile:other" }),
      supportedResult({
        profile: {
          ...(supportedResult().profile as object),
          authorityEstimate: "reader-self-assertion",
        },
      }),
      supportedResult({
        profile: {
          ...(supportedResult().profile as object),
          authorization: "ambiguous",
        },
      }),
    ]) {
      await expect(
        supportedAdapter(async () => invalid).readAuthorizedSnapshot("profile:owned"),
      ).rejects.toBeInstanceOf(ApplicationError);
    }
    await expect(
      supportedAdapter(async () => supportedResult())
        .readAuthorizedSnapshot("profile:other"),
    ).rejects.toMatchObject({ code: "USAGE_PROFILE_MISMATCH" });
  });

  it("refuses an unreviewed module before constructing a reader", () => {
    const options = {
      readerModulePath: resolve(import.meta.dirname, "account-manager-usage.test.ts"),
      readerConfiguration: {
        schemaVersion: 2,
        dataDirectory: "C:\\task-owned",
        profileAllowlist: [{
          profileId: "profile:owned",
          providerId: "claude-code",
          ownership: "owned",
          authorization: "authorized",
          revocation: "not-revoked",
        }],
        freshnessMs: 300_000,
      },
      authorizedProfile: {
        profileId: "profile:owned",
        providerId: "claude-code",
        ownership: "owned",
        authorization: "authorized",
        revocation: "not-revoked",
      },
      expectedConfigurationFingerprint: SUPPORTED_CONFIGURATION,
      maximumSourceFreshnessMs: 300_000,
    } as const;
    expect(() => createAccountManagerSupportedUsageAdapter(options))
      .toThrowError(expect.objectContaining({ code: "USAGE_SOURCE_MISMATCH" }));
    expect(() => createAccountManagerSupportedUsageAdapter({
      ...options,
      readerModulePath: "\\\\server\\share\\usage-reader.cjs",
    })).toThrowError(expect.objectContaining({ code: "USAGE_SOURCE_MISMATCH" }));
    expect(() => createAccountManagerSupportedUsageAdapter({
      ...options,
      readerModulePath: resolve(import.meta.dirname, ".."),
    })).toThrowError(expect.objectContaining({ code: "USAGE_SOURCE_MISMATCH" }));
    expect(() => createAccountManagerSupportedUsageAdapter({
      ...options,
      readerModulePath: resolve(import.meta.dirname, "missing-reader.cjs"),
    })).toThrowError(expect.objectContaining({ code: "USAGE_SOURCE_MISMATCH" }));
    expect(() => createAccountManagerSupportedUsageAdapter({
      ...options,
      secretCanary: true,
    } as never)).toThrowError(expect.objectContaining({ code: "INVALID_COMMAND" }));
  });

  it("loads the exact pinned public reader against one bounded synthetic store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aidos-am-public-reader-"));
    try {
      const profileId = "profile:owned";
      const fetchedAt = Date.now() - 1_000;
      writeFileSync(join(directory, "profiles.json"), JSON.stringify({
        version: 1,
        profiles: [{
          id: profileId,
          name: "must-not-leak",
          configDir: "C:\\must-not-leak",
          createdAt: "2026-08-01T00:00:00.000Z",
        }],
      }));
      writeFileSync(join(directory, "usage-snapshots.json"), JSON.stringify({
        [profileId]: {
          fetchedAt,
          ok: true,
          limits: [
            {
              kind: "session",
              percent: 50,
              severity: "normal",
              resetsAt: new Date(fetchedAt + 3_600_000).toISOString(),
            },
            {
              kind: "weekly_all",
              percent: 70,
              severity: "normal",
              resetsAt: new Date(fetchedAt + 7 * 86_400_000).toISOString(),
            },
          ],
        },
      }));
      const authorizedProfile = {
        profileId,
        providerId: "claude-code" as const,
        ownership: "owned" as const,
        authorization: "authorized" as const,
        revocation: "not-revoked" as const,
      };
      const readerConfiguration = {
        schemaVersion: 2 as const,
        dataDirectory: directory,
        profileAllowlist: [authorizedProfile],
        freshnessMs: 300_000,
      };
      const modulePath = resolve(
        import.meta.dirname,
        "fixtures",
        "account-manager-usage-reader.cjs",
      );
      const exported = createRequire(import.meta.url)(modulePath) as {
        createScopedUsageReader(configuration: unknown): {
          configurationFingerprint: string;
        };
      };
      const expectedConfigurationFingerprint = exported
        .createScopedUsageReader(readerConfiguration)
        .configurationFingerprint;
      const adapter = createAccountManagerSupportedUsageAdapter({
        readerModulePath: modulePath,
        readerConfiguration,
        authorizedProfile,
        expectedConfigurationFingerprint,
        maximumSourceFreshnessMs: 300_000,
      });
      const publicSnapshot = await adapter.readAuthorizedSnapshot(profileId);
      expect(publicSnapshot).toEqual(expect.objectContaining({
        sourceAdapterId: "usage:account-manager-reader",
        providerId: "claude-code",
        profileId,
        fiveHour: expect.objectContaining({ usedBasisPoints: 5_000 }),
        weekly: expect.objectContaining({ usedBasisPoints: 7_000 }),
      }));

      const normalizedReader = join(directory, "normalized-reader.cjs");
      const reviewedSource = readFileSync(modulePath, "utf8")
        .replaceAll("\r\n", "\n");
      expect(reviewedSource).not.toContain("\r");
      writeFileSync(normalizedReader, reviewedSource.replaceAll("\n", "\r\n"));
      const normalizedAdapter = createAccountManagerSupportedUsageAdapter({
        readerModulePath: normalizedReader,
        readerConfiguration,
        authorizedProfile,
        expectedConfigurationFingerprint,
        maximumSourceFreshnessMs: 300_000,
      });
      const normalizedSnapshot = await normalizedAdapter
        .readAuthorizedSnapshot(profileId);
      expect(normalizedSnapshot).toMatchObject({
        sourceFingerprint: publicSnapshot!.sourceFingerprint,
        profileId,
      });

      const substituted = join(directory, "substituted-reader.cjs");
      writeFileSync(substituted, `${reviewedSource} `);
      expect(() => createAccountManagerSupportedUsageAdapter({
        readerModulePath: substituted,
        readerConfiguration,
        authorizedProfile,
        expectedConfigurationFingerprint,
        maximumSourceFreshnessMs: 300_000,
      })).toThrowError(expect.objectContaining({ code: "USAGE_SOURCE_MISMATCH" }));

      const oversized = join(directory, "oversized-reader.cjs");
      writeFileSync(oversized, Buffer.alloc(64 * 1_024 + 1, 0x78));
      expect(() => createAccountManagerSupportedUsageAdapter({
        readerModulePath: oversized,
        readerConfiguration,
        authorizedProfile,
        expectedConfigurationFingerprint,
        maximumSourceFreshnessMs: 300_000,
      })).toThrowError(expect.objectContaining({ code: "USAGE_SOURCE_MISMATCH" }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds authority into snapshot identity and rejects reader drift", async () => {
    const owned = await supportedAdapter(async () => supportedResult())
      .readAuthorizedSnapshot("profile:owned");
    const alternateConfiguration = "d".repeat(64);
    const alternateResult = supportedResult({
      reader: {
        ...(supportedResult().reader as object),
        configurationFingerprint: alternateConfiguration,
      },
    });
    const alternate = await createAccountManagerSupportedUsageAdapterForTesting({
      reader: supportedReader(async () => alternateResult, alternateConfiguration),
      authorizedProfile: {
        profileId: "profile:owned",
        providerId: "claude-code",
        ownership: "owned",
        authorization: "authorized",
        revocation: "not-revoked",
      },
      expectedConfigurationFingerprint: alternateConfiguration,
      maximumSourceFreshnessMs: 300_000,
    }).readAuthorizedSnapshot("profile:owned");
    expect(alternate?.sourceFingerprint).not.toBe(owned?.sourceFingerprint);
    expect(alternate?.snapshotId).not.toBe(owned?.snapshotId);
    const borrowedResult = supportedResult({
      profile: {
        ...(supportedResult().profile as object),
        ownership: "authorized-borrowed",
      },
    });
    const borrowed = await supportedAdapter(
      async () => borrowedResult,
      {
        authorizedProfile: {
          profileId: "profile:owned",
          providerId: "claude-code",
          ownership: "authorized-borrowed",
          authorization: "authorized",
          revocation: "not-revoked",
        },
      },
    ).readAuthorizedSnapshot("profile:owned");
    expect(borrowed?.snapshotId).not.toBe(owned?.snapshotId);

    const mutable = {
      fixtureOnly: false as const,
      readerId: ACCOUNT_MANAGER_READER_ID,
      protocolVersion: 2 as const,
      runtimeVersion: ACCOUNT_MANAGER_RUNTIME_VERSION,
      repositoryUrl: ACCOUNT_MANAGER_REPOSITORY_URL,
      configurationFingerprint: SUPPORTED_CONFIGURATION,
      async readScopedUsage() { return supportedResult(); },
    };
    const drifted = createAccountManagerSupportedUsageAdapterForTesting({
      reader: mutable,
      authorizedProfile: {
        profileId: "profile:owned",
        providerId: "claude-code",
        ownership: "owned",
        authorization: "authorized",
        revocation: "not-revoked",
      },
      expectedConfigurationFingerprint: SUPPORTED_CONFIGURATION,
      maximumSourceFreshnessMs: 300_000,
    });
    mutable.readScopedUsage = async () => supportedResult({ requestedProfileId: "drift" });
    await expect(drifted.readAuthorizedSnapshot("profile:owned"))
      .rejects.toMatchObject({ code: "USAGE_SOURCE_MISMATCH" });

    const duringRead = {
      fixtureOnly: false as const,
      readerId: ACCOUNT_MANAGER_READER_ID,
      protocolVersion: 2 as const,
      runtimeVersion: ACCOUNT_MANAGER_RUNTIME_VERSION,
      repositoryUrl: ACCOUNT_MANAGER_REPOSITORY_URL,
      configurationFingerprint: SUPPORTED_CONFIGURATION,
      async readScopedUsage() {
        duringRead.configurationFingerprint = "d".repeat(64);
        return supportedResult();
      },
    };
    const guarded = createAccountManagerSupportedUsageAdapterForTesting({
      reader: duringRead,
      authorizedProfile: {
        profileId: "profile:owned",
        providerId: "claude-code",
        ownership: "owned",
        authorization: "authorized",
        revocation: "not-revoked",
      },
      expectedConfigurationFingerprint: SUPPORTED_CONFIGURATION,
      maximumSourceFreshnessMs: 300_000,
    });
    await expect(guarded.readAuthorizedSnapshot("profile:owned"))
      .rejects.toMatchObject({ code: "USAGE_SOURCE_MISMATCH" });
  });

  it("bounds and exactly projects authorized profile configuration", () => {
    const exact = {
      profileId: "profile:owned",
      providerId: "claude-code",
      ownership: "owned",
      authorization: "authorized",
      revocation: "not-revoked",
    };
    let getterCalls = 0;
    const accessor = { ...exact } as Record<string, unknown>;
    Object.defineProperty(accessor, "profileId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "profile:owned";
      },
    });
    const symbol = { ...exact, [Symbol("secret")]: true };
    const proxy = new Proxy({ ...exact }, {
      ownKeys() { throw new Error("secret-authority-canary"); },
    });
    const wide = {
      ...exact,
      ...Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`extra${index}`, index]),
      ),
    };
    for (const authorizedProfile of [
      { ...exact, extra: true },
      accessor,
      symbol,
      proxy,
      wide,
    ]) {
      expect(() => supportedAdapter(async () => supportedResult(), {
        authorizedProfile,
      })).toThrowError(expect.objectContaining({ code: "INVALID_COMMAND" }));
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects malformed, duplicate, negative, contradictory, and over-fresh evidence", async () => {
    const observation = supportedResult().observation as Record<string, unknown>;
    const fiveHour = observation.fiveHour as Record<string, unknown>;
    const cases = [
      [supportedResult({ secretCanary: true }), "INVALID_USAGE_FIXTURE"],
      [[supportedResult(), supportedResult()], "INVALID_USAGE_FIXTURE"],
      [supportedResult({
        observation: {
          ...observation,
          fiveHour: { ...fiveHour, usedBasisPoints: -1, remainingBasisPoints: 10_001 },
        },
      }), "INVALID_USAGE_FIXTURE"],
      [supportedResult({
        observation: {
          ...observation,
          fiveHour: { ...fiveHour, remainingBasisPoints: 4_999 },
        },
      }), "INVALID_USAGE_FIXTURE"],
      [supportedResult({
        observation: {
          ...observation,
          freshUntil: "2026-10-25T01:10:00.000Z",
        },
      }), "INVALID_USAGE_FIXTURE"],
    ] as const;
    for (const [value, code] of cases) {
      await expect(
        supportedAdapter(async () => value).readAuthorizedSnapshot("profile:owned"),
      ).rejects.toMatchObject({ code });
    }
  });

  it("rejects accessors, proxies, cycles, and excessive nesting before normalization", async () => {
    let getterCalls = 0;
    const accessor = supportedResult();
    Object.defineProperty(accessor, "observation", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return supportedResult().observation;
      },
    });
    await expect(
      supportedAdapter(async () => accessor).readAuthorizedSnapshot("profile:owned"),
    ).rejects.toMatchObject({ code: "INVALID_USAGE_FIXTURE" });
    expect(getterCalls).toBe(0);

    const proxy = new Proxy(supportedResult(), {
      ownKeys() {
        throw new Error("secret-proxy-canary");
      },
    });
    let proxyFailure: unknown;
    try {
      await supportedAdapter(async () => proxy)
        .readAuthorizedSnapshot("profile:owned");
    } catch (error) {
      proxyFailure = error;
    }
    expect(proxyFailure).toMatchObject({ code: "INVALID_USAGE_FIXTURE" });
    expect(JSON.stringify(proxyFailure)).not.toContain("secret-proxy-canary");

    const cycle: Record<string, unknown> = supportedResult();
    cycle["cycle"] = cycle;
    await expect(
      supportedAdapter(async () => cycle).readAuthorizedSnapshot("profile:owned"),
    ).rejects.toMatchObject({ code: "INVALID_USAGE_FIXTURE" });

    let nested: Record<string, unknown> = { value: "leaf" };
    for (let depth = 0; depth < 14; depth += 1) nested = { nested };
    await expect(
      supportedAdapter(async () => supportedResult({ nested }))
        .readAuthorizedSnapshot("profile:owned"),
    ).rejects.toMatchObject({ code: "INVALID_USAGE_FIXTURE" });

    const tooManyFields = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`field${index}`, index]),
    );
    const arrayWithExtra = [supportedResult()] as unknown[] & { extra?: string };
    arrayWithExtra.extra = "refuse";
    for (const value of [
      supportedResult({ oversized: "x".repeat(16_385) }),
      Array.from({ length: 65 }, () => null),
      arrayWithExtra,
      new Date(),
      tooManyFields,
      supportedResult({ schemaVersion: 3 }),
    ]) {
      await expect(
        supportedAdapter(async () => value).readAuthorizedSnapshot("profile:owned"),
      ).rejects.toMatchObject({ code: expect.any(String) });
    }
  });

  it("preserves cached, stale, future, and revoked evidence for scheduler refusal", async () => {
    const observation = supportedResult().observation as Record<string, unknown>;
    const profile = supportedResult().profile as Record<string, unknown>;
    const cases = [
      supportedResult({
        observation: {
          ...observation,
          sourceClass: "provider-cached",
          confidence: "low",
        },
      }),
      supportedResult({
        observation: {
          ...observation,
          observedAt: "2026-10-25T00:00:00.000Z",
          freshUntil: "2026-10-25T00:05:00.000Z",
        },
      }),
      supportedResult({
        observation: {
          ...observation,
          observedAt: "2026-10-25T01:01:00.000Z",
          freshUntil: "2026-10-25T01:04:00.000Z",
        },
      }),
      supportedResult({ profile: { ...profile, revocation: "revoked" } }),
    ];
    const expected = [
      "usage.authority.required",
      "usage.stale.refused",
      "usage.future.refused",
      "USAGE_PROFILE_MISMATCH",
    ];
    for (let index = 0; index < cases.length; index += 1) {
      try {
        const snapshot = await supportedAdapter(async () => cases[index])
          .readAuthorizedSnapshot("profile:owned");
        expect(validateUsageFreshness(
          snapshot as never,
          new Date("2026-10-25T01:00:00.000Z"),
          120_000,
        ).ruleIds).toContain(expected[index]);
      } catch (error) {
        expect(error).toMatchObject({ code: expected[index] });
      }
    }
  });

  it("contains reader failure/restart and cancellation with finite redacted errors", async () => {
    const canary = "secret-reader-canary";
    let calls = 0;
    const adapter = supportedAdapter(async () => {
      calls += 1;
      if (calls === 1) throw new Error(canary);
      return supportedResult();
    });
    let caught: unknown;
    try {
      await adapter.readAuthorizedSnapshot("profile:owned");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "USAGE_SOURCE_UNAVAILABLE" });
    expect(JSON.stringify(caught)).not.toContain(canary);
    await expect(adapter.readAuthorizedSnapshot("profile:owned"))
      .resolves.toMatchObject({ profileId: "profile:owned" });

    const controller = new AbortController();
    controller.abort();
    await expect(adapter.readAuthorizedSnapshot("profile:owned", {
      signal: controller.signal,
      deadline: "2026-10-25T01:01:00.000Z",
    })).rejects.toMatchObject({ code: "USAGE_SOURCE_UNAVAILABLE" });
    expect(calls).toBe(2);

    const clock = [
      new Date("2026-10-25T01:00:00.000Z"),
      new Date("2026-10-25T01:00:02.000Z"),
    ];
    const expiring = supportedAdapter(
      async () => supportedResult(),
      { now: () => clock.shift() ?? new Date("2026-10-25T01:00:02.000Z") },
    );
    await expect(expiring.readAuthorizedSnapshot("profile:owned", {
      signal: new AbortController().signal,
      deadline: "2026-10-25T01:00:01.000Z",
    })).rejects.toMatchObject({ code: "USAGE_SOURCE_UNAVAILABLE" });

    await expect(supportedAdapter(async () => null)
      .readAuthorizedSnapshot("profile:owned"))
      .resolves.toBeNull();
    await expect(supportedAdapter(async () => supportedResult())
      .readAuthorizedSnapshot("bad profile"))
      .rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(supportedAdapter(
      async () => supportedResult(),
      { now: () => new Date(Number.NaN) },
    ).readAuthorizedSnapshot("profile:owned", {
      signal: new AbortController().signal,
      deadline: "2099-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "USAGE_SOURCE_UNAVAILABLE" });
    await expect(supportedAdapter(async () => supportedResult())
      .readAuthorizedSnapshot("profile:owned", {
        signal: new AbortController().signal,
        deadline: "not-a-timestamp",
      })).rejects.toMatchObject({ code: "USAGE_SOURCE_UNAVAILABLE" });

    expect(() => createAccountManagerSupportedUsageAdapterForTesting({
      reader: {} as never,
      authorizedProfile: {
        profileId: "profile:owned",
        providerId: "claude-code",
        ownership: "owned",
        authorization: "authorized",
        revocation: "not-revoked",
      },
      expectedConfigurationFingerprint: SUPPORTED_CONFIGURATION,
      maximumSourceFreshnessMs: 300_000,
    })).toThrowError(expect.objectContaining({ code: "INVALID_COMMAND" }));
    expect(() => supportedAdapter(async () => supportedResult(), {
      maximumSourceFreshnessMs: 999,
    })).toThrowError(expect.objectContaining({ code: "INVALID_COMMAND" }));
  });
});
