import { describe, expect, it } from "vitest";
import {
  createManualClock,
  runPersistenceContractSuite,
  type ContractHarness,
} from "@ai-dev-os/persistence/testing";
import { preparePayload, type MigrationDefinition, type OperationRecord, type PersistenceError } from "@ai-dev-os/persistence";
import type { PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import {
  INTEGRATION_SCHEMA_VERSION,
  createIntegrationAuthorityConfiguration,
  createIntegrationRequest,
  integrationDigest,
  type IntegrationAuthorityConfiguration,
  type IntegrationGitPort,
  type IntegrationRequest,
  type IntegrationValidationPort,
} from "@ai-dev-os/integrator";
import { createIntegrationServiceForTesting } from "@ai-dev-os/integrator/testing";
import { POSTGRES_MIGRATIONS, createPostgresPersistenceAdapter } from "../src/index.js";
import { createPostgresPersistenceAdapterForTesting } from "../src/testing.js";
import {
  adapterOptions,
  dropLiveSchema,
  readLivePostgresConfiguration,
  uniqueLiveSchema,
  withRawPool,
} from "./live-harness.js";

const live = readLivePostgresConfiguration();

const INTEGRATOR_T0 = "2099-08-11T09:00:00.000Z";
const INTEGRATOR_T1 = "2099-08-11T09:01:00.000Z";
const INTEGRATOR_LEASE_EXPIRY = "2099-08-11T09:30:00.000Z";
const INTEGRATOR_DEADLINE = "2099-08-11T10:00:00.000Z";
const INTEGRATOR_ROUTE = integrationDigest({ route: "postgres-live-integrator" });
const INTEGRATOR_TARGET = integrationDigest({ target: "postgres-live-shared-target" });
const INTEGRATOR_VALIDATOR = integrationDigest({ validator: "postgres-live" });

function withIntegrationDigest<T extends Record<string, unknown>, K extends string>(value: T, key: K): T & Record<K, string> {
  return Object.freeze({ ...value, [key]: integrationDigest(value) }) as T & Record<K, string>;
}

function postgresIntegrationRequest(runId: string): IntegrationRequest {
  const admission = withIntegrationDigest({
    evaluationRunId: `evaluation:${runId}`,
    evaluationRequestDigest: "1".repeat(64),
    evaluationResultDigest: "2".repeat(64),
    evaluationSubjectDigest: "3".repeat(64),
    evaluationDecision: "accepted" as const,
    authorityConfigurationFingerprint: "4".repeat(64),
    criterionManifestDigest: "5".repeat(64),
    deterministicEvidenceDigest: "6".repeat(64),
    productSpecificationId: "specification:postgres-live",
    productSpecificationDigest: "7".repeat(64),
    requirementIds: Object.freeze(["requirement:postgres-live"]),
    requirementCoverageDigest: "8".repeat(64),
    waiverDigests: Object.freeze([]),
    dissentDigest: "9".repeat(64),
    securityFindingsDigest: "a".repeat(64),
    feasibilityFindingsDigest: "b".repeat(64),
  }, "admissionDigest");
  const validationPlan = withIntegrationDigest({
    planId: "validation-plan:postgres-live",
    validatorId: "validation:postgres-live",
    validatorSchemaVersion: 1 as const,
    routeFingerprint: INTEGRATOR_VALIDATOR,
    configurationDigest: "c".repeat(64),
    commandIds: Object.freeze(["check:postgres-live"]),
    requiredCriterionIds: Object.freeze(["criterion:postgres-live"]),
    thresholdDigest: "d".repeat(64),
    allowSkips: false as const,
  }, "planDigest");
  const candidateArtifact = withIntegrationDigest({
    taskId: "task:postgres-live",
    taskResultDigest: "e".repeat(64),
    artifactId: "artifact:postgres-live",
    artifactDigest: "f".repeat(64),
    manifestId: "manifest:postgres-live",
    manifestDigest: "0".repeat(64),
  }, "bindingDigest");
  const projection = {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    runId,
    repository: Object.freeze({
      repositoryId: "repository:postgres-live",
      objectFormat: "sha1" as const,
      targetRef: "refs/heads/integration-target",
      expectedTargetCommit: "1".repeat(40),
      expectedTargetTree: "2".repeat(40),
      sourceCommit: "3".repeat(40),
      sourceTree: "4".repeat(40),
      expectedIntegratedCommit: "3".repeat(40),
      expectedIntegratedTree: "4".repeat(40),
      expectedParents: Object.freeze([]),
      mergeCommitTimestamp: null,
    }),
    gitPortId: "git:postgres-live",
    gitPortSchemaVersion: 1 as const,
    gitRouteFingerprint: INTEGRATOR_ROUTE,
    gitTargetFingerprint: INTEGRATOR_TARGET,
    strategy: "fast-forward" as const,
    allowedPaths: Object.freeze(["candidate.txt"]),
    candidateArtifact,
    admission,
    validationPlan,
    resolutionProposal: null,
    resolutionAuthorization: null,
    authorityDigest: "a".repeat(64),
    idempotencyKey: `idempotency:${runId}`,
    retryPolicy: Object.freeze({ maximumAttempts: 2, retryableFailureCodes: Object.freeze(["timeout"]), automaticRetryBeforeEffectOnly: true as const }),
    bounds: Object.freeze({ maximumPaths: 16, maximumFiles: 1_000, maximumBytes: 10_000_000, maximumConflicts: 16, maximumWallTimeMs: 10_000, maximumWorktrees: 1 as const }),
    createdAt: INTEGRATOR_T0,
    deadline: INTEGRATOR_DEADLINE,
  };
  return createIntegrationRequest(Object.freeze({ ...projection, requestDigest: integrationDigest(projection) }));
}

function postgresIntegrationAuthority(...requests: readonly IntegrationRequest[]): IntegrationAuthorityConfiguration {
  const projection = {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    configurationId: "integration-authority:postgres-live",
    authorizedRequestDigests: Object.freeze(requests.map((request) => request.requestDigest).sort()),
    authorizedAuthorityDigests: Object.freeze([...new Set(requests.map((request) => request.authorityDigest))].sort()),
    authorizedAdmissionDigests: Object.freeze(requests.map((request) => request.admission.admissionDigest).sort()),
    authorizedResolutionDigests: Object.freeze([]),
  };
  return createIntegrationAuthorityConfiguration(Object.freeze({ ...projection, configurationFingerprint: integrationDigest(projection) }));
}

const POSTGRES_INTEGRATION_GIT: IntegrationGitPort = Object.freeze({
  portId: "git:postgres-live", schemaVersion: 1, routeFingerprint: INTEGRATOR_ROUTE, targetFingerprint: INTEGRATOR_TARGET,
  async preflight() { throw new Error("claim-only contract must not invoke Git"); },
  async integrate() { throw new Error("claim-only contract must not invoke Git"); },
  async reconcile() { throw new Error("claim-only contract must not invoke Git"); },
  async cleanup() { throw new Error("claim-only contract must not invoke Git"); },
});
const POSTGRES_INTEGRATION_VALIDATOR: IntegrationValidationPort = Object.freeze({
  portId: "validation:postgres-live", schemaVersion: 1, routeFingerprint: INTEGRATOR_VALIDATOR,
  async validate() { throw new Error("claim-only contract must not invoke validation"); },
});

function claimCommand(request: IntegrationRequest, owner: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    runId: request.runId,
    commandId: `claim:${request.runId}`,
    expectedVersion: 1,
    owner,
    leaseId: `lease:${request.runId}`,
    fencingToken: null,
    leaseExpiresAt: INTEGRATOR_LEASE_EXPIRY,
    reasonCode: null,
    occurredAt: INTEGRATOR_T1,
  });
}

