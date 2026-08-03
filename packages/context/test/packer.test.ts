/**
 * End-to-end packing over real repository-index and memory values.
 *
 * These tests wire the actual Stage 14 producers rather than hand-written
 * candidates, so digest verification, memory lifecycle filtering, and artifact
 * resolution are exercised as a caller would meet them.
 */

import { describe, expect, it } from "vitest";
import {
  buildRepositoryIndex,
  DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
  queryRepositoryIndex,
  type RepositoryIndex,
  type RepositoryIndexSearchHit,
  type SnapshotReadPort,
} from "@ai-dev-os/repository-index";
// The fixtures subpath carries no vitest dependency, unlike `/testing`.
import {
  createManualIndexClock,
  createMemorySnapshotPort,
} from "@ai-dev-os/repository-index/testing/fixtures";
import {
  createProjectContextAuthorizer,
  denyAllContextAuthorizer,
  type ContextAuthorizationDecision,
  type ContextAuthorizer,
} from "../src/authorization.js";
import { collectContextCandidates, type ContextSources } from "../src/collect.js";
import type { ContextResult } from "../src/errors.js";
import { conservativeUnitEstimator } from "../src/estimator.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CONTEXT_CONFIGURATION,
  withContextOverrides,
  type ContextConfiguration,
} from "../src/model.js";
import { summarizeContextPack, type ContextPack } from "../src/pack.js";
import { buildContextPack, createContextPacker } from "../src/packer.js";
import { planContextPack } from "../src/select.js";
import {
  artifactReference,
  candidate,
  CONTEXT_EPOCH,
  CONTEXT_INJECTION_CANARY,
  contextRequest,
  createFixtureArtifactPort,
  createManualContextClock,
  memoryEntry,
  POISONED_REPOSITORY_TEXT,
} from "../src/testing/fixtures.js";

const REPO_FILES: Record<string, string> = {
  "README.md": "# Atlas\n\nA sample project used by the context tests.\n",
  "src/index.ts": "export function renderWidget(): number {\n  return 1;\n}\n",
  "src/util.ts": "export const trim = (value: string): string => value.trim();\n",
};

function unwrap<T>(result: ContextResult<T> | { ok: boolean; value?: T; failure?: unknown }): T {
  if (!result.ok) {
    throw new Error(`expected success: ${JSON.stringify(result.failure)}`);
  }
  return result.value as T;
}

function code<T>(result: ContextResult<T>): string {
  if (result.ok) {
    throw new Error("expected failure");
  }
  return result.failure.code;
}

async function repositorySource(
  files: Record<string, string> = REPO_FILES,
  query = "render",
): Promise<{
  readonly index: RepositoryIndex;
  readonly readPort: SnapshotReadPort;
  readonly hits: readonly RepositoryIndexSearchHit[];
  readonly classification: "internal";
  readonly disclosure: "project-internal";
}> {
  const port = createMemorySnapshotPort({ projectId: "project-atlas", files });
  const index = unwrap(
    await buildRepositoryIndex({
      readPort: port,
      configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
      clock: createManualIndexClock(),
    }),
  );
  const hits = unwrap(queryRepositoryIndex(index, { kind: "terms", text: query, limit: 10 })).hits;
  return {
    index,
    readPort: port,
    hits,
    classification: "internal" as const,
    disclosure: "project-internal" as const,
  };
}

function allowAll(): ContextAuthorizer {
  return createProjectContextAuthorizer({ projectId: "project-atlas" });
}

async function pack(options: {
  readonly sources: ContextSources;
  readonly authorizer?: ContextAuthorizer;
  readonly configuration?: ContextConfiguration;
  readonly taskDescription?: string;
  readonly at?: string;
}): Promise<ContextPack> {
  return unwrap(
    await buildContextPack({
      request: contextRequest(
        options.taskDescription === undefined ? {} : { taskDescription: options.taskDescription },
      ),
      sources: options.sources,
      authorizer: options.authorizer ?? allowAll(),
      clock: createManualContextClock(options.at ?? CONTEXT_EPOCH),
      configuration: options.configuration ?? DEFAULT_CONTEXT_CONFIGURATION,
    }),
  );
}

