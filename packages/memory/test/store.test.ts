import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_CONFIGURATION,
  memoryConfigurationFingerprint,
  parseMemoryConfiguration,
  withMemoryOverrides,
} from "../src/config.js";
import {
  createInMemoryMemoryStore,
  withInjectedFailure,
  type InMemoryMemoryStore,
} from "../src/in-memory-port.js";
import type { MemoryResult } from "../src/errors.js";
import type { MemoryStorePort } from "../src/port.js";
import { createMemoryRecord } from "../src/record.js";
import { createMemoryStore, type MemoryStore } from "../src/store.js";
import {
  createScopedAuthorizer,
  createMemorySubject,
  denyAllAuthorizer,
  memoryScopeKey,
  type MemoryAuthorizationDecision,
  type MemoryAuthorizer,
} from "../src/scope.js";
import {
  createCountingIdSource,
  createManualMemoryClock,
  explicitPreference,
  inferredCandidate,
  MEMORY_EPOCH,
  MEMORY_INJECTION_CANARY,
  OTHER_ORG_SCOPE,
  OTHER_PROJECT_SCOPE,
  OTHER_USER_SCOPE,
  POISONED_MEMORY_TEXT,
  USER_SCOPE,
  verifiedFact,
  type ManualMemoryClock,
} from "../src/testing/fixtures.js";

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success: ${result.failure.code} ${result.failure.message}`);
  }
  return result.value;
}

function code<T>(result: MemoryResult<T>): string {
  if (result.ok) {
    throw new Error("expected failure");
  }
  return result.failure.code;
}

interface Harness {
  readonly store: MemoryStore;
  readonly port: InMemoryMemoryStore;
  readonly clock: ManualMemoryClock;
}

function harness(options: { readonly authorizer?: MemoryAuthorizer; readonly port?: MemoryStorePort } = {}): Harness {
  const port = createInMemoryMemoryStore();
  const clock = createManualMemoryClock();
  const store = createMemoryStore({
    port: options.port ?? port,
    authorizer: options.authorizer ?? createScopedAuthorizer({ scope: USER_SCOPE }),
    clock,
    idSource: createCountingIdSource(),
  });
  return { store, port, clock };
}

describe("configuration", () => {
  it("rejects an unsupported version and out-of-range bounds distinctly", () => {
    expect(code(parseMemoryConfiguration({ ...DEFAULT_MEMORY_CONFIGURATION, schemaVersion: 9 }))).toBe(
      "UNSUPPORTED_SCHEMA_VERSION",
    );
    expect(
      code(withMemoryOverrides(DEFAULT_MEMORY_CONFIGURATION, { limits: { maxQueryResults: 0 } })),
    ).toBe("INVALID_CONFIGURATION");
  });

  it("refuses a configuration that requires expiry without a default", () => {
    expect(
      code(withMemoryOverrides(DEFAULT_MEMORY_CONFIGURATION, { inferredCandidateTtlMs: null })),
    ).toBe("INVALID_CONFIGURATION");
  });

  it("fingerprints deterministically", () => {
    expect(memoryConfigurationFingerprint(DEFAULT_MEMORY_CONFIGURATION)).toBe(
      memoryConfigurationFingerprint(unwrap(parseMemoryConfiguration(DEFAULT_MEMORY_CONFIGURATION))),
    );
  });
});

describe("scope isolation", () => {
  it("refuses reads, queries, and snapshots for every other scope", async () => {
    const { store } = harness();
    unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
      }),
    );
    for (const scope of [OTHER_USER_SCOPE, OTHER_PROJECT_SCOPE, OTHER_ORG_SCOPE]) {
      expect(code(await store.read({ scope, recordId: "f1", purpose: "context-assembly" }))).toBe(
        "AUTHORIZATION_DENIED",
      );
      expect(code(await store.query({ scope, purpose: "context-assembly" }))).toBe(
        "AUTHORIZATION_DENIED",
      );
      expect(code(await store.snapshot({ scope, purpose: "maintenance" }))).toBe(
        "AUTHORIZATION_DENIED",
      );
    }
  });

  it("never uses one project's memory as a fallback for another", async () => {
    const { port, clock } = harness();
    const store = createMemoryStore({
      port,
      // Authorized for both projects, so any leakage would be visible rather
      // than masked by a denial.
      authorizer: {
        authorize: (): MemoryAuthorizationDecision =>
          Object.freeze({
            outcome: "allowed",
            reasonCode: "TEST_ALLOW",
            bodyDisclosureAllowed: true,
            decisionFingerprint: null,
          }),
      },
      clock,
      idSource: createCountingIdSource(),
    });
    unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
      }),
    );
    expect(
      code(
        await store.read({
          scope: OTHER_PROJECT_SCOPE,
          recordId: "f1",
          purpose: "context-assembly",
        }),
      ),
    ).toBe("NOT_FOUND");
    const other = unwrap(
      await store.query({ scope: OTHER_PROJECT_SCOPE, purpose: "context-assembly" }),
    );
    expect(other.entries).toHaveLength(0);
  });

  it("refuses a record whose scope disagrees with the request", async () => {
    const { store } = harness();
    expect(
      code(
        await store.append({
          record: verifiedFact({
            recordId: "f1",
            subject: "Build",
            text: "npm run check",
            scope: OTHER_PROJECT_SCOPE,
          }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("AUTHORIZATION_DENIED");
  });

  it("catches an adapter that returns a foreign record", async () => {
    const inner = createInMemoryMemoryStore();
    const foreign: MemoryStorePort = {
      ...inner,
      get: async (_scopeKey: string, recordId: string) =>
        inner.get(memoryScopeKey(OTHER_PROJECT_SCOPE), recordId),
      list: async () => inner.list(memoryScopeKey(OTHER_PROJECT_SCOPE)),
    };
    const store = createMemoryStore({
      port: inner,
      authorizer: createScopedAuthorizer({ scope: OTHER_PROJECT_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
    });
    unwrap(
      await store.append({
        record: verifiedFact({
          recordId: "f1",
          subject: "Build",
          text: "npm run check",
          scope: OTHER_PROJECT_SCOPE,
        }),
        purpose: "context-assembly",
      }),
    );
    const misrouted = createMemoryStore({
      port: foreign,
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
    });
    expect(
      code(await misrouted.read({ scope: USER_SCOPE, recordId: "f1", purpose: "context-assembly" })),
    ).toBe("SCOPE_MISMATCH");
    expect(code(await misrouted.query({ scope: USER_SCOPE, purpose: "context-assembly" }))).toBe(
      "SCOPE_MISMATCH",
    );
  });
});

describe("authorization", () => {
  it("denies by default", async () => {
    const { store } = harness({ authorizer: denyAllAuthorizer });
    expect(
      code(
        await store.append({
          record: verifiedFact({ recordId: "f1", subject: "Build", text: "x" }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("AUTHORIZATION_DENIED");
  });

  it("treats a throwing authorizer as a refusal", async () => {
    const { store } = harness({
      authorizer: {
        authorize: () => {
          throw new Error("policy backend unreachable at 10.0.0.5");
        },
      },
    });
    const result = await store.append({
      record: verifiedFact({ recordId: "f1", subject: "Build", text: "x" }),
      purpose: "context-assembly",
    });
    expect(code(result)).toBe("AUTHORIZATION_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  });

  it("treats a malformed or conditional decision as a refusal", async () => {
    for (const decision of [
      { outcome: "conditional", reasonCode: "NEEDS_APPROVAL", bodyDisclosureAllowed: true, decisionFingerprint: null },
      { outcome: "allowed" },
      "allowed",
    ]) {
      const { store } = harness({
        authorizer: { authorize: () => decision as MemoryAuthorizationDecision },
      });
      const result = await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "x" }),
        purpose: "context-assembly",
      });
      expect(["AUTHORIZATION_DENIED", "AUTHORIZATION_UNAVAILABLE"]).toContain(code(result));
    }
  });

  it("withholds bodies when disclosure is not permitted but metadata is", async () => {
    const port = createInMemoryMemoryStore();
    const clock = createManualMemoryClock();
    const permissive = createMemoryStore({
      port,
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock,
      idSource: createCountingIdSource(),
    });
    unwrap(
      await permissive.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
      }),
    );
    const restricted = createMemoryStore({
      port,
      authorizer: {
        authorize: (): MemoryAuthorizationDecision =>
          Object.freeze({
            outcome: "allowed",
            reasonCode: "METADATA_ONLY",
            bodyDisclosureAllowed: false,
            decisionFingerprint: null,
          }),
      },
      clock,
      idSource: createCountingIdSource(),
    });
    const read = unwrap(
      await restricted.read({ scope: USER_SCOPE, recordId: "f1", purpose: "context-assembly" }),
    );
    expect(read.record.body).toEqual({ kind: "withheld", reason: "unauthorized" });
    expect(JSON.stringify(read)).not.toContain("npm run check");
    const query = unwrap(await restricted.query({ scope: USER_SCOPE, purpose: "context-assembly" }));
    expect(query.bodiesWithheld).toBe(true);
    expect(JSON.stringify(query)).not.toContain("npm run check");
    // Positive control: with disclosure permitted the body really is present.
    const disclosed = unwrap(
      await permissive.read({ scope: USER_SCOPE, recordId: "f1", purpose: "context-assembly" }),
    );
    expect(JSON.stringify(disclosed)).toContain("npm run check");
  });
});

describe("lifecycle", () => {
  it("rejects a duplicate identifier rather than overwriting", async () => {
    const { store } = harness();
    unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "one" }),
        purpose: "context-assembly",
      }),
    );
    expect(
      code(
        await store.append({
          record: verifiedFact({ recordId: "f1", subject: "Build", text: "two" }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("VERSION_CONFLICT");
  });

  it("supersedes with an explicit chain and marks the predecessor", async () => {
    const { store } = harness();
    const first = unwrap(
      await store.append({
        record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await store.supersede({
        scope: USER_SCOPE,
        supersededRecordId: "p1",
        expectedVersion: first.version,
        replacement: explicitPreference({ recordId: "p2", subject: "Indentation", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );
    const snapshot = unwrap(await store.snapshot({ scope: USER_SCOPE, purpose: "maintenance" }));
    const predecessor = snapshot.entries.find((entry) => entry.recordId === "p1");
    expect(predecessor?.supersededBy).toBe("p2");
    const active = unwrap(await store.query({ scope: USER_SCOPE, purpose: "context-assembly" }));
    expect(active.entries.map((entry) => entry.record.recordId)).toEqual(["p2"]);
  });

  it("refuses to supersede a stale or already-superseded record", async () => {
    const { store } = harness();
    const first = unwrap(
      await store.append({
        record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await store.supersede({
        scope: USER_SCOPE,
        supersededRecordId: "p1",
        expectedVersion: first.version,
        replacement: explicitPreference({ recordId: "p2", subject: "Indentation", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );
    expect(
      code(
        await store.supersede({
          scope: USER_SCOPE,
          supersededRecordId: "p1",
          expectedVersion: first.version,
          replacement: explicitPreference({ recordId: "p3", subject: "Indentation", text: "mixed" }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("VERSION_CONFLICT");
  });

  it("expires records without falling back to anything weaker", async () => {
    const { store, clock } = harness();
    unwrap(
      await store.append({
        record: verifiedFact({
          recordId: "f1",
          subject: "Build",
          text: "npm run check",
          expiresAt: "2026-08-02T13:00:00.000Z",
        }),
        purpose: "context-assembly",
      }),
    );
    expect(
      unwrap(await store.query({ scope: USER_SCOPE, purpose: "context-assembly" })).entries,
    ).toHaveLength(1);
    clock.set("2026-08-02T13:00:01.000Z");
    expect(code(await store.read({ scope: USER_SCOPE, recordId: "f1", purpose: "context-assembly" }))).toBe(
      "EXPIRED",
    );
    expect(
      unwrap(await store.query({ scope: USER_SCOPE, purpose: "context-assembly" })).entries,
    ).toHaveLength(0);
    expect(
      unwrap(
        await store.query({ scope: USER_SCOPE, purpose: "context-assembly", includeExpired: true }),
      ).entries,
    ).toHaveLength(1);
  });

  it("gives an inferred candidate a default expiry", async () => {
    const { store } = harness();
    const entry = unwrap(
      await store.append({
        record: inferredCandidate({ recordId: "c1", subject: "Editor", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );
    expect(entry.record.expiresAt).not.toBeNull();
    expect(entry.confirmation).toBe("unconfirmed");
  });

  it("refuses to confirm anything that is not an inferred candidate", async () => {
    const { store } = harness();
    const entry = unwrap(
      await store.append({
        record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    expect(
      code(
        await store.decideCandidate({
          scope: USER_SCOPE,
          recordId: "p1",
          expectedVersion: entry.version,
          decision: "confirm",
          purpose: "user-review",
        }),
      ),
    ).toBe("PRECEDENCE_VIOLATION");
  });

  it("keeps a rejected candidate visible as rejected, not as truth", async () => {
    const { store } = harness();
    const entry = unwrap(
      await store.append({
        record: inferredCandidate({ recordId: "c1", subject: "Editor", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await store.decideCandidate({
        scope: USER_SCOPE,
        recordId: "c1",
        expectedVersion: entry.version,
        decision: "reject",
        purpose: "user-review",
      }),
    );
    const rejected = unwrap(
      await store.query({
        scope: USER_SCOPE,
        purpose: "context-assembly",
        confirmation: ["rejected"],
      }),
    );
    expect(rejected.entries).toHaveLength(1);
    const unconfirmed = unwrap(
      await store.query({
        scope: USER_SCOPE,
        purpose: "context-assembly",
        confirmation: ["unconfirmed", "confirmed"],
      }),
    );
    expect(unconfirmed.entries).toHaveLength(0);
  });

  it("prefers an explicit preference over any candidate for the same subject", async () => {
    const { store } = harness();
    unwrap(
      await store.append({
        record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    const candidate = unwrap(
      await store.append({
        record: inferredCandidate({ recordId: "c1", subject: "Indentation", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await store.decideCandidate({
        scope: USER_SCOPE,
        recordId: "c1",
        expectedVersion: candidate.version,
        decision: "confirm",
        purpose: "user-review",
      }),
    );
    const resolved = unwrap(
      await store.resolvePreference({
        scope: USER_SCOPE,
        subjectDigest: createMemorySubject("Indentation").digest,
        purpose: "context-assembly",
      }),
    );
    // Even a confirmed candidate does not become the explicit preference.
    expect(resolved.explicit?.record.recordId).toBe("p1");
    expect(resolved.candidates.map((entry) => entry.record.recordId)).toEqual(["c1"]);
  });
});

describe("deletion", () => {
  it("withholds the body, refuses reads, and blocks silent resurrection", async () => {
    const { store } = harness();
    const entry = unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
      }),
    );
    const tombstoned = unwrap(
      await store.tombstone({
        scope: USER_SCOPE,
        recordId: "f1",
        expectedVersion: entry.version,
        tombstoneRecordId: "t1",
        purpose: "maintenance",
        recordedBy: "memory-test",
      }),
    );
    expect(tombstoned.record.body).toEqual({ kind: "withheld", reason: "tombstoned" });
    expect(JSON.stringify(tombstoned)).not.toContain("npm run check");
    expect(code(await store.read({ scope: USER_SCOPE, recordId: "f1", purpose: "context-assembly" }))).toBe(
      "TOMBSTONED",
    );
    expect(
      code(
        await store.append({
          record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("TOMBSTONED");
  });

  it("allows resurrection only with an explicit, attributed decision", async () => {
    const { store } = harness();
    const entry = unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await store.tombstone({
        scope: USER_SCOPE,
        recordId: "f1",
        expectedVersion: entry.version,
        tombstoneRecordId: "t1",
        purpose: "maintenance",
        recordedBy: "memory-test",
      }),
    );
    const revived = unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
        resurrection: { acknowledgeTombstone: true, decidedBy: "user-alice" },
      }),
    );
    expect(revived.tombstonedAt).toBeNull();
    expect(revived.version).toBeGreaterThan(entry.version);
  });

  it("refuses tombstoning twice or with a stale version", async () => {
    const { store } = harness();
    const entry = unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
      }),
    );
    expect(
      code(
        await store.tombstone({
          scope: USER_SCOPE,
          recordId: "f1",
          expectedVersion: entry.version + 5,
          tombstoneRecordId: "t1",
          purpose: "maintenance",
          recordedBy: "memory-test",
        }),
      ),
    ).toBe("VERSION_CONFLICT");
    unwrap(
      await store.tombstone({
        scope: USER_SCOPE,
        recordId: "f1",
        expectedVersion: entry.version,
        tombstoneRecordId: "t1",
        purpose: "maintenance",
        recordedBy: "memory-test",
      }),
    );
    expect(
      code(
        await store.tombstone({
          scope: USER_SCOPE,
          recordId: "f1",
          expectedVersion: entry.version + 1,
          tombstoneRecordId: "t2",
          purpose: "maintenance",
          recordedBy: "memory-test",
        }),
      ),
    ).toBe("TOMBSTONED");
  });
});

describe("hostile content", () => {
  it("stores poisoned text inertly and grants nothing", async () => {
    const { store } = harness();
    const entry = unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Notes", text: POISONED_MEMORY_TEXT }),
        purpose: "context-assembly",
      }),
    );
    // Positive control: the canary really is stored, so the assertions that
    // nothing was granted are about behaviour, not about absent input.
    expect(entry.record.body.kind === "text" && entry.record.body.text).toContain(
      MEMORY_INJECTION_CANARY,
    );
    expect(entry.record.classification).toBe("internal");
    expect(entry.record.disclosure).toBe("project-internal");
    // Reading it back from a differently-scoped caller is still refused.
    expect(
      code(
        await store.read({
          scope: OTHER_PROJECT_SCOPE,
          recordId: "f1",
          purpose: "context-assembly",
        }),
      ),
    ).toBe("AUTHORIZATION_DENIED");
  });

  it("refuses a body carrying credential material", async () => {
    const { store } = harness();
    const result = await store.append({
      record: verifiedFact({
        recordId: "f1",
        subject: "Deploy",
        text: "use sk-abcdefghijklmnopqrstuvwxyz012345 to deploy",
      }),
      purpose: "context-assembly",
    });
    expect(code(result)).toBe("SECRET_MATERIAL_REJECTED");
    expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  it("accepts a typed secret reference in place of the material", async () => {
    const { store } = harness();
    const entry = unwrap(
      await store.append({
        record: {
          ...verifiedFact({ recordId: "f1", subject: "Deploy", text: "placeholder" }),
          body: {
            kind: "secret-reference",
            reference: {
              refFingerprint: "d".repeat(64),
              display: "keychain:provider:deploy/robot:[text]",
            },
          },
        },
        purpose: "context-assembly",
      }),
    );
    expect(entry.record.body.kind).toBe("secret-reference");
  });
});

describe("failure behaviour", () => {
  it("surfaces a store failure without leaking its message", async () => {
    const inner = createInMemoryMemoryStore();
    const { store } = harness({ port: withInjectedFailure(inner, { operation: "apply", times: 1 }) });
    const result = await store.append({
      record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
      purpose: "context-assembly",
    });
    expect(code(result)).toBe("STORE_FAILURE");
    expect(JSON.stringify(result)).not.toContain("Injected");
  });

  it("honours cancellation on every operation", async () => {
    const { store } = harness();
    const signal = { aborted: true };
    expect(
      code(
        await store.append({
          record: verifiedFact({ recordId: "f1", subject: "Build", text: "x" }),
          purpose: "context-assembly",
          signal,
        }),
      ),
    ).toBe("CANCELLED");
    expect(
      code(await store.read({ scope: USER_SCOPE, recordId: "f1", purpose: "context-assembly", signal })),
    ).toBe("CANCELLED");
    expect(code(await store.query({ scope: USER_SCOPE, purpose: "context-assembly", signal }))).toBe(
      "CANCELLED",
    );
    expect(code(await store.snapshot({ scope: USER_SCOPE, purpose: "maintenance", signal }))).toBe(
      "CANCELLED",
    );
    expect(
      code(
        await store.tombstone({
          scope: USER_SCOPE,
          recordId: "f1",
          expectedVersion: 1,
          tombstoneRecordId: "t1",
          purpose: "maintenance",
          recordedBy: "memory-test",
          signal,
        }),
      ),
    ).toBe("CANCELLED");
    expect(
      code(
        await store.decideCandidate({
          scope: USER_SCOPE,
          recordId: "f1",
          expectedVersion: 1,
          decision: "confirm",
          purpose: "user-review",
          signal,
        }),
      ),
    ).toBe("CANCELLED");
    expect(
      code(
        await store.supersede({
          scope: USER_SCOPE,
          supersededRecordId: "f1",
          expectedVersion: 1,
          replacement: verifiedFact({ recordId: "f2", subject: "Build", text: "x" }),
          purpose: "context-assembly",
          signal,
        }),
      ),
    ).toBe("CANCELLED");
  });

  it("refuses work after close, including in-flight retries", async () => {
    const { store } = harness();
    await store.close();
    expect(
      code(await store.events({ scope: USER_SCOPE, purpose: "maintenance" })),
    ).toBe("STORE_CLOSED");
    expect(
      code(
        await store.decideCandidate({
          scope: USER_SCOPE,
          recordId: "f1",
          expectedVersion: 1,
          decision: "confirm",
          purpose: "user-review",
        }),
      ),
    ).toBe("STORE_CLOSED");
  });

  it("rejects an out-of-range query", async () => {
    const { store } = harness();
    expect(code(await store.query({ scope: USER_SCOPE, purpose: "context-assembly", limit: 0 }))).toBe(
      "INVALID_QUERY",
    );
    expect(
      code(
        await store.query({
          scope: USER_SCOPE,
          purpose: "context-assembly",
          variants: ["not-a-variant" as never],
        }),
      ),
    ).toBe("INVALID_QUERY");
  });

  it("enforces the per-scope record bound", async () => {
    const port = createInMemoryMemoryStore();
    const store = createMemoryStore({
      port,
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
      configuration: unwrap(
        withMemoryOverrides(DEFAULT_MEMORY_CONFIGURATION, { limits: { maxRecordsPerScope: 1 } }),
      ),
    });
    unwrap(
      await store.append({
        record: verifiedFact({ recordId: "f1", subject: "Build", text: "one" }),
        purpose: "context-assembly",
      }),
    );
    expect(
      code(
        await store.append({
          record: verifiedFact({ recordId: "f2", subject: "Build", text: "two" }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("LIMIT_EXCEEDED");
  });
});

describe("query, snapshot, and audit", () => {
  async function populated(): Promise<Harness> {
    const built = harness();
    unwrap(
      await built.store.append({
        record: {
          ...explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
          labels: ["style", "editor"],
        },
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await built.store.append({
        record: inferredCandidate({ recordId: "c1", subject: "Editor", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await built.store.append({
        record: {
          ...verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
          classification: "proprietary-source",
        },
        purpose: "context-assembly",
      }),
    );
    return built;
  }

  it("filters by variant, label, subject, and classification ceiling", async () => {
    const { store } = await populated();
    expect(
      unwrap(
        await store.query({
          scope: USER_SCOPE,
          purpose: "context-assembly",
          variants: ["explicit-preference"],
        }),
      ).entries.map((entry) => entry.record.recordId),
    ).toEqual(["p1"]);
    expect(
      unwrap(
        await store.query({ scope: USER_SCOPE, purpose: "context-assembly", labels: ["style"] }),
      ).entries.map((entry) => entry.record.recordId),
    ).toEqual(["p1"]);
    expect(
      unwrap(
        await store.query({
          scope: USER_SCOPE,
          purpose: "context-assembly",
          subjectDigest: createMemorySubject("Editor").digest,
        }),
      ).entries.map((entry) => entry.record.recordId),
    ).toEqual(["c1"]);
    const ceiling = unwrap(
      await store.query({
        scope: USER_SCOPE,
        purpose: "context-assembly",
        maxClassification: "internal",
      }),
    );
    expect(ceiling.entries.map((entry) => entry.record.recordId)).toEqual(["c1", "p1"]);
  });

  it("returns a stable order and a deterministic fingerprint", async () => {
    const { store } = await populated();
    const first = unwrap(await store.query({ scope: USER_SCOPE, purpose: "context-assembly" }));
    const second = unwrap(await store.query({ scope: USER_SCOPE, purpose: "context-assembly" }));
    expect(first.entries.map((entry) => entry.record.recordId)).toEqual(["c1", "f1", "p1"]);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("reports truncation rather than silently dropping matches", async () => {
    const { store } = await populated();
    const limited = unwrap(
      await store.query({ scope: USER_SCOPE, purpose: "context-assembly", limit: 1 }),
    );
    expect(limited.entries).toHaveLength(1);
    expect(limited.totalMatched).toBe(3);
    expect(limited.truncated).toBe(true);
  });

  it("exports metadata only, with no bodies in the type at all", async () => {
    const { store } = await populated();
    const snapshot = unwrap(await store.snapshot({ scope: USER_SCOPE, purpose: "export" }));
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("npm run check");
    expect(serialized).not.toContain("tabs");
    expect(snapshot.counts["explicit-preference"]).toBe(1);
    expect(snapshot.entries.every((entry) => entry.recordFingerprint.length === 64)).toBe(true);
  });

  it("keeps the snapshot fingerprint independent of when it was taken", async () => {
    const built = await populated();
    const first = unwrap(await built.store.snapshot({ scope: USER_SCOPE, purpose: "export" }));
    built.clock.advance(86_400_000);
    const later = unwrap(await built.store.snapshot({ scope: USER_SCOPE, purpose: "export" }));
    expect(later.takenAt).not.toBe(first.takenAt);
    expect(later.fingerprint).toBe(first.fingerprint);
  });

  it("journals every change without recording any content", async () => {
    const { store, port } = await populated();
    const events = unwrap(await store.events({ scope: USER_SCOPE, purpose: "maintenance" }));
    expect(events.map((event) => event.kind)).toEqual(["appended", "appended", "appended"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(port.eventCount()).toBe(3);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("npm run check");
    expect(serialized).not.toContain("indentation");
  });

  it("bounds returned events", async () => {
    const { store } = await populated();
    expect(
      unwrap(await store.events({ scope: USER_SCOPE, purpose: "maintenance", limit: 2 })),
    ).toHaveLength(2);
  });
});

describe("replay determinism", () => {
  it("produces identical fingerprints for an identical sequence", async () => {
    const run = async (): Promise<{ snapshot: string; events: string }> => {
      const { store } = harness();
      unwrap(
        await store.append({
          record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
          purpose: "context-assembly",
          idempotencyKey: "req-1",
        }),
      );
      const candidate = unwrap(
        await store.append({
          record: inferredCandidate({ recordId: "c1", subject: "Editor", text: "spaces" }),
          purpose: "context-assembly",
          idempotencyKey: "req-2",
        }),
      );
      unwrap(
        await store.decideCandidate({
          scope: USER_SCOPE,
          recordId: "c1",
          expectedVersion: candidate.version,
          decision: "confirm",
          purpose: "user-review",
        }),
      );
      const snapshot = unwrap(await store.snapshot({ scope: USER_SCOPE, purpose: "export" }));
      const events = unwrap(await store.events({ scope: USER_SCOPE, purpose: "maintenance" }));
      return {
        snapshot: snapshot.fingerprint,
        events: events.map((event) => `${event.eventId}:${event.kind}:${event.recordFingerprint}`).join("|"),
      };
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  });

  it("derives the record fingerprint from declared inputs, never from wall time", () => {
    // Timestamps are inputs, not ambient readings, so the same declared input
    // always yields the same fingerprint and a different one always differs.
    const build = (createdAt: string): string =>
      createMemoryRecord(
        explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs", createdAt }),
      ).fingerprint;
    expect(build(MEMORY_EPOCH)).toBe(build(MEMORY_EPOCH));
    expect(build(MEMORY_EPOCH)).not.toBe(build("2027-01-01T00:00:00.000Z"));
  });
});