function withAggregateListBarrier(adapter: PersistenceAdapter, waitAtList: () => Promise<void>): { readonly adapter: PersistenceAdapter; arm(): void } {
  let armed = false;
  return Object.freeze({
    adapter: Object.freeze({
      async transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
        return await adapter.transact(async (tx) => await work(Object.freeze({
          ...tx,
          aggregates: Object.freeze({
            ...tx.aggregates,
            async list(input: Parameters<TransactionContext["aggregates"]["list"]>[0]) {
              const page = await tx.aggregates.list(input);
              if (armed && input.aggregateType === "integration-run" && input.cursor === null) await waitAtList();
              return page;
            },
          }),
        })));
      },
      migrationStatus: () => adapter.migrationStatus(),
      close: () => adapter.close(),
    }),
    arm() { armed = true; },
  });
}

if (live === null) {
  describe("PostgreSQL live integration", () => {
    it.skip("requires explicit AI_DEV_OS_TEST_POSTGRES_* configuration", () => undefined);
  });
} else if (live.connection === null) {
  describe("PostgreSQL live integration", () => {
    it("fails when the dedicated hosted gate requires missing configuration", () => {
      throw new Error("AI_DEV_OS_REQUIRE_POSTGRES_TESTS=1 but explicit test configuration is incomplete.");
    });
  });
} else {
  runPersistenceContractSuite("persistence-postgres (real PostgreSQL)", async (): Promise<ContractHarness> => {
    const schema = uniqueLiveSchema("contract");
    const clock = createManualClock();
    const observed: OperationRecord[] = [];
    const open = () => createPostgresPersistenceAdapter(adapterOptions(live, schema, {
      clock,
      observer: (record) => observed.push(record),
    }));
    return {
      adapter: await open(),
      clock,
      observed,
      reopen: open,
      corruptAggregatePayload: async (aggregateType, aggregateId) => {
        await withRawPool(live, async (pool) => {
          await pool.query(
            `UPDATE "${schema}".aggregates SET payload=payload || ' ' WHERE aggregate_type=$1 AND aggregate_id=$2`,
            [aggregateType, aggregateId],
          );
        });
      },
      corruptEventPayload: async (eventId) => {
        await withRawPool(live, async (pool) => {
          await pool.query(`UPDATE "${schema}".events SET payload=payload || ' ' WHERE event_id=$1`, [eventId]);
        });
      },
      supportsMigrations: true,
      dispose: () => dropLiveSchema(live, schema),
    };
  });

  describe("real PostgreSQL contention and migration behavior", () => {
    it("serializes concurrent migration startup and preserves one exact history", async () => {
      const schema = uniqueLiveSchema("migration_race");
      let first: Awaited<ReturnType<typeof createPostgresPersistenceAdapter>> | undefined;
      let second: Awaited<ReturnType<typeof createPostgresPersistenceAdapter>> | undefined;
      try {
        await withRawPool(live, async (pool) => {
          const holder = await pool.connect();
          let locked = false;
          try {
            await holder.query("SELECT pg_catalog.pg_advisory_lock($1, $2)", [1_092_874_307, 324_018_522]);
            locked = true;
            const openings = Promise.all([
              createPostgresPersistenceAdapter(adapterOptions(live, schema, { lockTimeoutMs: 5_000 })),
              createPostgresPersistenceAdapter(adapterOptions(live, schema, { lockTimeoutMs: 5_000 })),
            ] as const);
            void openings.catch(() => undefined);
            const deadline = Date.now() + 2_000;
            while (Date.now() < deadline) {
              const waiters = await pool.query(
                `SELECT count(*)::text AS count FROM pg_catalog.pg_locks
                  WHERE locktype='advisory' AND NOT granted
                    AND classid::text=$1 AND objid::text=$2`,
                ["1092874307", "324018522"],
              );
              if (Number(waiters.rows[0]?.["count"]) >= 2) break;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const waiters = await pool.query(
              `SELECT count(*)::text AS count FROM pg_catalog.pg_locks
                WHERE locktype='advisory' AND NOT granted
                  AND classid::text=$1 AND objid::text=$2`,
              ["1092874307", "324018522"],
            );
            expect(Number(waiters.rows[0]?.["count"])).toBeGreaterThanOrEqual(2);
            await holder.query("SELECT pg_catalog.pg_advisory_unlock($1, $2)", [1_092_874_307, 324_018_522]);
            locked = false;
            [first, second] = await openings;
          } finally {
            if (locked) {
              await holder.query("SELECT pg_catalog.pg_advisory_unlock($1, $2)", [1_092_874_307, 324_018_522]);
            }
            holder.release();
          }
        });
        if (first === undefined || second === undefined) {
          throw new Error("Expected both migration startups to complete.");
        }
        expect(await first.migrationStatus()).toMatchObject({ pending: [], databaseSchemaAhead: false });
        expect((await second.migrationStatus()).applied).toHaveLength(3);
        await Promise.all([first.close(), second.close()]);
      } finally {
        await Promise.allSettled([first?.close(), second?.close()]);
        await dropLiveSchema(live, schema);
      }
    });

    it("commits a real migration prefix, releases the lock after failure, and resumes exactly", async () => {
      const schema = uniqueLiveSchema("migration_resume");
      const second = Object.freeze({
        id: "0002-prefix-table",
        content: "CREATE TABLE migration_prefix_probe (id TEXT PRIMARY KEY);",
      }) satisfies MigrationDefinition;
      const failing = Object.freeze({
        id: "0003-resumable-table",
        content: "CREATE TABLE migration failure syntax",
      }) satisfies MigrationDefinition;
      const repaired = Object.freeze({
        id: "0003-resumable-table",
        content: "CREATE TABLE migration_resume_probe (id TEXT PRIMARY KEY);",
      }) satisfies MigrationDefinition;
      try {
        await expect(createPostgresPersistenceAdapterForTesting(adapterOptions(live, schema), {
          migrations: Object.freeze([POSTGRES_MIGRATIONS[0]!, second, failing]),
        })).rejects.toMatchObject({ code: "MIGRATION_FAILED", details: { migrationId: "0003-resumable-table" } });
        await withRawPool(live, async (pool) => {
          const committedPrefix = await pool.query(
            `SELECT id FROM "${schema}".schema_migrations ORDER BY ordinal`,
          );
          expect(committedPrefix.rows.map((row) => row["id"])).toEqual([
            "0001-initial-schema", "0002-prefix-table",
          ]);
          const probes = await pool.query(
            "SELECT pg_catalog.to_regclass($1) AS prefix, pg_catalog.to_regclass($2) AS failed",
            [`${schema}.migration_prefix_probe`, `${schema}.migration_resume_probe`],
          );
          expect(probes.rows[0]?.["prefix"]).toBe(`${schema}.migration_prefix_probe`);
          expect(probes.rows[0]?.["failed"]).toBeNull();
        });
        const resumed = await createPostgresPersistenceAdapterForTesting(adapterOptions(live, schema), {
          migrations: Object.freeze([POSTGRES_MIGRATIONS[0]!, second, repaired]),
        });
        await resumed.close();
        await withRawPool(live, async (pool) => {
          const history = await pool.query(
            `SELECT id FROM "${schema}".schema_migrations ORDER BY ordinal`,
          );
          expect(history.rows.map((row) => row["id"])).toEqual([
            "0001-initial-schema", "0002-prefix-table", "0003-resumable-table",
          ]);
        });
      } finally {
        await dropLiveSchema(live, schema);
      }
    });

    it("refuses real checksum drift and a real unknown future migration", async () => {
      for (const mode of ["checksum", "ahead"] as const) {
        const schema = uniqueLiveSchema(`migration_${mode}`);
        const seeded = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
        await seeded.close();
        try {
          await withRawPool(live, async (pool) => {
            if (mode === "checksum") {
              await pool.query(
                `UPDATE "${schema}".schema_migrations SET checksum_hex=$1 WHERE id='0001-initial-schema'`,
                ["f".repeat(64)],
              );
            } else {
              const prefix = await pool.query(
                `SELECT id FROM "${schema}".schema_migrations ORDER BY ordinal`,
              );
              expect(prefix.rows.map((row) => row["id"])).toEqual([
                "0001-initial-schema",
                "0002-evaluation-run-aggregate",
                "0003-integration-run-aggregate",
              ]);
              await pool.query(
                `INSERT INTO "${schema}".schema_migrations
                   (id, checksum_algorithm, checksum_hex, applied_at, ordinal)
                 VALUES ('9999-future-schema','sha-256',$1,'2026-08-10T22:00:00.000Z',4)`,
                ["a".repeat(64)],
              );
            }
          });
          await expect(createPostgresPersistenceAdapter(adapterOptions(live, schema))).rejects.toMatchObject({
            code: mode === "checksum" ? "MIGRATION_CHECKSUM_MISMATCH" : "SCHEMA_TOO_NEW",
          });
        } finally {
          await dropLiveSchema(live, schema);
        }
      }
    });

    it("persists and reopens a real evaluation-run aggregate and journal", async () => {
      const schema = uniqueLiveSchema("evaluation_run");
      let first: Awaited<ReturnType<typeof createPostgresPersistenceAdapter>> | undefined;
      let second: Awaited<ReturnType<typeof createPostgresPersistenceAdapter>> | undefined;
      try {
        first = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
        await first.transact(async (tx) => {
          await tx.aggregates.create({
            aggregateType: "evaluation-run",
            aggregateId: "evaluation:postgres-live",
            schemaVersion: 1,
            payload: { status: "pending" },
            traceId: null,
          });
          await tx.events.append({
            eventId: "event:evaluation-postgres-live",
            aggregateType: "evaluation-run",
            aggregateId: "evaluation:postgres-live",
            aggregateVersion: 1,
            eventType: "evaluation.event",
            eventSchemaVersion: 1,
            payload: { status: "pending" },
            occurredAt: "2026-08-11T03:40:00.000Z",
            traceId: null,
            causationId: null,
          });
        });
        await first.close();
        first = undefined;

        second = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
        const reopened = await second.transact(async (tx) => ({
          aggregate: await tx.aggregates.get("evaluation-run", "evaluation:postgres-live"),
          history: await tx.events.list({
            aggregateType: "evaluation-run",
            aggregateId: "evaluation:postgres-live",
            limit: 10,
            cursor: null,
          }),
        }));
        expect(reopened.aggregate).toMatchObject({
          aggregateType: "evaluation-run",
          aggregateId: "evaluation:postgres-live",
          aggregateVersion: 1,
          payload: { status: "pending" },
        });
        expect(reopened.history.items).toHaveLength(1);
        expect(reopened.history.items[0]).toMatchObject({
          eventId: "event:evaluation-postgres-live",
          aggregateType: "evaluation-run",
          aggregateId: "evaluation:postgres-live",
          aggregateVersion: 1,
        });
      } finally {
        await Promise.allSettled([first?.close(), second?.close()]);
        await dropLiveSchema(live, schema);
      }
    });

    it("persists and reopens a real integration-run aggregate and journal", async () => {
      const schema = uniqueLiveSchema("integration_run");
      let first: Awaited<ReturnType<typeof createPostgresPersistenceAdapter>> | undefined;
      let second: Awaited<ReturnType<typeof createPostgresPersistenceAdapter>> | undefined;
      try {
        first = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
        await first.transact(async (tx) => {
          await tx.aggregates.create({
            aggregateType: "integration-run",
            aggregateId: "integration:postgres-live",
            schemaVersion: 1,
            payload: { status: "pending" },
            traceId: null,
          });
          await tx.events.append({
            eventId: "event:integration-postgres-live",
            aggregateType: "integration-run",
            aggregateId: "integration:postgres-live",
            aggregateVersion: 1,
            eventType: "integration.event",
            eventSchemaVersion: 1,
            payload: { status: "pending" },
            occurredAt: "2026-08-11T09:00:00.000Z",
            traceId: null,
            causationId: null,
          });
        });
        await first.close();
        first = undefined;

        second = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
        const reopened = await second.transact(async (tx) => ({
          aggregate: await tx.aggregates.get("integration-run", "integration:postgres-live"),
          history: await tx.events.list({
            aggregateType: "integration-run",
            aggregateId: "integration:postgres-live",
            limit: 10,
            cursor: null,
          }),
        }));
        expect(reopened.aggregate).toMatchObject({
          aggregateType: "integration-run",
          aggregateId: "integration:postgres-live",
          aggregateVersion: 1,
          payload: { status: "pending" },
        });
        expect(reopened.history.items).toHaveLength(1);
        expect(reopened.history.items[0]).toMatchObject({
          eventId: "event:integration-postgres-live",
          aggregateType: "integration-run",
          aggregateId: "integration:postgres-live",
          aggregateVersion: 1,
        });
      } finally {
        await Promise.allSettled([first?.close(), second?.close()]);
        await dropLiveSchema(live, schema);
      }
    });

    it("serializes two integration services claiming one physical target across independent adapters", async () => {
      const schema = uniqueLiveSchema("integration_claim_race");
      const firstBase = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
      const secondBase = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
      let reopened: Awaited<ReturnType<typeof createPostgresPersistenceAdapter>> | undefined;
      let arrivals = 0;
      let release!: () => void;
      const bothListed = new Promise<void>((resolve) => { release = resolve; });
      let released = false;
      const waitAtList = async (): Promise<void> => {
        if (released) return;
        arrivals += 1;
        if (arrivals === 2) {
          released = true;
          release();
        }
        await bothListed;
      };
      const first = withAggregateListBarrier(firstBase, waitAtList);
      const second = withAggregateListBarrier(secondBase, waitAtList);
      const firstRequest = postgresIntegrationRequest("integration:postgres-race-a");
      const secondRequest = postgresIntegrationRequest("integration:postgres-race-b");
      const authority = postgresIntegrationAuthority(firstRequest, secondRequest);
      const clock = Object.freeze({ now: () => new Date(INTEGRATOR_T1) });
      const serviceFor = (persistence: PersistenceAdapter) => createIntegrationServiceForTesting({
        persistence,
        clock,
        git: POSTGRES_INTEGRATION_GIT,
        validation: POSTGRES_INTEGRATION_VALIDATOR,
        authorityConfiguration: authority,
      });
      const firstService = serviceFor(first.adapter);
      const secondService = serviceFor(second.adapter);
      try {
        await firstService.accept(firstRequest);
        await secondService.accept(secondRequest);
        first.arm();
        second.arm();
        const results = await Promise.allSettled([
          firstService.claim(claimCommand(firstRequest, "worker:postgres-a")),
          secondService.claim(claimCommand(secondRequest, "worker:postgres-b")),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        expect(rejected?.reason).toMatchObject({ code: "LEASE_CONFLICT" });

        reopened = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
        const reopenedService = serviceFor(reopened);
        const durable = await Promise.all([reopenedService.get(firstRequest.runId), reopenedService.get(secondRequest.runId)]);
        expect(durable.filter((snapshot) => snapshot?.status === "leased")).toHaveLength(1);
        expect(durable.filter((snapshot) => snapshot?.status === "pending")).toHaveLength(1);
        await expect(
          reopenedService.claim(claimCommand(durable[0]?.status === "pending" ? firstRequest : secondRequest, "worker:retry")),
        ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
      } finally {
        await Promise.allSettled([firstBase.close(), secondBase.close(), reopened?.close()]);
        await dropLiveSchema(live, schema);
      }
    });

    it("allows one optimistic writer and returns one finite conflict across adapters", async () => {
      const schema = uniqueLiveSchema("optimistic");
      const first = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
      const second = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
      try {
        await first.transact((tx) => tx.aggregates.create({
          aggregateType: "project",
          aggregateId: "project:contention",
          schemaVersion: 1,
          payload: { version: 1 },
        }));
        let readers = 0;
        let releaseReaders!: () => void;
        const bothRead = new Promise<void>((resolve) => { releaseReaders = resolve; });
        const write = (adapter: typeof first, writer: string) =>
          adapter.transact(async (tx) => {
            expect((await tx.aggregates.get("project", "project:contention"))?.aggregateVersion).toBe(1);
            readers += 1;
            if (readers === 2) releaseReaders();
            await bothRead;
            return tx.aggregates.update({
              aggregateType: "project", aggregateId: "project:contention", schemaVersion: 1,
              expectedVersion: 1, payload: { writer },
            });
          });
        const results = await Promise.allSettled([
          write(first, "first"),
          write(second, "second"),
        ]);
        expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find((item): item is PromiseRejectedResult => item.status === "rejected");
        expect(rejected?.reason).toMatchObject({
          code: "CONCURRENCY_CONFLICT",
          details: { reason: "serialization-failure", retryable: true },
        });
      } finally {
        await Promise.all([first.close(), second.close()]);
        await dropLiveSchema(live, schema);
      }
    });

    it("uses row locks with SKIP LOCKED so concurrent outbox workers claim disjoint work", async () => {
      const schema = uniqueLiveSchema("skip_locked");
      const clock = createManualClock();
      const first = await createPostgresPersistenceAdapter(adapterOptions(live, schema, { clock }));
      const second = await createPostgresPersistenceAdapter(adapterOptions(live, schema, { clock }));
      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstLocked!: () => void;
      const locked = new Promise<void>((resolve) => { firstLocked = resolve; });
      try {
        await first.transact(async (tx) => {
          for (const id of ["one", "two"]) {
            await tx.outbox.enqueue({
              messageId: `message:${id}`,
              topic: "work.ready",
              schemaVersion: 1,
              payload: { id },
              idempotencyKey: `idempotency:${id}`,
            });
          }
        });
        const firstClaimOutcome = first.transact(async (tx) => {
          const claimed = await tx.outbox.claim({ owner: "worker:first", leaseDurationMs: 1_000, limit: 1 });
          firstLocked();
          await holdFirst;
          return claimed;
        }).then(
          (claimed) => ({ status: "fulfilled" as const, claimed }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        await locked;
        const secondClaim = await second.transact((tx) => tx.outbox.claim({
          owner: "worker:second", leaseDurationMs: 1_000, limit: 1,
        }));
        releaseFirst();
        const outcome = await firstClaimOutcome;
        if (outcome.status === "rejected") {
          expect(outcome.error).toMatchObject({
            code: "CONCURRENCY_CONFLICT",
            details: { reason: "serialization-failure", retryable: true },
          });
        }
        const firstClaim = outcome.status === "fulfilled"
          ? outcome.claimed
          : await first.transact((tx) => tx.outbox.claim({
              owner: "worker:first", leaseDurationMs: 1_000, limit: 1,
            }));
        expect(firstClaim).toHaveLength(1);
        expect(secondClaim).toHaveLength(1);
        expect(firstClaim[0]?.messageId).not.toBe(secondClaim[0]?.messageId);
      } finally {
        releaseFirst();
        await Promise.all([first.close(), second.close()]);
        await dropLiveSchema(live, schema);
      }
    });

    it("holds sequence allocation through commit so keyset cursors cannot skip a late lower identity", async () => {
      const schema = uniqueLiveSchema("commit_order");
      const first = await createPostgresPersistenceAdapter(adapterOptions(live, schema, { lockTimeoutMs: 5_000 }));
      const second = await createPostgresPersistenceAdapter(adapterOptions(live, schema, { lockTimeoutMs: 5_000 }));
      const reader = await createPostgresPersistenceAdapter(adapterOptions(live, schema, { lockTimeoutMs: 5_000 }));
      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let markFirstInserted!: () => void;
      const firstInserted = new Promise<void>((resolve) => { markFirstInserted = resolve; });
      let markSecondEntered!: () => void;
      const secondEntered = new Promise<void>((resolve) => { markSecondEntered = resolve; });
      try {
        const firstWrite = first.transact(async (tx) => {
          const event = await tx.events.append({
            eventId: "event:commit-order:first", aggregateType: "project",
            aggregateId: "project:commit-order", aggregateVersion: 1,
            eventType: "project.created", eventSchemaVersion: 1,
            payload: { order: 1 }, occurredAt: "2026-08-10T22:00:00.000Z",
          });
          markFirstInserted();
          await holdFirst;
          return event;
        });
        await firstInserted;
        const secondWrite = second.transact(async (tx) => {
          markSecondEntered();
          return tx.events.append({
            eventId: "event:commit-order:second", aggregateType: "project",
            aggregateId: "project:commit-order", aggregateVersion: 2,
            eventType: "project.updated", eventSchemaVersion: 1,
            payload: { order: 2 }, occurredAt: "2026-08-10T22:00:01.000Z",
          });
        });
        await secondEntered;
        await withRawPool(live, async (pool) => {
          const deadline = Date.now() + 2_000;
          while (Date.now() < deadline) {
            const locks = await pool.query(
              "SELECT count(*)::text AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted",
            );
            if (Number(locks.rows[0]?.["count"]) >= 1) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error("The second sequence writer did not wait on the commit-order lock.");
        });
        expect((await reader.transact((tx) => tx.events.list({ limit: 1 }))).items).toEqual([]);
        releaseFirst();
        const [committedFirst, committedSecond] = await Promise.all([firstWrite, secondWrite]);
        expect(committedFirst.globalSequence).toBeLessThan(committedSecond.globalSequence);
        const pageOne = await reader.transact((tx) => tx.events.list({ limit: 1 }));
        const pageTwo = await reader.transact((tx) => tx.events.list({ limit: 1, cursor: pageOne.nextCursor }));
        expect(pageOne.items.map((item) => item.eventId)).toEqual(["event:commit-order:first"]);
        expect(pageTwo.items.map((item) => item.eventId)).toEqual(["event:commit-order:second"]);
      } finally {
        releaseFirst?.();
        await Promise.allSettled([first.close(), second.close(), reader.close()]);
        await dropLiveSchema(live, schema);
      }
    });

    it("holds outbox sequence allocation through commit so keyset cursors cannot skip work", async () => {
      const schema = uniqueLiveSchema("outbox_commit_order");
      const first = await createPostgresPersistenceAdapter(adapterOptions(live, schema, { lockTimeoutMs: 5_000 }));
      const second = await createPostgresPersistenceAdapter(adapterOptions(live, schema, { lockTimeoutMs: 5_000 }));
      const reader = await createPostgresPersistenceAdapter(adapterOptions(live, schema, { lockTimeoutMs: 5_000 }));
      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let markFirstInserted!: () => void;
      const firstInserted = new Promise<void>((resolve) => { markFirstInserted = resolve; });
      let markSecondEntered!: () => void;
      const secondEntered = new Promise<void>((resolve) => { markSecondEntered = resolve; });
      try {
        const firstWrite = first.transact(async (tx) => {
          const message = await tx.outbox.enqueue({
            messageId: "message:commit-order:first",
            topic: "work.ready",
            schemaVersion: 1,
            payload: { order: 1 },
            idempotencyKey: "idempotency:commit-order:first",
          });
          markFirstInserted();
          await holdFirst;
          return message;
        });
        await firstInserted;
        const secondWrite = second.transact(async (tx) => {
          markSecondEntered();
          return tx.outbox.enqueue({
            messageId: "message:commit-order:second",
            topic: "work.ready",
            schemaVersion: 1,
            payload: { order: 2 },
            idempotencyKey: "idempotency:commit-order:second",
          });
        });
        await secondEntered;
        await withRawPool(live, async (pool) => {
          const deadline = Date.now() + 2_000;
          while (Date.now() < deadline) {
            const locks = await pool.query(
              "SELECT count(*)::text AS count FROM pg_catalog.pg_locks WHERE locktype='advisory' AND NOT granted",
            );
            if (Number(locks.rows[0]?.["count"]) >= 1) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error("The second outbox writer did not wait on the commit-order lock.");
        });
        expect((await reader.transact((tx) => tx.outbox.list({ limit: 1 }))).items).toEqual([]);
        releaseFirst();
        const [committedFirst, committedSecond] = await Promise.all([firstWrite, secondWrite]);
        expect(committedFirst.sequence).toBeLessThan(committedSecond.sequence);
        const pageOne = await reader.transact((tx) => tx.outbox.list({ limit: 1 }));
        const pageTwo = await reader.transact((tx) => tx.outbox.list({ limit: 1, cursor: pageOne.nextCursor }));
        expect(pageOne.items.map((item) => item.messageId)).toEqual(["message:commit-order:first"]);
        expect(pageTwo.items.map((item) => item.messageId)).toEqual(["message:commit-order:second"]);
      } finally {
        releaseFirst?.();
        await Promise.allSettled([first.close(), second.close(), reader.close()]);
        await dropLiveSchema(live, schema);
      }
    });

    it("classifies a real row-lock timeout without SQL or credential leakage", async () => {
      const schema = uniqueLiveSchema("lock_timeout");
      const clock = createManualClock();
      const adapter = await createPostgresPersistenceAdapter(adapterOptions(live, schema, {
        clock,
        lockTimeoutMs: 100,
      }));
      try {
        await adapter.transact(async (tx) => {
          await tx.outbox.enqueue({
            messageId: "message:locked",
            topic: "work.ready",
            schemaVersion: 1,
            payload: { safe: true },
            idempotencyKey: "idempotency:locked",
          });
          await tx.outbox.claim({ owner: "worker:owner", leaseDurationMs: 1_000, limit: 1 });
        });
        await withRawPool(live, async (pool) => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SELECT 1 FROM "${schema}".outbox WHERE message_id=$1 FOR UPDATE`, ["message:locked"]);
            const error = await adapter.transact((tx) => tx.outbox.acknowledge({
              messageId: "message:locked", owner: "worker:owner",
            })).catch((failure: unknown) => failure as PersistenceError);
            expect(error).toMatchObject({ code: "STORAGE_FAILURE", details: { reason: "lock-timeout" } });
            expect(JSON.stringify(error)).not.toContain(live.connection.password);
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
        });
      } finally {
        await adapter.close();
        await dropLiveSchema(live, schema);
      }
    });

    it("contains a checked-out backend termination and returns a finite redacted failure", async () => {
      const schema = uniqueLiveSchema("backend_termination");
      const adapter = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
      let markEntered!: () => void;
      let releaseTransaction!: () => void;
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      const hold = new Promise<void>((resolve) => { releaseTransaction = resolve; });
      try {
        const transaction = adapter.transact(async (tx) => {
          await tx.aggregates.list({ aggregateType: "project", limit: 1 });
          markEntered();
          await hold;
          return "unreachable-success";
        });
        await entered;
        await withRawPool(live, async (pool) => {
          const target = await pool.query(
            `SELECT a.pid
               FROM pg_catalog.pg_stat_activity AS a
               JOIN pg_catalog.pg_locks AS l ON l.pid=a.pid AND l.granted
               JOIN pg_catalog.pg_class AS c ON c.oid=l.relation
               JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
              WHERE n.nspname=$1 AND c.relname='aggregates'
                AND a.state='idle in transaction' AND a.pid<>pg_catalog.pg_backend_pid()
              ORDER BY a.backend_start DESC LIMIT 1`,
            [schema],
          );
          const pid = Number(target.rows[0]?.["pid"]);
          expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
          expect(
            (await pool.query("SELECT pg_catalog.pg_terminate_backend($1) AS terminated", [pid]))
              .rows[0]?.["terminated"],
          ).toBe(true);
        });
        releaseTransaction();
        const failure = await transaction.catch((error: unknown) => error as PersistenceError);
        expect(failure).toMatchObject({
          code: "STORAGE_FAILURE",
          details: { reason: "connection", retryable: true },
        });
        expect(JSON.stringify(failure)).not.toContain(live.connection.password);
        await expect(
          adapter.transact((tx) => tx.aggregates.list({ aggregateType: "project", limit: 1 })),
        ).resolves.toMatchObject({ items: [] });
      } finally {
        releaseTransaction?.();
        await adapter.close();
        await dropLiveSchema(live, schema);
      }
    }, 30_000);

    it("fails closed on real non-payload row corruption that no public write can create", async () => {
      const schema = uniqueLiveSchema("row_corruption");
      const adapter = await createPostgresPersistenceAdapter(adapterOptions(live, schema));
      const descriptor = (id: string) => ({
        schemaVersion: 1,
        id,
        displayName: "Stored artifact record",
        kind: "structured-data",
        role: "output",
        mediaType: "application/json",
        sizeBytes: 1,
        digest: { algorithm: "sha-256", hex: "a".repeat(64) },
        classification: "internal",
        location: { type: "content-addressed", store: "local" },
        provenance: {
          producedBy: { type: "user" }, runId: null, taskId: null,
          taskRunId: null, traceId: null,
        },
        parents: [],
        createdAt: "2026-08-10T22:00:00.000Z",
      });
      try {
        await adapter.transact(async (tx) => {
          await tx.aggregates.create({
            aggregateType: "project", aggregateId: "project:corrupt-row",
            schemaVersion: 1, payload: {}, traceId: "trace:valid",
          });
          await tx.events.append({
            eventId: "event:corrupt-row", aggregateType: "project",
            aggregateId: "project:corrupt-row", aggregateVersion: 1,
            eventType: "project.created", eventSchemaVersion: 1,
            payload: {}, occurredAt: "2026-08-10T22:00:00.000Z",
          });
          await tx.outbox.enqueue({
            messageId: "message:corrupt-row", topic: "work.ready", schemaVersion: 1,
            payload: {}, idempotencyKey: "idempotency:corrupt-row",
          });
          await tx.artifacts.putDescriptor(descriptor("artifact:corrupt-row"));
          await tx.artifacts.putManifest({
            schemaVersion: 1,
            manifestId: "manifest:corrupt-row",
            taskRunId: null,
            artifacts: [descriptor("artifact:corrupt-row")],
            createdAt: "2026-08-10T22:00:00.000Z",
          });
        });
        const wrongDescriptor = preparePayload(descriptor("artifact:other"), "test.descriptor");
        const wrongManifest = preparePayload({
          schemaVersion: 1,
          manifestId: "manifest:other",
          taskRunId: null,
          artifacts: [descriptor("artifact:other")],
          createdAt: "2026-08-10T22:00:00.000Z",
        }, "test.manifest");
        await withRawPool(live, async (pool) => {
          await pool.query(
            `UPDATE "${schema}".aggregates SET trace_id='bad identity' WHERE aggregate_id='project:corrupt-row'`,
          );
          await pool.query(
            `UPDATE "${schema}".events SET event_type='Project.Created' WHERE event_id='event:corrupt-row'`,
          );
          await pool.query(
            `UPDATE "${schema}".outbox SET status='leased', attempt_count=1 WHERE message_id='message:corrupt-row'`,
          );
          await pool.query(
            `UPDATE "${schema}".artifacts SET payload=$1, checksum_algorithm=$2, checksum_hex=$3 WHERE artifact_id='artifact:corrupt-row'`,
            [wrongDescriptor.text, wrongDescriptor.checksum.algorithm, wrongDescriptor.checksum.hex],
          );
          await pool.query(
            `UPDATE "${schema}".artifact_manifests SET payload=$1, checksum_algorithm=$2, checksum_hex=$3 WHERE manifest_id='manifest:corrupt-row'`,
            [wrongManifest.text, wrongManifest.checksum.algorithm, wrongManifest.checksum.hex],
          );
        });
        await expect(adapter.transact((tx) => tx.aggregates.get("project", "project:corrupt-row")))
          .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
        await expect(adapter.transact((tx) => tx.events.list({ aggregateType: "project" })))
          .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
        await expect(adapter.transact((tx) => tx.outbox.get("message:corrupt-row")))
          .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
        await expect(adapter.transact((tx) => tx.artifacts.getDescriptor("artifact:corrupt-row")))
          .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
        await expect(adapter.transact((tx) => tx.artifacts.listDescriptors({})))
          .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
        await expect(adapter.transact((tx) => tx.artifacts.getManifest("manifest:corrupt-row")))
          .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
      } finally {
        await adapter.close();
        await dropLiveSchema(live, schema);
      }
    });
  });
}