/**
 * The default budget reserves bytes per category, so a test that shrinks the
 * total below those reservations must clear them — an over-reserved budget is a
 * configuration error, not a small budget.
 */
const UNRESERVED_CATEGORIES = Object.freeze({
  task: { reservedBytes: 0, maxBytes: 1_073_741_824, maxItems: 100_000 },
  constraint: { reservedBytes: 0, maxBytes: 1_073_741_824, maxItems: 100_000 },
  repository: { reservedBytes: 0, maxBytes: 1_073_741_824, maxItems: 100_000 },
  memory: { reservedBytes: 0, maxBytes: 1_073_741_824, maxItems: 100_000 },
  artifact: { reservedBytes: 0, maxBytes: 1_073_741_824, maxItems: 100_000 },
});

describe("repository candidates", () => {
  it("includes matched files with verified digests and full provenance", async () => {
    const repository = await repositorySource();
    const built = await pack({ sources: { repository } });
    const item = built.items.find((entry) => entry.identity === "repository:src/index.ts");
    expect(item).toBeDefined();
    expect(item?.sourceKind).toBe("repository-file");
    expect(item?.provenance.originFingerprint).toBe(repository.index.fingerprint);
    expect(item?.provenance.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(item?.extractionRange).toEqual({ startLine: 1, endLine: 4 });
    expect(item?.observedAt).toBe(repository.index.observedAt);
  });

  it("omits an excerpt whose bytes no longer match the recorded digest", async () => {
    const repository = await repositorySource();
    // A second port over changed content, paired with the original index.
    const drifted = createMemorySnapshotPort({
      projectId: "project-atlas",
      files: { ...REPO_FILES, "src/index.ts": "export function renderWidget(): number {\n  return 2;\n}\n" },
    });
    const built = await pack({
      sources: { repository: { ...repository, readPort: drifted } },
    });
    expect(built.items.map((entry) => entry.identity)).not.toContain("repository:src/index.ts");
    const omission = built.omissions.find((entry) => entry.identity === "repository:src/index.ts");
    expect(omission?.reason).toBe("source-digest-mismatch");
    expect(JSON.stringify(built)).not.toContain("return 2;");
  });

  it("admits a drifted excerpt when verification is switched off", async () => {
    const repository = await repositorySource();
    const drifted = createMemorySnapshotPort({
      projectId: "project-atlas",
      files: { ...REPO_FILES, "src/index.ts": "export function renderWidget(): number {\n  return 2;\n}\n" },
    });
    const built = await pack({
      sources: { repository: { ...repository, readPort: drifted } },
      configuration: unwrap(
        withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, { verifySourceDigests: false }),
      ),
    });
    expect(built.items.map((entry) => entry.identity)).toContain("repository:src/index.ts");
  });

  it("omits an entry the read port refuses", async () => {
    const repository = await repositorySource();
    const failing: SnapshotReadPort = {
      identity: () => repository.readPort.identity(),
      list: () => repository.readPort.list(),
      read: () => Promise.reject(new Error("host path /home/user/.ssh unreadable")),
    };
    const built = await pack({ sources: { repository: { ...repository, readPort: failing } } });
    expect(built.items.every((entry) => entry.sourceKind !== "repository-file")).toBe(true);
    expect(built.omissions.some((entry) => entry.reason === "source-unavailable")).toBe(true);
    expect(built.diagnostics.some((entry) => entry.code === "index-read-failed")).toBe(true);
    expect(JSON.stringify(built)).not.toContain(".ssh");
  });

  it("omits a hit with no matching index entry", async () => {
    const repository = await repositorySource();
    const built = await pack({
      sources: {
        repository: {
          ...repository,
          hits: [
            ...repository.hits,
            {
              canonicalPath: "src/ghost.ts",
              entryOrdinal: 99,
              score: 10,
              components: [],
              sourceDigestHex: null,
              languageId: "typescript",
              generated: false,
              textTruncated: false,
            },
          ],
        },
      },
    });
    expect(built.omissions.some((entry) => entry.identity === "repository:src/ghost.ts")).toBe(true);
  });

  it("omits content that is not valid UTF-8", async () => {
    const port = createMemorySnapshotPort({
      projectId: "project-atlas",
      files: { "notes.txt": { content: new Uint8Array([0x61, 0x62, 0x63]) } },
    });
    const index = unwrap(
      await buildRepositoryIndex({
        readPort: port,
        configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
        clock: createManualIndexClock(),
      }),
    );
    const broken: SnapshotReadPort = {
      identity: () => port.identity(),
      list: () => port.list(),
      read: async () => new Uint8Array([0x61, 0xc3, 0x28]),
    };
    const built = await pack({
      sources: {
        repository: {
          index,
          readPort: broken,
          hits: unwrap(queryRepositoryIndex(index, { kind: "terms", text: "notes" })).hits,
          classification: "internal",
          disclosure: "project-internal",
        },
      },
      configuration: unwrap(
        withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, { verifySourceDigests: false }),
      ),
    });
    expect(built.omissions.some((entry) => entry.reason === "source-unavailable")).toBe(true);
  });
});

