/**
 * Property tests for scope isolation and operation ordering over a bounded,
 * seeded generator. The seed appears in every case name and assertion message,
 * so a failure is replayable from the report alone.
 */

import { describe, expect, it } from "vitest";
import type { MemoryResult } from "../src/errors.js";
import { createInMemoryMemoryStore } from "../src/in-memory-port.js";
import { createMemoryStore, type MemoryStore } from "../src/store.js";
import {
  createScopedAuthorizer,
  memoryScopeKey,
  type MemoryAuthorizationDecision,
  type MemoryScope,
} from "../src/scope.js";
import {
  createCountingIdSource,
  createManualMemoryClock,
  explicitPreference,
  inferredCandidate,
  verifiedFact,
} from "../src/testing/fixtures.js";

const SEEDS = Object.freeze([5, 23, 101, 4_099, 32_768]);

function createRandom(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function unwrap<T>(result: MemoryResult<T>, seed: number): T {
  if (!result.ok) {
    throw new Error(`seed ${seed}: expected success, got ${result.failure.code}`);
  }
  return result.value;
}

const USERS = Object.freeze(["user-a", "user-b"]);
const ORGS = Object.freeze(["org-a", "org-b"]);
const PROJECTS = Object.freeze(["project-a", "project-b"]);

function randomScope(random: () => number): MemoryScope {
  return Object.freeze({
    userId: USERS[Math.floor(random() * USERS.length)] ?? "user-a",
    organizationId: ORGS[Math.floor(random() * ORGS.length)] ?? "org-a",
    projectId: PROJECTS[Math.floor(random() * PROJECTS.length)] ?? "project-a",
    workspaceId: random() < 0.5 ? null : "workspace-1",
  });
}

/** Allows every scope, so any leakage shows up rather than being masked. */
const allowEverything = {
  authorize: (): MemoryAuthorizationDecision =>
    Object.freeze({
      outcome: "allowed" as const,
      reasonCode: "TEST_ALLOW",
      bodyDisclosureAllowed: true,
      decisionFingerprint: null,
    }),
};

describe.each(SEEDS)("scope isolation properties (seed %i)", (seed) => {
  it("never returns a record outside the exact scope tuple", async () => {
    const random = createRandom(seed);
    const port = createInMemoryMemoryStore();
    const store = createMemoryStore({
      port,
      authorizer: allowEverything,
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
    });

    const written = new Map<string, Set<string>>();
    for (let index = 0; index < 24; index += 1) {
      const scope = randomScope(random);
      const recordId = `fact-${String(index).padStart(3, "0")}`;
      unwrap(
        await store.append({
          record: verifiedFact({
            recordId,
            subject: `Subject ${index}`,
            text: `Body for ${index}.`,
            scope,
          }),
          purpose: "context-assembly",
        }),
        seed,
      );
      const key = memoryScopeKey(scope);
      const bucket = written.get(key) ?? new Set<string>();
      bucket.add(recordId);
      written.set(key, bucket);
    }

    // Every distinct scope sees exactly what was written to it and nothing else.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const scope = randomScope(random);
      const key = memoryScopeKey(scope);
      const expected = [...(written.get(key) ?? new Set<string>())].sort();
      const queried = unwrap(
        await store.query({ scope, purpose: "context-assembly" }),
        seed,
      );
      expect(
        queried.entries.map((entry) => entry.record.recordId),
        `seed ${seed} attempt ${attempt}`,
      ).toEqual(expected);
      for (const entry of queried.entries) {
        expect(memoryScopeKey(entry.record.scope), `seed ${seed}`).toBe(key);
      }
    }
    await store.close();
  });
});

describe.each(SEEDS)("operation ordering properties (seed %i)", (seed) => {
  it("reaches the same state and fingerprint for an identical replay", async () => {
    const random = createRandom(seed);
    const scope: MemoryScope = Object.freeze({
      userId: "user-a",
      organizationId: "org-a",
      projectId: "project-a",
      workspaceId: null,
    });

    // A fixed, seeded operation script, replayed twice against fresh stores.
    const script: readonly { readonly kind: "preference" | "candidate" | "fact"; readonly id: number }[] =
      Object.freeze(
        Array.from({ length: 12 }, (_unused, index) => {
          const roll = random();
          return Object.freeze({
            kind: roll < 0.34 ? ("preference" as const) : roll < 0.67 ? ("candidate" as const) : ("fact" as const),
            id: index,
          });
        }),
      );

    const run = async (): Promise<{ readonly snapshot: string; readonly events: string }> => {
      const store: MemoryStore = createMemoryStore({
        port: createInMemoryMemoryStore(),
        authorizer: createScopedAuthorizer({ scope }),
        clock: createManualMemoryClock(),
        idSource: createCountingIdSource(),
      });
      for (const step of script) {
        const recordId = `${step.kind}-${String(step.id).padStart(3, "0")}`;
        const input =
          step.kind === "preference"
            ? explicitPreference({ recordId, subject: `Topic ${step.id}`, text: `Prefer ${step.id}.`, scope })
            : step.kind === "candidate"
              ? inferredCandidate({ recordId, subject: `Topic ${step.id}`, text: `Maybe ${step.id}.`, scope })
              : verifiedFact({ recordId, subject: `Topic ${step.id}`, text: `Fact ${step.id}.`, scope });
        const appended = unwrap(
          await store.append({ record: input, purpose: "context-assembly", idempotencyKey: recordId }),
          seed,
        );
        // Appending the same thing again under the same key must be a no-op.
        const repeated = unwrap(
          await store.append({ record: input, purpose: "context-assembly", idempotencyKey: recordId }),
          seed,
        );
        expect(repeated.record.fingerprint, `seed ${seed}`).toBe(appended.record.fingerprint);
        expect(repeated.version, `seed ${seed}`).toBe(appended.version);
        if (step.kind === "candidate") {
          unwrap(
            await store.decideCandidate({
              scope,
              recordId,
              expectedVersion: appended.version,
              decision: step.id % 2 === 0 ? "confirm" : "reject",
              purpose: "user-review",
            }),
            seed,
          );
        }
      }
      const snapshot = unwrap(await store.snapshot({ scope, purpose: "export" }), seed);
      const events = unwrap(await store.events({ scope, purpose: "maintenance" }), seed);
      await store.close();
      return {
        snapshot: snapshot.fingerprint,
        events: events.map((event) => `${event.eventId}:${event.kind}:${event.version}`).join("|"),
      };
    };

    const first = await run();
    const second = await run();
    expect(second.snapshot, `seed ${seed}`).toBe(first.snapshot);
    expect(second.events, `seed ${seed}`).toBe(first.events);
  });
});
