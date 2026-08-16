import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isLondonWorkHours } from "@ai-dev-os/scheduler";

import {
  ACCOUNT_MANAGER_REPOSITORY_URL,
  ACCOUNT_MANAGER_RUNTIME_VERSION,
  ACCOUNT_MANAGER_SUPPORTED_COMMIT,
  ACCOUNT_MANAGER_SUPPORTED_INVENTORY_SHA256,
  ACCOUNT_MANAGER_SUPPORTED_READER_SHA256,
  ACCOUNT_MANAGER_SUPPORTED_TREE,
  ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION,
} from "../src/account-manager-usage.js";
import {
  EXPECTED_REPOSITORY_URL,
  EXPECTED_RUNTIME_VERSION,
  EXPECTED_SUPPORTED_COMMIT,
  EXPECTED_SUPPORTED_INVENTORY_SHA256,
  EXPECTED_SUPPORTED_READER_SHA256,
  EXPECTED_SUPPORTED_TREE,
  EXPECTED_USAGE_PROTOCOL_VERSION,
  NPM_AUDIT_ARGS,
  NPM_INSTALL_ARGS,
  NPM_LS_ARGS,
  NPM_REBUILD_BETTER_SQLITE3_ARGS,
  OUTSIDE_WORK_HOURS_NOW,
  REGISTRY_PINS,
  REPOSITORY_PACKAGES,
  WORK_HOURS_NOW,
  buildConsumerManifest,
  buildProfilesStore,
  buildReaderConfiguration,
  buildRouteCandidate,
  buildRoutingSnapshot,
  buildUsageStore,
  normalizedReaderIdentity,
  npmPackArgs,
  renderEvidence,
  validateTarballFileList,
} from "../scripts/packed-consumer/lib.mjs";

const readerFixturePath = resolve(
  import.meta.dirname,
  "fixtures",
  "account-manager-usage-reader.cjs",
);

