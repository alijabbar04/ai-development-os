import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createPostgresPersistenceAdapter } from "@ai-dev-os/persistence-postgres";
import {
  createProductionDisabledWorkerRuntime,
  type ProviderCircuitEvidence,
  type UsageSnapshotAdapter,
  type WorkerRuntimeState,
} from "@ai-dev-os/scheduler";
import {
  createPostgresProductionDisabledApplication,
} from "../src/index.js";
import {
  createApplicationContractClock,
  createApplicationContractDefinition,
  runApplicationPersistenceContractSuite,
  type ApplicationContractClock,
} from "../src/testing/index.js";
import { parseApplicationLivePostgresConfiguration } from "./postgres-live-configuration.js";

const liveConfiguration = parseApplicationLivePostgresConfiguration(process.env);
const required = liveConfiguration.required;
const execFileAsync = promisify(execFile);

let sequence = 0;
function schema(label: string): string {
  sequence += 1;
  return `ados_application_${label}_${process.pid}_${sequence}`.slice(0, 63);
}

const connection = liveConfiguration.connection;

async function dropSchema(schemaName: string): Promise<void> {
  if (connection === null || !/^ados_application_[a-z0-9_]{1,46}$/.test(schemaName)) {
    throw new Error("Refusing to drop a schema outside the task-owned application-test namespace.");
  }
  const pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await pool.end();
  }
}

