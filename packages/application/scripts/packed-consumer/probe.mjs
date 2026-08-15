"use strict";

/**
 * AM-02 packed-consumer probe.
 *
 * This file is copied by `verify-packed-consumer.mjs` into a fresh, task-owned
 * consumer directory (alongside `lib.mjs` and the pinned reader artifact) and
 * executed there AFTER the packed tarballs are installed. Everything it
 * imports from `@ai-dev-os/*` therefore resolves through the consumer's
 * `node_modules` — the packed layout under test — never through the
 * repository source tree.
 *
 * It exercises only documented production entry points against bounded
 * synthetic stores. It never touches installed Account Manager state, real
 * profiles, credentials, browsers, or any network endpoint, and its output is
 * a single deterministic JSON document with finite codes only.
 */

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_REPOSITORY_URL,
  EXPECTED_RUNTIME_VERSION,
  EXPECTED_SUPPORTED_COMMIT,
  EXPECTED_SUPPORTED_INVENTORY_SHA256,
  EXPECTED_SUPPORTED_READER_SHA256,
  EXPECTED_SUPPORTED_TREE,
  EXPECTED_USAGE_PROTOCOL_VERSION,
  FORBIDDEN_PRODUCTION_EXPORTS,
  OUTSIDE_WORK_HOURS_NOW,
  PROBE_FRESHNESS_MS,
  PROBE_PROFILE_ID,
  REQUIRED_APPLICATION_EXPORTS,
  REQUIRED_SCHEDULER_EXPORTS,
  WORK_HOURS_NOW,
  buildAuthorizedProfile,
  buildProfilesStore,
  buildReaderConfiguration,
  buildRouteCandidate,
  buildRoutingSnapshot,
  buildTaskEnvelope,
  buildUsageStore,
  normalizedReaderIdentity,
} from "./lib.mjs";