describe("AM-02 packed-consumer deterministic helpers", () => {
  it("keeps the consumer registry pins equal to the repository lockfile", () => {
    const lockfile = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "..", "..", "package-lock.json"), "utf8"),
    ) as { packages?: Record<string, { version?: string }> };
    const packages = lockfile.packages ?? {};
    expect(
      packages["packages/persistence-sqlite/node_modules/better-sqlite3"]?.version,
    ).toBe(REGISTRY_PINS["better-sqlite3"]);
    expect(packages["node_modules/pg"]?.version).toBe(REGISTRY_PINS["pg"]);
    expect(packages["node_modules/pg-pool"]?.version).toBe(REGISTRY_PINS["pg-pool"]);
  });

  it("pins the exact Account Manager identities the application compiles in", () => {
    expect(EXPECTED_SUPPORTED_COMMIT).toBe(ACCOUNT_MANAGER_SUPPORTED_COMMIT);
    expect(EXPECTED_SUPPORTED_TREE).toBe(ACCOUNT_MANAGER_SUPPORTED_TREE);
    expect(EXPECTED_SUPPORTED_INVENTORY_SHA256).toBe(
      ACCOUNT_MANAGER_SUPPORTED_INVENTORY_SHA256,
    );
    expect(EXPECTED_SUPPORTED_READER_SHA256).toBe(
      ACCOUNT_MANAGER_SUPPORTED_READER_SHA256,
    );
    expect(EXPECTED_USAGE_PROTOCOL_VERSION).toBe(
      ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION,
    );
    expect(EXPECTED_RUNTIME_VERSION).toBe(ACCOUNT_MANAGER_RUNTIME_VERSION);
    expect(EXPECTED_REPOSITORY_URL).toBe(ACCOUNT_MANAGER_REPOSITORY_URL);
  });

  it("matches the committed reader fixture to the pinned published reader digest", () => {
    const identity = normalizedReaderIdentity(readFileSync(readerFixturePath, "utf8"));
    expect(identity.sha256).toBe(EXPECTED_SUPPORTED_READER_SHA256);
    expect(identity.normalizedBytes).toBe(22_845);
    expect(() => normalizedReaderIdentity("bare\rreturn")).toThrowError(/carriage return/);
  });

  it("accepts only package.json, README.md, and dist entries in a tarball", () => {
    expect(
      validateTarballFileList([
        "package.json",
        "README.md",
        "dist/index.js",
        "dist\\testing\\index.d.ts",
      ]).ok,
    ).toBe(true);
    const rejected = validateTarballFileList([
      "package.json",
      "dist/index.js",
      "test/fixtures/account-manager-usage-reader.cjs",
      "src/index.ts",
      "scripts/packed-consumer/lib.mjs",
    ]);
    expect(rejected.ok).toBe(false);
    expect(rejected.offending).toEqual([
      "test/fixtures/account-manager-usage-reader.cjs",
      "src/index.ts",
      "scripts/packed-consumer/lib.mjs",
    ]);
    const traversal = validateTarballFileList(["dist/../escape.js", "dist\\..\\escape.js"]);
    expect(traversal.ok).toBe(false);
    expect(traversal.offending).toEqual(["dist/../escape.js", "dist/../escape.js"]);
  });

  it("builds an exact reproducible consumer manifest", () => {
    const relativePaths = Object.fromEntries(
      REPOSITORY_PACKAGES.map((definition) => [
        definition.name,
        `tarballs\\${definition.name.replace("@ai-dev-os/", "ai-dev-os-")}-0.1.0.tgz`,
      ]),
    );
    const manifest = buildConsumerManifest(relativePaths);
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(Object.keys(manifest.dependencies)).toHaveLength(
      REPOSITORY_PACKAGES.length + Object.keys(REGISTRY_PINS).length,
    );
    expect(manifest.dependencies["@ai-dev-os/application"]).toBe(
      "file:tarballs/ai-dev-os-application-0.1.0.tgz",
    );
    expect(manifest.dependencies["better-sqlite3"]).toBe("12.11.1");
    expect(manifest.dependencies["pg"]).toBe("8.23.0");
    expect(manifest.dependencies["pg-pool"]).toBe("3.14.0");
    expect(() =>
      buildConsumerManifest({ ...relativePaths, "@ai-dev-os/domain": "../escape.tgz" }),
    ).toThrowError(/invalid tarball path/i);
    expect(() => buildConsumerManifest({})).toThrowError(/Missing or invalid/);
  });

  it("builds reader-shaped synthetic stores, including the inactive projection", () => {
    expect(buildProfilesStore("profile:x")).toMatchObject({
      version: 1,
      profiles: [{ id: "profile:x" }],
    });
    const active = buildUsageStore("profile:x", {
      fetchedAtIso: "2026-08-12T09:29:59.000Z",
      fiveHour: { percent: 42, resetsAtIso: "2026-08-12T10:30:00.000Z" },
      weekly: { percent: 55, resetsAtIso: "2026-08-19T09:30:00.000Z" },
    });
    expect(active["profile:x"]).toMatchObject({ ok: true });
    expect(active["profile:x"]?.limits).toEqual([
      {
        kind: "session",
        percent: 42,
        severity: "normal",
        resetsAt: "2026-08-12T10:30:00.000Z",
      },
      {
        kind: "weekly_all",
        percent: 55,
        severity: "normal",
        resetsAt: "2026-08-19T09:30:00.000Z",
      },
    ]);
    const inactive = buildUsageStore("profile:x", {
      fetchedAtIso: "2026-08-12T09:29:59.000Z",
      fiveHour: "inactive",
      weekly: { percent: 55, resetsAtIso: "2026-08-19T09:30:00.000Z" },
      ok: false,
    });
    const record = inactive["profile:x"];
    expect(record).toMatchObject({ ok: false, error: "synthetic-provider-refresh-failed" });
    expect(record?.limits[0]).toEqual({ kind: "session", severity: "normal", isActive: false });
    expect(record?.limits[0]).not.toHaveProperty("percent");
    expect(record?.limits[0]).not.toHaveProperty("resetsAt");
  });

  it("builds the exact reader configuration shape", () => {
    const profile = {
      profileId: "profile:x",
      providerId: "claude-code",
      ownership: "owned",
      authorization: "authorized",
      revocation: "not-revoked",
    } as const;
    expect(buildReaderConfiguration("C:\\store", profile)).toEqual({
      schemaVersion: 2,
      dataDirectory: "C:\\store",
      profileAllowlist: [profile],
      freshnessMs: 300_000,
    });
  });

  it("keeps the fixed routing instants on the intended sides of the London window", () => {
    expect(isLondonWorkHours(new Date(WORK_HOURS_NOW))).toBe(true);
    expect(isLondonWorkHours(new Date(OUTSIDE_WORK_HOURS_NOW))).toBe(false);
  });

  it("builds candidates and native-v3 snapshots with coherent arithmetic", () => {
    const owned = buildRouteCandidate();
    expect(owned).toMatchObject({ ownership: "owned", borrowedPolicy: null });
    const borrowed = buildRouteCandidate({ ownership: "authorized-borrowed" });
    expect(borrowed.borrowedPolicy).toEqual({
      taskClass: "claude-code",
      taskAuthorized: true,
      modelAllowed: true,
    });
    const snapshot = buildRoutingSnapshot({ fiveHourUsedBasisPoints: 5_000 });
    expect(snapshot).toMatchObject({ schemaVersion: 3, compatibility: "native-v3" });
    if (snapshot.fiveHour.status !== "active" || snapshot.weekly.status !== "active") {
      throw new Error("expected active default windows");
    }
    expect(snapshot.fiveHour.usedBasisPoints + snapshot.fiveHour.remainingBasisPoints).toBe(10_000);
    expect(snapshot.weekly.usedBasisPoints + snapshot.weekly.remainingBasisPoints).toBe(10_000);
    expect(Date.parse(snapshot.freshUntil)).toBeGreaterThan(Date.parse(snapshot.observedAt));
  });

  it("freezes the exact npm argument vectors", () => {
    expect(npmPackArgs("@ai-dev-os/application", "D:\\out")).toEqual([
      "pack",
      "--workspace",
      "@ai-dev-os/application",
      "--json",
      "--pack-destination",
      "D:\\out",
    ]);
    expect(NPM_INSTALL_ARGS).toEqual([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
    ]);
    expect(NPM_REBUILD_BETTER_SQLITE3_ARGS).toEqual(["rebuild", "better-sqlite3"]);
    expect(NPM_LS_ARGS).toEqual(["ls", "--all", "--json"]);
    expect(NPM_AUDIT_ARGS).toEqual(["audit", "--audit-level=high"]);
  });

  it("renders deterministic single-line evidence and refuses unsafe shapes", () => {
    expect(
      renderEvidence([
        ["b.two", "2"],
        ["a.one", "1"],
      ]),
    ).toBe("a.one=1\nb.two=2");
    expect(() => renderEvidence([["bad=key", "x"]])).toThrowError(/'='-free/);
    expect(() => renderEvidence([["key", "line\nbreak"]])).toThrowError(/single-line/);
  });
});
