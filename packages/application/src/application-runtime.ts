import { validation } from "@ai-dev-os/domain";
import { isPersistenceError, type PersistenceAdapter } from "@ai-dev-os/persistence";
import type { PostgresAdapterOptions } from "@ai-dev-os/persistence-postgres";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import {
  DEFAULT_WORKER_RUNTIME_CONFIGURATION,
  createProductionDisabledWorkerRuntime,
  parseRuntimeUsageAdapterBinding,
  parseWorkerRuntimeCommand,
  parseWorkerRuntimeConfiguration,
  type DurableWorkerRuntime,
  type SchedulerClock,
  type UsageSnapshotAdapter,
  type WorkerRuntimeCommand,
  type WorkerRuntimeConfiguration,
  type WorkerRuntimeState,
} from "@ai-dev-os/scheduler";
import { ApplicationError } from "./errors.js";
import {
  PRODUCTION_EFFECT_CLASSES,
  STAGE_18D_APPLICATION_PRODUCTION_ENABLED,
  createProductionAdmissionGate,
  type ProductionAdmissionGateV1,
  type ProductionEffectClass,
} from "./production-admission.js";

/** @deprecated Retained as a literal-false source-compatible alias. */
export const STAGE_18C_APPLICATION_PRODUCTION_ENABLED =
  STAGE_18D_APPLICATION_PRODUCTION_ENABLED;

export type ApplicationCommand = WorkerRuntimeCommand;
export type ApplicationCommandResult =
  | WorkerRuntimeState
  | {
      readonly outcome: "created" | "duplicate";
      readonly state: WorkerRuntimeState;
    }
  | null;

export interface ProductionDisabledApplication {
  readonly productionEnabled: false;
  readonly runtime: DurableWorkerRuntime;
  execute(command: unknown): Promise<ApplicationCommandResult>;
  tick(): Promise<readonly WorkerRuntimeState[]>;
  assertProductionEffectDisabled(effectClass: ProductionEffectClass): never;
  close(): Promise<void>;
}

/** Stage 18D additive surface; the Stage 18C interface remains implementable. */
export interface Stage18DProductionDisabledApplication
  extends ProductionDisabledApplication {
  readonly admission: ProductionAdmissionGateV1;
}

export interface ProductionDisabledApplicationOptions {
  readonly persistence: PersistenceAdapter;
  readonly usageAdapter: UsageSnapshotAdapter;
  readonly clock?: SchedulerClock;
  readonly configuration?: WorkerRuntimeConfiguration;
}

export interface WindowsLocalApplicationOptions {
  /** Explicit absolute path to the single-user SQLite database. */
  readonly databasePath: string;
  readonly usageAdapter: UsageSnapshotAdapter;
  readonly clock?: SchedulerClock;
  readonly configuration?: WorkerRuntimeConfiguration;
}

export interface PostgresProductionDisabledApplicationOptions {
  /** Explicit PostgreSQL connection; no PG environment fallback is used. */
  readonly postgres: Omit<PostgresAdapterOptions, "clock" | "observer">;
  readonly usageAdapter: UsageSnapshotAdapter;
  readonly clock?: SchedulerClock;
  readonly configuration?: WorkerRuntimeConfiguration;
}

const MAX_EFFECT_FREE_CLAIM_ATTEMPTS = 4;
const POSTGRES_APPLICATION_OPTION_KEYS = Object.freeze([
  "connection",
  "schema",
  "maximumPoolSize",
  "connectionTimeoutMs",
  "idlePoolTimeoutMs",
  "statementTimeoutMs",
  "queryTimeoutMs",
  "lockTimeoutMs",
  "idleTransactionTimeoutMs",
  "transactionTimeoutMs",
  "shutdownTimeoutMs",
] as const);

function projectPostgresOptions(
  input: unknown,
): PostgresProductionDisabledApplicationOptions["postgres"] {
  try {
    const record = validation.ensureRecord(input, "application.postgres");
    validation.ensureExactKeys(
      record,
      POSTGRES_APPLICATION_OPTION_KEYS,
      "application.postgres",
    );
    const projected: Record<string, unknown> = {
      connection: record["connection"],
    };
    for (const key of POSTGRES_APPLICATION_OPTION_KEYS.slice(1)) {
      if (record[key] !== undefined) projected[key] = record[key];
    }
    return Object.freeze(projected) as unknown as
      PostgresProductionDisabledApplicationOptions["postgres"];
  } catch {
    throw new ApplicationError(
      "INVALID_COMMAND",
      "The PostgreSQL application options are invalid.",
    );
  }
}