const probeRoot = dirname(fileURLToPath(import.meta.url));
const readerPath = resolve(probeRoot, "reader", "account-manager-usage-reader.cjs");
const requireFromProbe = createRequire(import.meta.url);

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, ...(detail === undefined ? {} : { detail }) });
}
function boundedFailure(error) {
  const code =
    error !== null && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : "UNCLASSIFIED";
  const message =
    error !== null && typeof error === "object" && typeof error.message === "string"
      ? error.message.slice(0, 240)
      : String(error).slice(0, 240);
  return `${code}: ${message}`;
}
async function check(id, run) {
  try {
    const detail = await run();
    record(id, true, detail);
  } catch (error) {
    record(id, false, boundedFailure(error));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function expectApplicationError(id, expectedCode, run) {
  await check(id, async () => {
    let observed = null;
    try {
      await run();
    } catch (error) {
      observed = error;
    }
    assert(observed !== null, "expected a refusal but the call succeeded");
    assert(
      typeof observed === "object" && observed.code === expectedCode,
      `expected ${expectedCode} but observed ${boundedFailure(observed)}`,
    );
    return expectedCode;
  });
}

/** Per-case synthetic store directories, always beneath the probe root. */
let storeCounter = 0;
function syntheticStore(profileId, usageStoreOrNull, options = {}) {
  storeCounter += 1;
  const directory = join(probeRoot, "synthetic-stores", `case-${String(storeCounter).padStart(2, "0")}`);
  mkdirSync(directory, { recursive: true });
  if (options.omitProfiles !== true) {
    writeFileSync(
      join(directory, "profiles.json"),
      JSON.stringify(buildProfilesStore(profileId)),
    );
  }
  if (typeof options.rawUsageText === "string") {
    writeFileSync(join(directory, "usage-snapshots.json"), options.rawUsageText);
  } else if (usageStoreOrNull !== null) {
    writeFileSync(join(directory, "usage-snapshots.json"), JSON.stringify(usageStoreOrNull));
  }
  assert(directory.startsWith(probeRoot), "synthetic store escaped the probe root");
  return directory;
}

const application = await import("@ai-dev-os/application");
const scheduler = await import("@ai-dev-os/scheduler");

function supportedAdapterFor(directory, ownership = "owned") {
  const authorizedProfile = buildAuthorizedProfile(PROBE_PROFILE_ID, ownership);
  const readerConfiguration = buildReaderConfiguration(directory, authorizedProfile);
  const readerModule = requireFromProbe(readerPath);
  const expectedConfigurationFingerprint = readerModule
    .createScopedUsageReader(readerConfiguration)
    .configurationFingerprint;
  return application.createAccountManagerSupportedUsageAdapter({
    readerModulePath: readerPath,
    readerConfiguration,
    authorizedProfile,
    expectedConfigurationFingerprint,
    maximumSourceFreshnessMs: PROBE_FRESHNESS_MS,
  });
}

function activeWindows(nowMs, sessionPercent, weeklyPercent) {
  return {
    fetchedAtIso: new Date(nowMs - 1_000).toISOString(),
    fiveHour: {
      percent: sessionPercent,
      resetsAtIso: new Date(nowMs + 3_600_000).toISOString(),
    },
    weekly: {
      percent: weeklyPercent,
      resetsAtIso: new Date(nowMs + 7 * 86_400_000).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Packed-layout import and pin identity.
// ---------------------------------------------------------------------------

await check("imports.production-roots", () => {
  for (const name of REQUIRED_APPLICATION_EXPORTS) {
    assert(name in application, `@ai-dev-os/application is missing ${name}`);
  }
  for (const name of REQUIRED_SCHEDULER_EXPORTS) {
    assert(name in scheduler, `@ai-dev-os/scheduler is missing ${name}`);
  }
  return "application+scheduler roots (and their eager dependency graph) loaded";
});

await check("pins.account-manager-identity", () => {
  assert(
    application.ACCOUNT_MANAGER_SUPPORTED_COMMIT === EXPECTED_SUPPORTED_COMMIT,
    "supported commit pin drifted",
  );
  assert(
    application.ACCOUNT_MANAGER_SUPPORTED_TREE === EXPECTED_SUPPORTED_TREE,
    "supported tree pin drifted",
  );
  assert(
    application.ACCOUNT_MANAGER_SUPPORTED_INVENTORY_SHA256 ===
      EXPECTED_SUPPORTED_INVENTORY_SHA256,
    "supported inventory pin drifted",
  );
  assert(
    application.ACCOUNT_MANAGER_SUPPORTED_READER_SHA256 ===
      EXPECTED_SUPPORTED_READER_SHA256,
    "supported reader digest pin drifted",
  );
  assert(
    application.ACCOUNT_MANAGER_USAGE_PROTOCOL_VERSION ===
      EXPECTED_USAGE_PROTOCOL_VERSION,
    "usage protocol version drifted",
  );
  assert(
    application.ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED === false,
    "live access must remain literal false",
  );
  return `commit=${EXPECTED_SUPPORTED_COMMIT.slice(0, 12)} protocol=v${EXPECTED_USAGE_PROTOCOL_VERSION}`;
});

await check("exports.testing-surface-absent", () => {
  for (const name of FORBIDDEN_PRODUCTION_EXPORTS) {
    assert(
      !(name in application) && !(name in scheduler),
      `testing-only symbol ${name} leaked through a production root`,
    );
  }
  return `${FORBIDDEN_PRODUCTION_EXPORTS.length} testing-only symbols absent from production roots`;
});

await check("reader.pinned-artifact-identity", () => {
  const identity = normalizedReaderIdentity(readFileSync(readerPath, "utf8"));
  assert(
    identity.sha256 === EXPECTED_SUPPORTED_READER_SHA256,
    "the shipped reader artifact does not match the pinned digest",
  );
  const readerModule = requireFromProbe(readerPath);
  assert(readerModule.READER_PROTOCOL_VERSION === 2, "reader protocol must be v2");
  assert(readerModule.RUNTIME_VERSION === EXPECTED_RUNTIME_VERSION, "runtime version drifted");
  assert(readerModule.REPOSITORY_URL === EXPECTED_REPOSITORY_URL, "repository URL drifted");
  return `normalizedBytes=${identity.normalizedBytes} sha256=${identity.sha256.slice(0, 12)}…`;
});

// ---------------------------------------------------------------------------
// 2. Production adapter over a bounded synthetic store (protocol v2 → v3).
// ---------------------------------------------------------------------------

const realNowMs = Date.now();

await check("adapter.active-windows-normalize", async () => {
  const directory = syntheticStore(
    PROBE_PROFILE_ID,
    buildUsageStore(PROBE_PROFILE_ID, activeWindows(realNowMs, 42, 55)),
  );
  const adapter = supportedAdapterFor(directory);
  assert(adapter.adapterId === "usage:account-manager-reader", "unexpected adapter id");
  assert(adapter.schemaVersion === 3, "adapter must declare usage schema v3");
  const snapshot = await adapter.readAuthorizedSnapshot(PROBE_PROFILE_ID);
  assert(snapshot !== null, "expected a snapshot");
  assert(snapshot.schemaVersion === 3 && snapshot.compatibility === "native-v3", "must be native-v3");
  assert(snapshot.sourceClass === "provider-authoritative", "expected authoritative source");
  assert(snapshot.confidence === "high", "expected high confidence");
  assert(snapshot.sourceAdapterVersion === "v2:1.4.1", "expected protocol-v2 adapter version");
  assert(snapshot.timezone === "Europe/London", "expected the configured timezone");
  assert(
    snapshot.fiveHour.status === "active" && snapshot.fiveHour.usedBasisPoints === 4_200,
    "five-hour window must be active at 4200 basis points",
  );
  assert(
    snapshot.weekly.status === "active" && snapshot.weekly.usedBasisPoints === 5_500,
    "weekly window must be active at 5500 basis points",
  );
  const validity = scheduler.validateUsageFreshness(snapshot, new Date(realNowMs), 120_000);
  assert(validity.eligible === true, `expected eligible, rules=${validity.ruleIds.join(",")}`);
  return "active store normalized to eligible native-v3 snapshot";
});

await check("adapter.inactive-window-preserved-and-refused", async () => {
  const directory = syntheticStore(
    PROBE_PROFILE_ID,
    buildUsageStore(PROBE_PROFILE_ID, {
      ...activeWindows(realNowMs, 42, 55),
      fiveHour: "inactive",
    }),
  );
  const snapshot = await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  assert(snapshot !== null, "expected a snapshot");
  assert(snapshot.fiveHour.status === "inactive", "five-hour window must be inactive");
  assert(
    snapshot.fiveHour.usedBasisPoints === null &&
      snapshot.fiveHour.remainingBasisPoints === null &&
      snapshot.fiveHour.resetAt === null,
    "inactive windows must carry null capacity and reset evidence",
  );
  assert(snapshot.weekly.status === "active", "weekly window must stay active");
  const validity = scheduler.validateUsageFreshness(snapshot, new Date(realNowMs), 120_000);
  assert(validity.eligible === false, "inactive evidence must never be eligible");
  assert(
    validity.ruleIds.includes("usage.window.inactive"),
    `expected usage.window.inactive, rules=${validity.ruleIds.join(",")}`,
  );
  return "inactive window preserved as nulls and refused for scheduling";
});

await check("adapter.cached-source-refused", async () => {
  const directory = syntheticStore(
    PROBE_PROFILE_ID,
    buildUsageStore(PROBE_PROFILE_ID, { ...activeWindows(realNowMs, 42, 55), ok: false }),
  );
  const snapshot = await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  assert(snapshot !== null, "expected a snapshot");
  assert(snapshot.sourceClass === "provider-cached", "expected provider-cached class");
  assert(snapshot.authoritative === false && snapshot.confidence === "low", "cached must be non-authoritative low");
  const validity = scheduler.validateUsageFreshness(snapshot, new Date(realNowMs), 120_000);
  assert(validity.eligible === false, "cached evidence must be refused");
  assert(
    validity.ruleIds.includes("usage.authority.required"),
    `expected usage.authority.required, rules=${validity.ruleIds.join(",")}`,
  );
  return "post-failure cached observation preserved but refused";
});

await check("adapter.stale-source-refused", async () => {
  const staleNowMs = realNowMs - 20 * 60_000;
  const directory = syntheticStore(
    PROBE_PROFILE_ID,
    buildUsageStore(PROBE_PROFILE_ID, activeWindows(staleNowMs, 42, 55)),
  );
  const snapshot = await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  assert(snapshot !== null, "expected a snapshot");
  const validity = scheduler.validateUsageFreshness(snapshot, new Date(realNowMs), 120_000);
  assert(validity.eligible === false, "stale evidence must be refused");
  assert(
    validity.ruleIds.includes("usage.stale.refused") &&
      validity.ruleIds.includes("usage.source-freshness.expired"),
    `expected stale+expired rules, rules=${validity.ruleIds.join(",")}`,
  );
  return "20-minute-old observation refused as stale and source-expired";
});

// ---------------------------------------------------------------------------
// 3. Fail-closed adapter matrix (every case a distinct finite refusal).
// ---------------------------------------------------------------------------

await expectApplicationError(
  "failclosed.missing-usage-store",
  "USAGE_SOURCE_UNAVAILABLE",
  async () => {
    const directory = syntheticStore(PROBE_PROFILE_ID, null);
    await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  },
);

await expectApplicationError(
  "failclosed.malformed-usage-store",
  "USAGE_SOURCE_UNAVAILABLE",
  async () => {
    const directory = syntheticStore(PROBE_PROFILE_ID, null, { rawUsageText: "{ not-json" });
    await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  },
);

await expectApplicationError(
  "failclosed.future-observation",
  "USAGE_SOURCE_UNAVAILABLE",
  async () => {
    const directory = syntheticStore(
      PROBE_PROFILE_ID,
      buildUsageStore(PROBE_PROFILE_ID, activeWindows(realNowMs + 3_600_000, 42, 55)),
    );
    await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  },
);

await check("failclosed.active-window-missing-capacity", async () => {
  const store = {
    [PROBE_PROFILE_ID]: {
      fetchedAt: new Date(realNowMs - 1_000).toISOString(),
      ok: true,
      limits: [
        { kind: "session", severity: "normal" },
        {
          kind: "weekly_all",
          percent: 55,
          severity: "normal",
          resetsAt: new Date(realNowMs + 7 * 86_400_000).toISOString(),
        },
      ],
    },
  };
  const directory = syntheticStore(PROBE_PROFILE_ID, store);
  let observed = null;
  try {
    await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  } catch (error) {
    observed = error;
  }
  assert(observed !== null && observed.code === "USAGE_SOURCE_UNAVAILABLE", boundedFailure(observed));
  return "an active window without capacity/reset evidence fails closed";
});

await check("failclosed.invalid-activity-flag-redacted", async () => {
  const marker = "synthetic-invalid-activity-marker";
  const store = {
    [PROBE_PROFILE_ID]: {
      fetchedAt: new Date(realNowMs - 1_000).toISOString(),
      ok: true,
      limits: [
        {
          kind: "session",
          percent: 42,
          severity: "normal",
          resetsAt: new Date(realNowMs + 3_600_000).toISOString(),
          isActive: marker,
        },
        {
          kind: "weekly_all",
          percent: 55,
          severity: "normal",
          resetsAt: new Date(realNowMs + 7 * 86_400_000).toISOString(),
        },
      ],
    },
  };
  const directory = syntheticStore(PROBE_PROFILE_ID, store);
  let observed = null;
  try {
    await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  } catch (error) {
    observed = error;
  }
  assert(observed !== null && observed.code === "USAGE_SOURCE_UNAVAILABLE", boundedFailure(observed));
  assert(
    !String(observed.message).includes(marker),
    "refusal messages must not echo store values",
  );
  return "non-boolean activity evidence fails closed with a redacted message";
});

await expectApplicationError(
  "failclosed.ambiguous-duplicate-windows",
  "USAGE_SOURCE_UNAVAILABLE",
  async () => {
    const single = buildUsageStore(PROBE_PROFILE_ID, activeWindows(realNowMs, 42, 55));
    const record = single[PROBE_PROFILE_ID];
    const store = {
      [PROBE_PROFILE_ID]: {
        ...record,
        limits: [...record.limits, record.limits[0]],
      },
    };
    const directory = syntheticStore(PROBE_PROFILE_ID, store);
    await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID);
  },
);

await expectApplicationError(
  "failclosed.profile-substitution",
  "USAGE_PROFILE_MISMATCH",
  async () => {
    const directory = syntheticStore(
      PROBE_PROFILE_ID,
      buildUsageStore(PROBE_PROFILE_ID, activeWindows(realNowMs, 42, 55)),
    );
    await supportedAdapterFor(directory).readAuthorizedSnapshot("profile:substituted");
  },
);

await expectApplicationError(
  "failclosed.cancelled-read",
  "USAGE_SOURCE_UNAVAILABLE",
  async () => {
    const directory = syntheticStore(
      PROBE_PROFILE_ID,
      buildUsageStore(PROBE_PROFILE_ID, activeWindows(realNowMs, 42, 55)),
    );
    await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID, {
      signal: { aborted: true },
      deadline: new Date(realNowMs + 15_000).toISOString(),
    });
  },
);

await expectApplicationError(
  "failclosed.expired-deadline",
  "USAGE_SOURCE_UNAVAILABLE",
  async () => {
    const directory = syntheticStore(
      PROBE_PROFILE_ID,
      buildUsageStore(PROBE_PROFILE_ID, activeWindows(realNowMs, 42, 55)),
    );
    await supportedAdapterFor(directory).readAuthorizedSnapshot(PROBE_PROFILE_ID, {
      signal: { aborted: false },
      deadline: new Date(realNowMs - 1_000).toISOString(),
    });
  },
);

await check("failclosed.tampered-reader-artifact", async () => {
  const tamperedPath = join(probeRoot, "synthetic-stores", "tampered-reader.cjs");
  mkdirSync(dirname(tamperedPath), { recursive: true });
  writeFileSync(tamperedPath, `${readFileSync(readerPath, "utf8")} `);
  const authorizedProfile = buildAuthorizedProfile(PROBE_PROFILE_ID, "owned");
  const directory = syntheticStore(
    PROBE_PROFILE_ID,
    buildUsageStore(PROBE_PROFILE_ID, activeWindows(realNowMs, 42, 55)),
  );
  let observed = null;
  try {
    application.createAccountManagerSupportedUsageAdapter({
      readerModulePath: tamperedPath,
      readerConfiguration: buildReaderConfiguration(directory, authorizedProfile),
      authorizedProfile,
      expectedConfigurationFingerprint: "d".repeat(64),
      maximumSourceFreshnessMs: PROBE_FRESHNESS_MS,
    });
  } catch (error) {
    observed = error;
  }
  assert(observed !== null && observed.code === "USAGE_SOURCE_MISMATCH", boundedFailure(observed));
  return "a one-byte reader substitution is refused before any read";
});

await check("failclosed.configuration-fingerprint-mismatch", async () => {
  const authorizedProfile = buildAuthorizedProfile(PROBE_PROFILE_ID, "owned");
  const directory = syntheticStore(
    PROBE_PROFILE_ID,
    buildUsageStore(PROBE_PROFILE_ID, activeWindows(realNowMs, 42, 55)),
  );
  let observed = null;
  try {
    application.createAccountManagerSupportedUsageAdapter({
      readerModulePath: readerPath,
      readerConfiguration: buildReaderConfiguration(directory, authorizedProfile),
      authorizedProfile,
      expectedConfigurationFingerprint: "d".repeat(64),
      maximumSourceFreshnessMs: PROBE_FRESHNESS_MS,
    });
  } catch (error) {
    observed = error;
  }
  assert(observed !== null && observed.code === "USAGE_SOURCE_MISMATCH", boundedFailure(observed));
  return "an untrusted configuration fingerprint is refused before any read";
});

// ---------------------------------------------------------------------------
// 4. Deterministic routing rules through the installed scheduler.
// ---------------------------------------------------------------------------

const workNow = new Date(WORK_HOURS_NOW);
const outsideNow = new Date(OUTSIDE_WORK_HOURS_NOW);

await check("routing.work-hours-calendar", () => {
  assert(scheduler.isLondonWorkHours(workNow) === true, "expected a London working-hours instant");
  assert(scheduler.isLondonWorkHours(outsideNow) === false, "expected an outside-hours instant");
  return `${WORK_HOURS_NOW} inside; ${OUTSIDE_WORK_HOURS_NOW} outside`;
});

function routing(overrides) {
  const nowIso = overrides.nowIso ?? WORK_HOURS_NOW;
  const decision = scheduler.routeTask({
    task: buildTaskEnvelope(
      overrides.idSuffix,
      new Date(Date.parse(nowIso) - 1_000).toISOString(),
      new Date(Date.parse(nowIso) + 2 * 3_600_000).toISOString(),
    ),
    workloadClass: overrides.workloadClass ?? "general",
    preference: "balanced",
    candidates: [overrides.candidate],
    usageSnapshots: [overrides.snapshot],
    now: new Date(nowIso),
    maximumSnapshotAgeMs: 120_000,
  });
  const considered = decision.considered[0];
  assert(considered !== undefined, "expected one considered candidate");
  return { decision, ruleIds: considered.ruleIds };
}

await check("routing.owned-eligible-selected", () => {
  const { decision, ruleIds } = routing({
    idSuffix: "owned-selected",
    candidate: buildRouteCandidate(),
    snapshot: buildRoutingSnapshot(),
  });
  assert(decision.selected !== null, `expected selection, rules=${ruleIds.join(",")}`);
  assert(decision.selected.candidateId === "candidate:packed-consumer", "wrong candidate selected");
  assert(ruleIds.length === 0, `expected zero refusal rules, rules=${ruleIds.join(",")}`);
  return "eligible owned candidate selected";
});

await check("routing.borrowed-at-caps-during-work-hours", () => {
  const { decision, ruleIds } = routing({
    idSuffix: "borrowed-caps-work",
    candidate: buildRouteCandidate({ ownership: "authorized-borrowed" }),
    snapshot: buildRoutingSnapshot({
      ownership: "authorized-borrowed",
      fiveHourUsedBasisPoints: 5_000,
      weeklyUsedBasisPoints: 7_000,
    }),
  });
  assert(decision.selected === null, "at-cap borrowed dispatch must refuse");
  assert(
    ruleIds.includes("usage.borrowed.weekly-70-cap"),
    `expected weekly 70% rule, rules=${ruleIds.join(",")}`,
  );
  assert(
    ruleIds.includes("usage.borrowed.work-hours-five-hour-50-cap"),
    `expected work-hours 50% rule, rules=${ruleIds.join(",")}`,
  );
  return "50% five-hour and 70% weekly hard caps both enforced at cap";
});

await check("routing.borrowed-weekly-cap-outside-work-hours", () => {
  const { decision, ruleIds } = routing({
    idSuffix: "borrowed-caps-outside",
    nowIso: OUTSIDE_WORK_HOURS_NOW,
    candidate: buildRouteCandidate({
      ownership: "authorized-borrowed",
      healthObservedAt: OUTSIDE_WORK_HOURS_NOW,
    }),
    snapshot: buildRoutingSnapshot({
      nowIso: OUTSIDE_WORK_HOURS_NOW,
      ownership: "authorized-borrowed",
      fiveHourUsedBasisPoints: 5_000,
      weeklyUsedBasisPoints: 7_000,
    }),
  });
  assert(decision.selected === null, "at-cap borrowed dispatch must refuse");
  assert(
    ruleIds.includes("usage.borrowed.weekly-70-cap"),
    `expected weekly 70% rule, rules=${ruleIds.join(",")}`,
  );
  assert(
    !ruleIds.includes("usage.borrowed.work-hours-five-hour-50-cap"),
    "the 50% five-hour rule is a working-hours rule only",
  );
  return "weekly 70% cap enforced at all times; five-hour cap scoped to work hours";
});

await check("routing.borrowed-fable-forbidden", () => {
  const { decision, ruleIds } = routing({
    idSuffix: "borrowed-fable",
    workloadClass: "fable",
    candidate: buildRouteCandidate({ ownership: "authorized-borrowed" }),
    snapshot: buildRoutingSnapshot({ ownership: "authorized-borrowed" }),
  });
  assert(decision.selected === null, "borrowed Fable dispatch must refuse");
  assert(
    ruleIds.includes("route.borrowed.fable-forbidden"),
    `expected the Fable exclusion, rules=${ruleIds.join(",")}`,
  );
  return "borrowed profiles are never eligible for Fable work";
});

await check("routing.inactive-window-refused-without-cap-arithmetic", () => {
  const { decision, ruleIds } = routing({
    idSuffix: "inactive-window",
    candidate: buildRouteCandidate(),
    snapshot: buildRoutingSnapshot({
      fiveHour: {
        windowId: "window:packed-consumer:five-hour-inactive",
        status: "inactive",
        usedBasisPoints: null,
        remainingBasisPoints: null,
        resetAt: null,
      },
    }),
  });
  assert(decision.selected === null, "inactive-window dispatch must refuse");
  assert(
    ruleIds.includes("usage.window.inactive"),
    `expected usage.window.inactive, rules=${ruleIds.join(",")}`,
  );
  assert(
    !ruleIds.includes("usage.borrowed.weekly-70-cap") &&
      !ruleIds.includes("usage.borrowed.work-hours-five-hour-50-cap"),
    "cap arithmetic must not run over inactive (null) capacity",
  );
  return "inactive required window refuses dispatch before any cap arithmetic";
});

await check("routing.legacy-v2-snapshot-refused", () => {
  const current = buildRoutingSnapshot();
  const legacy = {
    ...current,
    schemaVersion: 2,
    compatibility: "native-v2",
    fiveHour: {
      windowId: current.fiveHour.windowId,
      usedBasisPoints: current.fiveHour.usedBasisPoints,
      remainingBasisPoints: current.fiveHour.remainingBasisPoints,
      resetAt: current.fiveHour.resetAt,
    },
    weekly: {
      windowId: current.weekly.windowId,
      usedBasisPoints: current.weekly.usedBasisPoints,
      remainingBasisPoints: current.weekly.remainingBasisPoints,
      resetAt: current.weekly.resetAt,
    },
  };
  const parsed = scheduler.parseCanonicalUsageSnapshot(legacy);
  assert(parsed.compatibility === "migrated-v2", "v2 input must migrate for audit");
  const { decision, ruleIds } = routing({
    idSuffix: "legacy-v2",
    candidate: buildRouteCandidate(),
    snapshot: legacy,
  });
  assert(decision.selected === null, "legacy v2 evidence must never authorize dispatch");
  assert(
    ruleIds.includes("usage.schema-v3.required"),
    `expected usage.schema-v3.required, rules=${ruleIds.join(",")}`,
  );
  return "legacy native-v2 input migrates for audit but cannot authorize dispatch";
});

// ---------------------------------------------------------------------------
// 5. Boundary statement.
// ---------------------------------------------------------------------------

await check("boundary.synthetic-only", () => {
  assert(storeCounter > 0, "expected synthetic stores to have been used");
  return (
    `all ${storeCounter} data directories were task-owned synthetic stores under the ` +
    "consumer directory; no installed Account Manager store, profile enumeration, " +
    "credential, browser, UI, or provider/network access exists in this probe"
  );
});

const failed = results.filter((entry) => entry.ok === false);
process.stdout.write(
  `${JSON.stringify(
    {
      component: "ai-dev-os-am02-packed-consumer-probe",
      schemaVersion: 1,
      node: process.version,
      assertions: results,
      total: results.length,
      failed: failed.length,
    },
    null,
    2,
  )}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
