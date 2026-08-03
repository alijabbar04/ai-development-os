/**
 * Reusable behavioural contract for any `MemoryStorePort` implementation.
 *
 * Written against the port, not the in-memory adapter, so a durable Stage 3
 * backed adapter can be held to identical guarantees — in particular the
 * atomicity of entry-plus-event application, which is easy to lose and hard to
 * notice.
 */

import { describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../store.js";
import type { MemoryEvent, MemoryStorePort } from "../port.js";
import { createScopedAuthorizer } from "../scope.js";
import {
  createCountingIdSource,
  createManualMemoryClock,
  explicitPreference,
  inferredCandidate,
  OTHER_PROJECT_SCOPE,
  OTHER_USER_SCOPE,
  USER_SCOPE,
  verifiedFact,
} from "./fixtures.js";

/**
 * The fixtures are part of the testing entry point: a consumer that adopts the
 * contract suite invariably needs the manual clock, the counting identifier
 * source, and the scope tuples alongside it.
 */
export * from "./fixtures.js";

export interface MemoryPortContractHarness {
  createPort(): Promise<MemoryStorePort> | MemoryStorePort;
  dispose?(): Promise<void>;
}

function unwrap<T>(result: { ok: boolean; value?: T; failure?: unknown }): T {
  if (!result.ok) {
    throw new Error(`expected success: ${JSON.stringify(result.failure)}`);
  }
  return result.value as T;
}

function failureCode(result: { ok: boolean; failure?: { code: string } }): string {
  if (result.ok) {
    throw new Error("expected failure");
  }
  return result.failure?.code ?? "";
}

export function runMemoryPortContractSuite(
  suiteName: string,
  createHarness: () => Promise<MemoryPortContractHarness> | MemoryPortContractHarness,
): void {
  describe(`memory port contract: ${suiteName}`, () => {
    async function open(
      auditObserver?: (event: Omit<MemoryEvent, "sequence">) => void,
    ): Promise<{ store: MemoryStore; harness: MemoryPortContractHarness }> {
      const harness = await createHarness();
      const port = await harness.createPort();
      const store = createMemoryStore({
        port,
        authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
        clock: createManualMemoryClock(),
        idSource: createCountingIdSource(),
        ...(auditObserver === undefined ? {} : { auditObserver }),
      });
      return { store, harness };
    }

    it("stores and reads a record within its exact scope", async () => {
      const { store, harness } = await open();
      const appended = unwrap(
        await store.append({
          record: verifiedFact({ recordId: "fact-1", subject: "Build command", text: "npm run check" }),
          purpose: "context-assembly",
        }),
      );
      expect(appended.version).toBe(1);
      const read = unwrap(
        await store.read({ scope: USER_SCOPE, recordId: "fact-1", purpose: "context-assembly" }),
      );
      expect(read.record.fingerprint).toBe(appended.record.fingerprint);
      await store.close();
      await harness.dispose?.();
    });

    it("fails closed for every other scope", async () => {
      const { store, harness } = await open();
      unwrap(
        await store.append({
          record: verifiedFact({ recordId: "fact-1", subject: "Build command", text: "npm run check" }),
          purpose: "context-assembly",
        }),
      );
      for (const scope of [OTHER_USER_SCOPE, OTHER_PROJECT_SCOPE]) {
        const result = await store.read({ scope, recordId: "fact-1", purpose: "context-assembly" });
        expect(failureCode(result)).toBe("AUTHORIZATION_DENIED");
      }
      await store.close();
      await harness.dispose?.();
    });

    it("writes exactly one audit event per applied change", async () => {
      const observed: string[] = [];
      const { store, harness } = await open((event) => observed.push(event.kind));
      unwrap(
        await store.append({
          record: inferredCandidate({ recordId: "cand-1", subject: "Editor", text: "prefers spaces" }),
          purpose: "context-assembly",
        }),
      );
      const events = unwrap(
        await store.events({ scope: USER_SCOPE, purpose: "maintenance" }),
      );
      expect(events.map((event) => event.kind)).toEqual(["appended"]);
      expect(observed).toEqual(["appended"]);
      expect(events[0]?.sequence).toBe(1);
      await store.close();
      await harness.dispose?.();
    });

    it("makes no change at all when the change cannot be audited", async () => {
      const { store, harness } = await open(() => {
        throw new Error("audit sink unavailable");
      });
      const result = await store.append({
        record: verifiedFact({ recordId: "fact-1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
      });
      expect(failureCode(result)).toBe("AUDIT_FAILURE");
      const read = await store.read({
        scope: USER_SCOPE,
        recordId: "fact-1",
        purpose: "context-assembly",
      });
      expect(failureCode(read)).toBe("NOT_FOUND");
      await store.close();
      await harness.dispose?.();
    });

    it("enforces compare-and-set on concurrent decisions", async () => {
      const { store, harness } = await open();
      const candidate = unwrap(
        await store.append({
          record: inferredCandidate({ recordId: "cand-1", subject: "Editor", text: "prefers spaces" }),
          purpose: "context-assembly",
        }),
      );
      const first = await store.decideCandidate({
        scope: USER_SCOPE,
        recordId: "cand-1",
        expectedVersion: candidate.version,
        decision: "confirm",
        purpose: "user-review",
      });
      expect(first.ok).toBe(true);
      const stale = await store.decideCandidate({
        scope: USER_SCOPE,
        recordId: "cand-1",
        expectedVersion: candidate.version,
        decision: "reject",
        purpose: "user-review",
      });
      expect(failureCode(stale)).toBe("VERSION_CONFLICT");
      await store.close();
      await harness.dispose?.();
    });

    it("keeps a tombstone as a replicable record and refuses resurrection", async () => {
      const { store, harness } = await open();
      const entry = unwrap(
        await store.append({
          record: verifiedFact({ recordId: "fact-1", subject: "Build", text: "npm run check" }),
          purpose: "context-assembly",
        }),
      );
      unwrap(
        await store.tombstone({
          scope: USER_SCOPE,
          recordId: "fact-1",
          expectedVersion: entry.version,
          tombstoneRecordId: "tomb-1",
          purpose: "maintenance",
          recordedBy: "memory-test",
        }),
      );
      const snapshot = unwrap(await store.snapshot({ scope: USER_SCOPE, purpose: "maintenance" }));
      expect(snapshot.entries.map((item) => item.recordId)).toEqual(["fact-1", "tomb-1"]);
      expect(snapshot.counts.tombstone).toBe(1);

      const replay = await store.append({
        record: verifiedFact({ recordId: "fact-1", subject: "Build", text: "npm run check" }),
        purpose: "context-assembly",
      });
      expect(failureCode(replay)).toBe("TOMBSTONED");
      await store.close();
      await harness.dispose?.();
    });

    it("is idempotent for a repeated key and conflicts on a changed record", async () => {
      const { store, harness } = await open();
      const record = verifiedFact({ recordId: "fact-1", subject: "Build", text: "npm run check" });
      const first = unwrap(
        await store.append({ record, purpose: "context-assembly", idempotencyKey: "req-1" }),
      );
      const repeat = unwrap(
        await store.append({ record, purpose: "context-assembly", idempotencyKey: "req-1" }),
      );
      expect(repeat.record.fingerprint).toBe(first.record.fingerprint);
      expect(repeat.version).toBe(first.version);

      const different = await store.append({
        record: verifiedFact({ recordId: "fact-2", subject: "Build", text: "npm test" }),
        purpose: "context-assembly",
        idempotencyKey: "req-1",
      });
      expect(failureCode(different)).toBe("IDEMPOTENCY_CONFLICT");
      await store.close();
      await harness.dispose?.();
    });

    it("never lets an inferred candidate supersede an explicit preference", async () => {
      const { store, harness } = await open();
      unwrap(
        await store.append({
          record: explicitPreference({ recordId: "pref-1", subject: "Indentation", text: "tabs" }),
          purpose: "context-assembly",
        }),
      );
      const result = await store.append({
        record: inferredCandidate({
          recordId: "cand-1",
          subject: "Indentation",
          text: "spaces",
          supersedes: "pref-1",
        }),
        purpose: "context-assembly",
      });
      expect(failureCode(result)).toBe("PRECEDENCE_VIOLATION");

      // The candidate is still storable as evidence; it just cannot displace.
      unwrap(
        await store.append({
          record: inferredCandidate({ recordId: "cand-1", subject: "Indentation", text: "spaces" }),
          purpose: "context-assembly",
        }),
      );
      const resolved = unwrap(
        await store.resolvePreference({
          scope: USER_SCOPE,
          subjectDigest: unwrap(
            await store.read({ scope: USER_SCOPE, recordId: "pref-1", purpose: "context-assembly" }),
          ).record.subject.digest,
          purpose: "context-assembly",
        }),
      );
      expect(resolved.explicit?.record.recordId).toBe("pref-1");
      expect(resolved.candidates.map((entry) => entry.confirmation)).toEqual(["unconfirmed"]);
      await store.close();
      await harness.dispose?.();
    });

    it("produces identical state on an identical replay", async () => {
      const run = async (): Promise<string> => {
        const { store, harness } = await open();
        unwrap(
          await store.append({
            record: explicitPreference({ recordId: "pref-1", subject: "Indentation", text: "tabs" }),
            purpose: "context-assembly",
          }),
        );
        const candidate = unwrap(
          await store.append({
            record: inferredCandidate({ recordId: "cand-1", subject: "Editor", text: "spaces" }),
            purpose: "context-assembly",
          }),
        );
        unwrap(
          await store.decideCandidate({
            scope: USER_SCOPE,
            recordId: "cand-1",
            expectedVersion: candidate.version,
            decision: "reject",
            purpose: "user-review",
          }),
        );
        const snapshot = unwrap(await store.snapshot({ scope: USER_SCOPE, purpose: "maintenance" }));
        await store.close();
        await harness.dispose?.();
        return snapshot.fingerprint;
      };
      expect(await run()).toBe(await run());
    });

    it("refuses every operation once closed", async () => {
      const { store, harness } = await open();
      await store.close();
      expect(
        failureCode(
          await store.append({
            record: verifiedFact({ recordId: "fact-1", subject: "Build", text: "npm run check" }),
            purpose: "context-assembly",
          }),
        ),
      ).toBe("STORE_CLOSED");
      expect(
        failureCode(await store.query({ scope: USER_SCOPE, purpose: "context-assembly" })),
      ).toBe("STORE_CLOSED");
      expect(
        failureCode(await store.snapshot({ scope: USER_SCOPE, purpose: "maintenance" })),
      ).toBe("STORE_CLOSED");
      await harness.dispose?.();
    });
  });
}