async function claimWithBoundedConcurrencyRetry(
  runtime: DurableWorkerRuntime,
  command: Extract<ApplicationCommand, { readonly type: "claim-work" }>,
): Promise<ApplicationCommandResult> {
  for (let attempt = 1; attempt <= MAX_EFFECT_FREE_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      return await runtime.claim(command);
    } catch (error) {
      if (
        !isPersistenceError(error, "CONCURRENCY_CONFLICT") ||
        attempt === MAX_EFFECT_FREE_CLAIM_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new ApplicationError("INVALID_COMMAND", "The bounded claim retry was exhausted.");
}

function validateRuntimeComposition(
  usageAdapter: UsageSnapshotAdapter,
  configuration: WorkerRuntimeConfiguration | undefined,
): void {
  if (
    usageAdapter === null ||
    typeof usageAdapter !== "object" ||
    typeof usageAdapter.readAuthorizedSnapshot !== "function"
  ) {
    throw new ApplicationError("INVALID_COMMAND", "The usage adapter is invalid.");
  }
  parseRuntimeUsageAdapterBinding({
    adapterId: usageAdapter.adapterId,
    schemaVersion: usageAdapter.schemaVersion,
  });
  parseWorkerRuntimeConfiguration(
    configuration ?? DEFAULT_WORKER_RUNTIME_CONFIGURATION,
  );
}

export function createProductionDisabledApplication(
  options: ProductionDisabledApplicationOptions,
): Stage18DProductionDisabledApplication {
  const runtime = createProductionDisabledWorkerRuntime({
    persistence: options.persistence,
    usageAdapter: options.usageAdapter,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.configuration === undefined
      ? {}
      : { configuration: options.configuration }),
  });
  const admission = createProductionAdmissionGate();

  const application: Stage18DProductionDisabledApplication = {
    productionEnabled: STAGE_18D_APPLICATION_PRODUCTION_ENABLED,
    admission,
    runtime,
    async execute(rawCommand): Promise<ApplicationCommandResult> {
      let command: ApplicationCommand;
      try {
        command = parseWorkerRuntimeCommand(rawCommand);
      } catch {
        throw new ApplicationError(
          "INVALID_COMMAND",
          "The application command is invalid.",
        );
      }
      switch (command.type) {
        case "enqueue-work":
          return runtime.enqueue(command);
        case "claim-work":
          return claimWithBoundedConcurrencyRetry(runtime, command);
        case "renew-lease":
          return runtime.renew(command);
        case "reserve-usage":
          return runtime.reserveUsage(command);
        case "prepare-dispatch":
          return runtime.prepareDispatch(command);
        case "mark-dispatch-started":
          return runtime.markDispatchStarted(command);
        case "complete-work":
          return runtime.complete(command);
        case "fail-work":
          return runtime.fail(command);
        case "cancel-work":
          return runtime.cancel(command);
        case "reconcile-usage":
          return runtime.reconcileUsage(command);
        default: {
          const exhaustive: never = command;
          void exhaustive;
          throw new ApplicationError(
            "INVALID_COMMAND",
            "The application command is unsupported.",
          );
        }
      }
    },
    tick: () => runtime.tick(),
    assertProductionEffectDisabled(effectClass): never {
      if (!PRODUCTION_EFFECT_CLASSES.includes(effectClass)) {
        throw new ApplicationError(
          "INVALID_COMMAND",
          "The production effect class is invalid.",
        );
      }
      return admission.assertAdmitted({
        schemaVersion: 1,
        effectClass,
      });
    },
    close: () => runtime.close(),
  };
  return Object.freeze(application);
}

export function createWindowsLocalProductionDisabledApplication(
  options: WindowsLocalApplicationOptions,
): Stage18DProductionDisabledApplication {
  validateRuntimeComposition(options.usageAdapter, options.configuration);
  const persistence = createSqlitePersistenceAdapter({
    file: options.databasePath,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return createProductionDisabledApplication({
    persistence,
    usageAdapter: options.usageAdapter,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.configuration === undefined
      ? {}
      : { configuration: options.configuration }),
  });
}

/**
 * Production-disabled team-coordination composition. This opens only the
 * explicitly configured database boundary; it wires no provider,
 * workspace, Git, credential, native-worker, or production effect.
 */
export async function createPostgresProductionDisabledApplication(
  options: PostgresProductionDisabledApplicationOptions,
): Promise<Stage18DProductionDisabledApplication> {
  validateRuntimeComposition(options.usageAdapter, options.configuration);
  const postgres = projectPostgresOptions(options.postgres);
  const { createPostgresPersistenceAdapter } = await import(
    "@ai-dev-os/persistence-postgres"
  );
  const persistence = await createPostgresPersistenceAdapter({
    ...postgres,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  try {
    return createProductionDisabledApplication({
      persistence,
      usageAdapter: options.usageAdapter,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.configuration === undefined
        ? {}
        : { configuration: options.configuration }),
    });
  } catch (error) {
    await persistence.close();
    throw error;
  }
}