if (connection === null) {
  describe("PostgreSQL application contract", () => {
    (required ? it : it.skip)("requires explicit hosted PostgreSQL configuration", () => {
      if (required) {
        throw new Error("AI_DEV_OS_REQUIRE_POSTGRES_TESTS=1 but explicit PostgreSQL test configuration is incomplete.");
      }
    });
  });
} else {
  runApplicationPersistenceContractSuite(
    "PostgreSQL physical reopen",
    async (clock: ApplicationContractClock) => {
      const schemaName = schema("contract");
      const open = () => createPostgresPersistenceAdapter({
        connection,
        schema: schemaName,
        clock,
      });
      return {
        persistence: await open(),
        reopen: open,
        dispose: () => dropSchema(schemaName),
      };
    },
    { supportsReopen: true },
  );

  describe("PostgreSQL production-disabled application factory", () => {
    it("opens explicit database persistence while every production effect remains refused", async () => {
      const schemaName = schema("factory");
      const application = await createPostgresProductionDisabledApplication({
        postgres: { connection, schema: schemaName },
        usageAdapter: {
          adapterId: "adapter:postgres-application-test",
          schemaVersion: 2,
          readAuthorizedSnapshot: async () => null,
        },
      });
      try {
        expect(application.productionEnabled).toBe(false);
        expect(() => application.assertProductionEffectDisabled("network")).toThrowError(
          expect.objectContaining({ code: "PRODUCTION_DISABLED" }),
        );
      } finally {
        await application.close();
        await dropSchema(schemaName);
      }
    });

    it("lets independent application connections claim different ready work under contention", async () => {
      const schemaName = schema("independent_claims");
      const clock = createApplicationContractClock();
      const usageAdapter = {
        adapterId: "adapter:postgres-independent-claims",
        schemaVersion: 2 as const,
        readAuthorizedSnapshot: async () => null,
      };
      const first = await createPostgresProductionDisabledApplication({
        postgres: { connection, schema: schemaName }, usageAdapter, clock,
      });
      const second = await createPostgresProductionDisabledApplication({
        postgres: { connection, schema: schemaName }, usageAdapter, clock,
      });
      const definitionFor = (suffix: string) => {
        const base = createApplicationContractDefinition();
        return {
          ...base,
          workId: `work:postgres-claim:${suffix}`,
          task: {
            ...base.task,
            taskId: `task:postgres-claim:${suffix}`,
            correlationId: `correlation:postgres-claim:${suffix}`,
            idempotencyKey: `idempotency:postgres-claim:${suffix}`,
            objective: `Prove independent PostgreSQL claim ${suffix}.`,
          },
          fairnessKey: `tenant:postgres-claim:${suffix}`,
        };
      };
      try {
        for (const suffix of ["one", "two"]) {
          await first.execute({
            type: "enqueue-work",
            commandId: `command:postgres-claim:enqueue:${suffix}`,
            definition: definitionFor(suffix),
          });
        }
        const [firstClaim, secondClaim] = await Promise.all([
          first.execute({
            type: "claim-work", commandId: "command:postgres-claim:first",
            workerId: "worker:postgres:first", allowedCapacityPools: ["default"],
          }),
          second.execute({
            type: "claim-work", commandId: "command:postgres-claim:second",
            workerId: "worker:postgres:second", allowedCapacityPools: ["default"],
          }),
        ]);
        if (
          firstClaim === null || "outcome" in firstClaim || firstClaim.lease === null ||
          secondClaim === null || "outcome" in secondClaim || secondClaim.lease === null
        ) {
          throw new Error("Expected two independently leased PostgreSQL work items.");
        }
        expect(new Set([
          firstClaim.definition.task.idempotencyKey,
          secondClaim.definition.task.idempotencyKey,
        ]).size).toBe(2);
        expect(new Set([firstClaim.lease.workerId, secondClaim.lease.workerId])).toEqual(
          new Set(["worker:postgres:first", "worker:postgres:second"]),
        );
      } finally {
        await Promise.allSettled([first.close(), second.close()]);
        await dropSchema(schemaName);
      }
    });

    it("keeps a shared borrowed-usage cap closed under two independent PostgreSQL reservations", async () => {
      const schemaName = schema("borrowed_cap");
      const clock = createApplicationContractClock();
      const profileId = "profile:postgres-borrowed-cap";
      const adapterId = "adapter:postgres-borrowed-cap";
      const usageAdapter: UsageSnapshotAdapter = Object.freeze({
        adapterId,
        schemaVersion: 2,
        async readAuthorizedSnapshot(requestedProfileId: string) {
          if (requestedProfileId !== profileId) {
            return null;
          }
          return {
            schemaVersion: 2,
            compatibility: "native-v2",
            snapshotId: "usage:postgres-borrowed-cap",
            sourceAdapterId: adapterId,
            sourceAdapterVersion: "version:1",
            sourceFingerprint: "c".repeat(64),
            sourceClass: "provider-authoritative",
            authoritative: true,
            confidence: "high",
            profileId,
            providerId: "provider:fixture",
            ownership: "authorized-borrowed",
            authorization: "authorized",
            revocation: "not-revoked",
            timezone: "Europe/London",
            observedAt: "2026-08-10T10:00:00.000Z",
            freshUntil: "2026-08-10T10:15:00.000Z",
            fiveHour: {
              windowId: "window:postgres-borrowed-cap:five-hour",
              usedBasisPoints: 4_800,
              remainingBasisPoints: 5_200,
              resetAt: "2026-08-10T13:00:00.000Z",
            },
            weekly: {
              windowId: "window:postgres-borrowed-cap:weekly",
              usedBasisPoints: 6_800,
              remainingBasisPoints: 3_200,
              resetAt: "2026-08-17T00:00:00.000Z",
            },
          };
        },
      });
      let barrierEnabled = false;
      let entered = 0;
      let markBothEntered!: () => void;
      let releaseBoth!: () => void;
      const bothEntered = new Promise<void>((resolve) => {
        markBothEntered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      const fault = async (): Promise<void> => {
        if (!barrierEnabled) return;
        entered += 1;
        if (entered === 2) markBothEntered();
        await released;
      };
      const first = createProductionDisabledWorkerRuntime({
        persistence: await createPostgresPersistenceAdapter({
          connection, schema: schemaName, clock,
        }),
        usageAdapter,
        clock,
        fault,
      });
      const second = createProductionDisabledWorkerRuntime({
        persistence: await createPostgresPersistenceAdapter({
          connection, schema: schemaName, clock,
        }),
        usageAdapter,
        clock,
        fault,
      });
      const definitionFor = (suffix: string) => {
        const base = createApplicationContractDefinition();
        return {
          ...base,
          workId: `work:postgres-borrowed-cap:${suffix}`,
          task: {
            ...base.task,
            taskId: `task:postgres-borrowed-cap:${suffix}`,
            correlationId: `correlation:postgres-borrowed-cap:${suffix}`,
            idempotencyKey: `idempotency:postgres-borrowed-cap:${suffix}`,
            objective: `Prove borrowed PostgreSQL cap ${suffix}.`,
            requestedRoute: {
              ...base.task.requestedRoute,
              profileId,
              ownership: "authorized-borrowed" as const,
            },
          },
          candidate: {
            ...base.candidate,
            candidateId: `candidate:postgres-borrowed-cap:${suffix}`,
            profileId,
            ownership: "authorized-borrowed" as const,
            borrowedPolicy: {
              taskClass: "claude-code" as const,
              taskAuthorized: true,
              modelAllowed: true,
            },
            predictedFiveHourBasisPoints: 150,
            predictedWeeklyBasisPoints: 150,
          },
          fairnessKey: `tenant:postgres-borrowed-cap:${suffix}`,
        };
      };
      const fence = (state: WorkerRuntimeState) => {
        if (state.lease === null) throw new Error("Expected a durable lease.");
        return {
          idempotencyKey: state.definition.task.idempotencyKey,
          leaseId: state.lease.leaseId,
          workerId: state.lease.workerId,
          fencingToken: state.lease.fencingToken,
        };
      };
      const circuit = (state: WorkerRuntimeState): ProviderCircuitEvidence => ({
        schemaVersion: 1,
        evidenceId: `circuit:${state.definition.workId}`,
        providerId: state.definition.candidate.providerId,
        profileId,
        state: "closed",
        observedAt: "2026-08-10T10:00:00.000Z",
        sourceFingerprint: "d".repeat(64),
      });
      try {
        await first.enqueue({
          type: "enqueue-work",
          commandId: "command:postgres-borrowed-cap:enqueue:one",
          definition: definitionFor("one"),
        });
        await first.enqueue({
          type: "enqueue-work",
          commandId: "command:postgres-borrowed-cap:enqueue:two",
          definition: definitionFor("two"),
        });
        const firstClaim = await first.claim({
          type: "claim-work",
          commandId: "command:postgres-borrowed-cap:claim:one",
          workerId: "worker:postgres-borrowed-cap:one",
          allowedCapacityPools: ["default"],
        });
        const secondClaim = await second.claim({
          type: "claim-work",
          commandId: "command:postgres-borrowed-cap:claim:two",
          workerId: "worker:postgres-borrowed-cap:two",
          allowedCapacityPools: ["default"],
        });
        if (firstClaim === null || secondClaim === null) {
          throw new Error("Expected two independently leased borrowed work items.");
        }
        barrierEnabled = true;
        const pending = Promise.allSettled([
          first.reserveUsage({
            type: "reserve-usage",
            commandId: "command:postgres-borrowed-cap:reserve:one",
            ...fence(firstClaim),
            circuit: circuit(firstClaim),
          }),
          second.reserveUsage({
            type: "reserve-usage",
            commandId: "command:postgres-borrowed-cap:reserve:two",
            ...fence(secondClaim),
            circuit: circuit(secondClaim),
          }),
        ]);
        await Promise.race([
          bothEntered,
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("Timed out waiting for both reservation transactions.")), 10_000);
          }),
        ]);
        releaseBoth();
        const outcomes = await pending;
        const fulfilled = outcomes.filter(
          (outcome): outcome is PromiseFulfilledResult<WorkerRuntimeState> => outcome.status === "fulfilled",
        );
        const rejected = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({
          code: "CONCURRENCY_CONFLICT",
          details: { reason: "serialization-failure", retryable: true },
        });
        const durable = await first.list();
        const active = durable.filter(
          (state) => state.reservation?.status === "reserved",
        );
        expect(active).toHaveLength(1);
        expect(
          6_800 + active.reduce(
            (sum, state) => sum + state.definition.candidate.predictedWeeklyBasisPoints,
            0,
          ),
        ).toBeLessThanOrEqual(7_000);
        expect(
          4_800 + active.reduce(
            (sum, state) => sum + state.definition.candidate.predictedFiveHourBasisPoints,
            0,
          ),
        ).toBeLessThanOrEqual(5_000);
      } finally {
        releaseBoth();
        await Promise.allSettled([first.close(), second.close()]);
        await dropSchema(schemaName);
      }
    }, 30_000);

    it("lets two separate Node processes claim different ready work with no duplicate lease", async () => {
      const schemaName = schema("process_claims");
      const clock = createApplicationContractClock();
      const seeder = await createPostgresProductionDisabledApplication({
        postgres: { connection, schema: schemaName },
        usageAdapter: {
          adapterId: "adapter:postgres-process-claims",
          schemaVersion: 2,
          readAuthorizedSnapshot: async () => null,
        },
        clock,
      });
      const definitionFor = (suffix: string) => {
        const base = createApplicationContractDefinition();
        return {
          ...base,
          workId: `work:postgres-process:${suffix}`,
          task: {
            ...base.task,
            taskId: `task:postgres-process:${suffix}`,
            correlationId: `correlation:postgres-process:${suffix}`,
            idempotencyKey: `idempotency:postgres-process:${suffix}`,
            objective: `Prove process-separated PostgreSQL claim ${suffix}.`,
          },
          fairnessKey: `tenant:postgres-process:${suffix}`,
        };
      };
      try {
        for (const suffix of ["one", "two"]) {
          await seeder.execute({
            type: "enqueue-work",
            commandId: `command:postgres-process:enqueue:${suffix}`,
            definition: definitionFor(suffix),
          });
        }
        await seeder.close();
        const worker = resolve(import.meta.dirname, "fixtures", "postgres-claim-worker.mjs");
        const results = await Promise.all([
          execFileAsync(process.execPath, [
            worker, schemaName, "command:postgres-process:first", "worker:postgres-process:first",
          ], { env: process.env, timeout: 30_000 }),
          execFileAsync(process.execPath, [
            worker, schemaName, "command:postgres-process:second", "worker:postgres-process:second",
          ], { env: process.env, timeout: 30_000 }),
        ]);
        const claims = results.map((result) => JSON.parse(result.stdout) as {
          readonly idempotencyKey: string;
          readonly workerId: string;
        });
        expect(new Set(claims.map((claim) => claim.idempotencyKey)).size).toBe(2);
        expect(new Set(claims.map((claim) => claim.workerId))).toEqual(new Set([
          "worker:postgres-process:first", "worker:postgres-process:second",
        ]));
      } finally {
        await seeder.close();
        await dropSchema(schemaName);
      }
    });
  });
}