describe("memory candidates", () => {
  it("includes live records and categorizes constraints separately", async () => {
    const built = await pack({
      sources: {
        memory: [
          memoryEntry({ recordId: "m1", subject: "Build", text: "Run npm run check before pushing." }),
          memoryEntry({
            recordId: "c1",
            subject: "Providers",
            text: "Never send this project to a cloud provider.",
            variant: "constraint",
          }),
        ],
      },
    });
    const constraint = built.items.find((entry) => entry.identity === "memory:c1");
    expect(constraint?.category).toBe("constraint");
    expect(built.items.find((entry) => entry.identity === "memory:m1")?.category).toBe("memory");
    // Constraints outrank ordinary memory and repository material.
    expect(built.items[0]?.category).toBe("task");
    expect(built.items[1]?.identity).toBe("memory:c1");
  });

  it("excludes expired, tombstoned, and unconfirmed material with distinct reasons", async () => {
    const built = await pack({
      // The clock is advanced past the expiry rather than the record being
      // back-dated, so expiry is evaluated against the injected clock.
      at: "2026-08-02T14:00:00.000Z",
      sources: {
        memory: [
          memoryEntry({
            recordId: "expired",
            subject: "Old",
            text: "This was true last year.",
            expiresAt: "2026-08-02T13:00:00.000Z",
          }),
          memoryEntry({
            recordId: "gone",
            subject: "Deleted",
            text: "This was deleted.",
            tombstonedAt: CONTEXT_EPOCH,
          }),
          memoryEntry({
            recordId: "guess",
            subject: "Editor",
            text: "Probably prefers spaces.",
            variant: "inferred-preference-candidate",
          }),
        ],
      },
    });
    const reasons = new Map(built.omissions.map((entry) => [entry.identity, entry.reason]));
    expect(reasons.get("memory:expired")).toBe("expired");
    expect(reasons.get("memory:gone")).toBe("tombstoned");
    expect(reasons.get("memory:guess")).toBe("unconfirmed-candidate-excluded");
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain("true last year");
    expect(serialized).not.toContain("was deleted");
    expect(serialized).not.toContain("prefers spaces");
  });

  it("admits a confirmed candidate, and an unconfirmed one only when configured", async () => {
    const confirmed = await pack({
      sources: {
        memory: [
          memoryEntry({
            recordId: "guess",
            subject: "Editor",
            text: "Prefers spaces.",
            variant: "inferred-preference-candidate",
            confirmation: "confirmed",
          }),
        ],
      },
    });
    expect(confirmed.items.some((entry) => entry.identity === "memory:guess")).toBe(true);

    const permissive = await pack({
      sources: {
        memory: [
          memoryEntry({
            recordId: "guess2",
            subject: "Editor",
            text: "Might prefer spaces.",
            variant: "inferred-preference-candidate",
          }),
        ],
      },
      configuration: unwrap(
        withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, { includeUnconfirmedCandidates: true }),
      ),
    });
    expect(permissive.items.some((entry) => entry.identity === "memory:guess2")).toBe(true);
  });

  it("omits a record whose classification exceeds the configured ceiling", async () => {
    const built = await pack({
      sources: {
        memory: [
          memoryEntry({
            recordId: "secretish",
            subject: "Personal",
            text: "Someone's home address is on file.",
            classification: "personal",
          }),
        ],
      },
    });
    const omission = built.omissions.find((entry) => entry.identity === "memory:secretish");
    expect(omission?.reason).toBe("classification-ceiling");
    expect(JSON.stringify(built)).not.toContain("home address");
  });

  it("never inlines a withheld or reference-backed body", async () => {
    const withheld = memoryEntry({ recordId: "w1", subject: "Hidden", text: "placeholder" });
    const rewritten = Object.freeze({
      ...withheld,
      record: Object.freeze({
        ...withheld.record,
        body: Object.freeze({ kind: "withheld" as const, reason: "unauthorized" as const }),
      }),
    });
    const built = await pack({ sources: { memory: [rewritten] } });
    expect(built.omissions.find((entry) => entry.identity === "memory:w1")?.reason).toBe(
      "policy-denied",
    );
  });
});

describe("artifact candidates", () => {
  it("resolves an excerpt and verifies its digest", async () => {
    const text = "A long design note that lives in the artifact store.";
    const reference = artifactReference({ artifactId: "artifact-1", text });
    const port = createFixtureArtifactPort({ contents: { "artifact-1": text } });
    const built = await pack({ sources: { artifacts: [reference], artifactPort: port } });
    expect(built.items.some((entry) => entry.identity === "artifact:artifact-1")).toBe(true);
    expect(port.reads).toEqual(["artifact-1"]);
  });

  it("omits an artifact whose served bytes disagree with the reference", async () => {
    const text = "Original design note.";
    const reference = artifactReference({ artifactId: "artifact-1", text });
    const port = createFixtureArtifactPort({
      contents: { "artifact-1": text },
      mismatch: ["artifact-1"],
    });
    const built = await pack({ sources: { artifacts: [reference], artifactPort: port } });
    expect(built.omissions.find((entry) => entry.identity === "artifact:artifact-1")?.reason).toBe(
      "source-digest-mismatch",
    );
    expect(JSON.stringify(built)).not.toContain("tampered");
  });

  it("omits an artifact the port cannot serve, without leaking its message", async () => {
    const reference = artifactReference({ artifactId: "artifact-1", text: "x" });
    const port = createFixtureArtifactPort({ contents: {}, failing: ["artifact-1"] });
    const built = await pack({ sources: { artifacts: [reference], artifactPort: port } });
    expect(built.omissions.find((entry) => entry.identity === "artifact:artifact-1")?.reason).toBe(
      "artifact-unresolved",
    );
    expect(built.diagnostics.some((entry) => entry.code === "artifact-read-failed")).toBe(true);
    expect(JSON.stringify(built)).not.toContain("/var/artifacts");
  });

  it("omits an artifact when no port was supplied at all", async () => {
    const built = await pack({
      sources: { artifacts: [artifactReference({ artifactId: "artifact-1", text: "x" })] },
    });
    expect(built.omissions.find((entry) => entry.identity === "artifact:artifact-1")?.reason).toBe(
      "artifact-unresolved",
    );
  });
});

describe("determinism and budgets", () => {
  it("produces byte-identical packs for identical inputs", async () => {
    const repository = await repositorySource();
    const sources: ContextSources = {
      repository,
      memory: [memoryEntry({ recordId: "m1", subject: "Build", text: "Run npm run check." })],
    };
    const first = await pack({ sources });
    const second = await pack({ sources });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(JSON.stringify(second.items)).toBe(JSON.stringify(first.items));
  });

  it("is unaffected by the order sources present their material", async () => {
    const repository = await repositorySource();
    const entries = [
      memoryEntry({ recordId: "m1", subject: "Build", text: "Run npm run check." }),
      memoryEntry({ recordId: "m2", subject: "Style", text: "Prefer named exports." }),
      memoryEntry({ recordId: "m3", subject: "Tests", text: "Keep tests deterministic." }),
    ];
    const forward = await pack({ sources: { repository, memory: entries } });
    const reversed = await pack({
      sources: {
        repository: { ...repository, hits: [...repository.hits].reverse() },
        memory: [...entries].reverse(),
      },
    });
    expect(reversed.fingerprint).toBe(forward.fingerprint);
  });

  it("respects the exact byte budget at its boundary", async () => {
    const body = "x".repeat(600);
    const configuration = unwrap(
      withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        budget: {
          ...DEFAULT_CONTEXT_BUDGET,
          maxTotalBytes: 1_000,
          maxTotalUnits: 1_000_000,
          minItemBytes: 1,
          categories: {
            ...UNRESERVED_CATEGORIES,
            repository: { reservedBytes: 0, maxBytes: 1_000, maxItems: 8 },
          },
        },
      }),
    );
    const planned = unwrap(
      planContextPack({
        candidates: [
          candidate({ identity: "repository:a.ts", body, baseScore: 900 }),
          candidate({ identity: "repository:b.ts", body: `${body}y`, baseScore: 800 }),
        ],
        configuration,
        estimator: conservativeUnitEstimator,
      }),
    );
    expect(planned.usage.bytes).toBe(1_000);
    expect(planned.items[1]?.truncated).toBe(true);
    expect(planned.items[1]?.byteContribution).toBe(400);
    expect(planned.diagnostics.some((entry) => entry.code === "candidate-truncated")).toBe(true);
  });

  it("stops on the unit budget even when bytes remain", async () => {
    const configuration = unwrap(
      withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        budget: {
          ...DEFAULT_CONTEXT_BUDGET,
          maxTotalBytes: 100_000,
          maxTotalUnits: 40,
          minItemBytes: 16,
          categories: {
            ...UNRESERVED_CATEGORIES,
            repository: { reservedBytes: 0, maxBytes: 100_000, maxItems: 8 },
          },
        },
      }),
    );
    const planned = unwrap(
      planContextPack({
        candidates: [
          candidate({ identity: "repository:a.ts", body: "a".repeat(90), baseScore: 900 }),
          candidate({ identity: "repository:b.ts", body: "b".repeat(90), baseScore: 800 }),
        ],
        configuration,
        estimator: conservativeUnitEstimator,
      }),
    );
    expect(planned.usage.units).toBeLessThanOrEqual(40);
    expect(planned.usage.bytes).toBeLessThan(100_000);
    expect(
      planned.items.some((entry) => entry.truncated) ||
        planned.omissions.some((entry) => entry.reason === "budget-units-exhausted"),
    ).toBe(true);
  });

  it("honours category reservations against a higher-scoring competitor", async () => {
    const configuration = unwrap(
      withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        budget: {
          ...DEFAULT_CONTEXT_BUDGET,
          maxTotalBytes: 200,
          maxTotalUnits: 1_000_000,
          minItemBytes: 1,
          allowTruncation: false,
          categories: {
            task: { reservedBytes: 0, maxBytes: 0, maxItems: 0 },
            constraint: { reservedBytes: 100, maxBytes: 100, maxItems: 2 },
            repository: { reservedBytes: 0, maxBytes: 200, maxItems: 4 },
            memory: { reservedBytes: 0, maxBytes: 200, maxItems: 4 },
            artifact: { reservedBytes: 0, maxBytes: 0, maxItems: 0 },
          },
        },
      }),
    );
    const planned = unwrap(
      planContextPack({
        candidates: [
          candidate({ identity: "repository:big.ts", body: "r".repeat(150), baseScore: 1_000_000 }),
          candidate({
            identity: "memory:c1",
            sourceKind: "memory-record",
            category: "constraint",
            body: "c".repeat(90),
            baseScore: 1,
          }),
        ],
        configuration,
        estimator: conservativeUnitEstimator,
      }),
    );
    // The constraint wins its reservation despite a far lower score.
    expect(planned.items.map((entry) => entry.identity)).toContain("memory:c1");
    expect(planned.usage.bytesByCategory.constraint).toBe(90);
  });

  it("enforces per-source-kind and per-category item caps", async () => {
    const configuration = unwrap(
      withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        budget: {
          ...DEFAULT_CONTEXT_BUDGET,
          maxBytesPerSourceKind: 60,
          minItemBytes: 1,
          allowTruncation: false,
          categories: {
            ...UNRESERVED_CATEGORIES,
            repository: { reservedBytes: 0, maxBytes: 100_000, maxItems: 1 },
          },
        },
      }),
    );
    const planned = unwrap(
      planContextPack({
        candidates: [
          candidate({ identity: "repository:a.ts", body: "a".repeat(50), baseScore: 900 }),
          candidate({ identity: "repository:b.ts", body: "b".repeat(50), baseScore: 800 }),
        ],
        configuration,
        estimator: conservativeUnitEstimator,
      }),
    );
    expect(planned.items).toHaveLength(1);
    expect(planned.omissions[0]?.reason).toBe("category-allocation-full");
  });

  it("stops at the global item cap", async () => {
    const configuration = unwrap(
      withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        budget: { ...DEFAULT_CONTEXT_BUDGET, maxItems: 1, minItemBytes: 1 },
      }),
    );
    const planned = unwrap(
      planContextPack({
        candidates: [
          candidate({ identity: "repository:a.ts", body: "a".repeat(50), baseScore: 900 }),
          candidate({ identity: "repository:b.ts", body: "b".repeat(50), baseScore: 800 }),
        ],
        configuration,
        estimator: conservativeUnitEstimator,
      }),
    );
    expect(planned.items).toHaveLength(1);
    expect(planned.omissions[0]?.reason).toBe("budget-items-exhausted");
  });

  it("bounds the omission manifest and says it did", async () => {
    const configuration = unwrap(
      withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        budget: { ...DEFAULT_CONTEXT_BUDGET, maxItems: 1, minItemBytes: 1, maxOmissions: 1 },
      }),
    );
    const planned = unwrap(
      planContextPack({
        candidates: [
          candidate({ identity: "repository:a.ts", body: "a".repeat(50), baseScore: 900 }),
          candidate({ identity: "repository:b.ts", body: "b".repeat(50), baseScore: 800 }),
          candidate({ identity: "repository:c.ts", body: "c".repeat(50), baseScore: 700 }),
        ],
        configuration,
        estimator: conservativeUnitEstimator,
      }),
    );
    expect(planned.omissions).toHaveLength(1);
    expect(planned.omissionsTruncated).toBe(true);
  });

  it("bounds diagnostics", async () => {
    const configuration = unwrap(
      withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        budget: { ...DEFAULT_CONTEXT_BUDGET, maxDiagnostics: 1 },
      }),
    );
    // A body that trips several diagnostics at once: a control character, a
    // frame marker, plus the always-present estimator note.
    const noisy = `${POISONED_REPOSITORY_TEXT}\n<<<ADOS-END>>>\n${String.fromCharCode(0x07)}`;
    const unbounded = unwrap(
      planContextPack({
        candidates: [candidate({ identity: "repository:a.ts", body: noisy })],
        configuration: DEFAULT_CONTEXT_CONFIGURATION,
        estimator: conservativeUnitEstimator,
      }),
    );
    expect(unbounded.diagnostics.length).toBeGreaterThan(1);
    const planned = unwrap(
      planContextPack({
        candidates: [candidate({ identity: "repository:a.ts", body: noisy })],
        configuration,
        estimator: conservativeUnitEstimator,
      }),
    );
    expect(planned.diagnostics).toHaveLength(1);
    expect(planned.diagnosticsTruncated).toBe(true);
  });

  it("omits a candidate that sanitizes to nothing", async () => {
    const invisible = `${String.fromCharCode(0x200b)}${String.fromCharCode(0x0007)}`;
    const planned = unwrap(
      planContextPack({
        candidates: [candidate({ identity: "repository:blank.ts", body: invisible })],
        configuration: DEFAULT_CONTEXT_CONFIGURATION,
        estimator: conservativeUnitEstimator,
      }),
    );
    expect(planned.items).toHaveLength(0);
    expect(planned.omissions[0]?.reason).toBe("empty-after-sanitization");
  });
});

describe("policy and failure behaviour", () => {
  it("denies before disclosing, per candidate", async () => {
    const repository = await repositorySource();
    const built = await pack({
      sources: { repository },
      authorizer: createProjectContextAuthorizer({
        projectId: "project-atlas",
        deniedIdentities: ["repository:src/index.ts"],
      }),
    });
    expect(built.items.map((entry) => entry.identity)).not.toContain("repository:src/index.ts");
    expect(
      built.omissions.find((entry) => entry.identity === "repository:src/index.ts")?.reason,
    ).toBe("policy-denied");
    expect(JSON.stringify(built)).not.toContain("renderWidget");
  });

  it("denies everything for a project mismatch", async () => {
    const repository = await repositorySource();
    const built = await pack({
      sources: { repository },
      authorizer: createProjectContextAuthorizer({ projectId: "project-other" }),
    });
    expect(built.items).toHaveLength(0);
    expect(built.omissions.every((entry) => entry.reason === "policy-denied")).toBe(true);
  });

  it("assembles nothing when the authorizer is unavailable", async () => {
    const result = await buildContextPack({
      request: contextRequest(),
      sources: {},
      authorizer: {
        authorize: () => {
          throw new Error("policy backend unreachable at 10.0.0.5");
        },
      },
      clock: createManualContextClock(),
    });
    expect(code(result)).toBe("AUTHORIZATION_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  });

  it("treats a malformed or conditional decision as a refusal", async () => {
    const conditional = await buildContextPack({
      request: contextRequest(),
      sources: {},
      authorizer: {
        authorize: (): ContextAuthorizationDecision =>
          Object.freeze({
            outcome: "conditional",
            reasonCode: "NEEDS_APPROVAL",
            decisionFingerprint: null,
          }),
      },
      clock: createManualContextClock(),
    });
    expect(unwrap(conditional).items).toHaveLength(0);

    const malformed = await buildContextPack({
      request: contextRequest(),
      sources: {},
      authorizer: { authorize: () => "allowed" as unknown as ContextAuthorizationDecision },
      clock: createManualContextClock(),
    });
    expect(code(malformed)).toBe("AUTHORIZATION_UNAVAILABLE");
  });

  it("rejects an invalid request, an exact estimator, and an unsatisfiable budget", async () => {
    expect(
      code(
        await buildContextPack({
          request: { ...contextRequest(), purpose: "gossip" },
          sources: {},
          authorizer: allowAll(),
          clock: createManualContextClock(),
        }),
      ),
    ).toBe("INVALID_REQUEST");
    expect(
      code(
        await buildContextPack({
          request: contextRequest(),
          sources: {},
          authorizer: allowAll(),
          clock: createManualContextClock(),
          estimator: {
            estimatorId: "liar",
            exact: true,
            bytesPerUnit: 4,
            estimate: (text: string) => text.length,
          } as never,
        }),
      ),
    ).toBe("ESTIMATOR_REJECTED");
    expect(
      code(
        await buildContextPack({
          request: contextRequest(),
          sources: {},
          authorizer: allowAll(),
          clock: createManualContextClock(),
          configuration: unwrap(
            withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
              budget: {
                ...DEFAULT_CONTEXT_BUDGET,
                maxTotalBytes: 64,
                minItemBytes: 256,
                categories: UNRESERVED_CATEGORIES,
              },
            }),
          ),
        }),
      ),
    ).toBe("BUDGET_UNSATISFIABLE");
  });

  it("honours cancellation at each stage boundary", async () => {
    const repository = await repositorySource();
    for (const abortAfter of [0, 1, 2]) {
      let seen = 0;
      const signal = {
        get aborted(): boolean {
          const value = seen >= abortAfter;
          seen += 1;
          return value;
        },
      };
      const result = await buildContextPack({
        request: contextRequest(),
        sources: { repository },
        authorizer: allowAll(),
        clock: createManualContextClock(),
        signal,
      });
      expect(code(result)).toBe("CANCELLED");
    }
  });
});

describe("packer facade", () => {
  it("threads configuration through plan, build, and render", async () => {
    const packer = createContextPacker({
      authorizer: allowAll(),
      clock: createManualContextClock(),
    });
    expect(packer.configuration).toBe(DEFAULT_CONTEXT_CONFIGURATION);
    expect(packer.estimator.exact).toBe(false);
    const planned = unwrap(
      packer.plan({ candidates: [candidate({ identity: "repository:a.ts", body: "a\n" })] }),
    );
    expect(planned.items).toHaveLength(1);
    const denied = unwrap(
      packer.plan({
        candidates: [candidate({ identity: "repository:a.ts", body: "a\n" })],
        deniedIdentities: ["repository:a.ts"],
      }),
    );
    expect(denied.items).toHaveLength(0);
    const built = unwrap(
      await packer.build({ request: contextRequest(), sources: {} }),
    );
    expect(packer.render(built).startsWith("<<<ADOS-CONTEXT")).toBe(true);
    packer.close();
    expect(code(packer.plan({ candidates: [] }))).toBe("PACKER_CLOSED");
    expect(code(await packer.build({ request: contextRequest(), sources: {} }))).toBe("PACKER_CLOSED");
  });

  it("summarizes a pack without exposing any body", async () => {
    const repository = await repositorySource();
    const built = await pack({
      sources: { repository },
      taskDescription: `Investigate ${CONTEXT_INJECTION_CANARY}`,
    });
    // Positive control: the canary is in the pack itself.
    expect(JSON.stringify(built.items)).toContain(CONTEXT_INJECTION_CANARY);
    const audit = summarizeContextPack(built);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(CONTEXT_INJECTION_CANARY);
    expect(serialized).not.toContain("renderWidget");
    expect(serialized).not.toContain("src/index.ts");
    expect(audit.itemCount).toBe(built.items.length);
    expect(audit.itemDigests).toEqual(built.items.map((entry) => entry.digest));
    expect(audit.packFingerprint).toBe(built.fingerprint);
  });

  it("returns the pack and writes nothing", async () => {
    const repository = await repositorySource();
    const before = repository.readPort.identity();
    const built = await pack({ sources: { repository } });
    expect(repository.readPort.identity()).toEqual(before);
    // There is no sink parameter and no write method on the packer at all.
    const packer = createContextPacker({ authorizer: allowAll(), clock: createManualContextClock() });
    expect(Object.keys(packer).sort()).toEqual([
      "build",
      "close",
      "configuration",
      "estimator",
      "plan",
      "render",
    ]);
    expect(built.items.length).toBeGreaterThan(0);
  });
});

describe("collection directly", () => {
  it("classifies the task description at the configured ceiling and marks it untrusted", async () => {
    const collected = await collectContextCandidates({
      request: contextRequest({ taskDescription: "Do the thing." }),
      sources: {},
      configuration: DEFAULT_CONTEXT_CONFIGURATION,
      now: new Date(CONTEXT_EPOCH),
    });
    const task = collected.candidates[0];
    expect(task?.sourceKind).toBe("task-description");
    expect(task?.classification).toBe(DEFAULT_CONTEXT_CONFIGURATION.maxClassification);
    expect(task?.trust).toBe("untrusted");
    expect(task?.disclosure).toBe("scope-only");
  });

  it("produces no task candidate for an empty description", async () => {
    const collected = await collectContextCandidates({
      request: contextRequest({ taskDescription: "" }),
      sources: {},
      configuration: DEFAULT_CONTEXT_CONFIGURATION,
      now: new Date(CONTEXT_EPOCH),
    });
    expect(collected.candidates).toHaveLength(0);
  });
});
