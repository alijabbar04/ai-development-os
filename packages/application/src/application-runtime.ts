import type { PersistenceAdapter } from "@ai-dev-os/persistence";
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

export const STAGE_18C_APPLICATION_PRODUCTION_ENABLED = false as const;

export const PRODUCTION_EFFECT_CLASSES = Object.freeze([
  "provider",
  "workspace",
  "git",
  "network",
  "native",
  "credential",
  "production-registration",
] as const);
export type ProductionEffectClass = (typeof PRODUCTION_EFFECT_CLASSES)[number];

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

export function createProductionDisabledApplication(
  options: ProductionDisabledApplicationOptions,
): ProductionDisabledApplication {
  const runtime = createProductionDisabledWorkerRuntime({
    persistence: options.persistence,
    usageAdapter: options.usageAdapter,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.configuration === undefined
      ? {}
      : { configuration: options.configuration }),
  });

  const application: ProductionDisabledApplication = {
    productionEnabled: STAGE_18C_APPLICATION_PRODUCTION_ENABLED,
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
          return runtime.claim(command);
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
      throw new ApplicationError(
        "PRODUCTION_DISABLED",
        "Stage 18C cannot perform live provider, workspace, Git, network, native, credential, or production-registration effects.",
      );
    },
    close: () => runtime.close(),
  };
  return Object.freeze(application);
}

export function createWindowsLocalProductionDisabledApplication(
  options: WindowsLocalApplicationOptions,
): ProductionDisabledApplication {
  if (
    options.usageAdapter === null ||
    typeof options.usageAdapter !== "object" ||
    typeof options.usageAdapter.readAuthorizedSnapshot !== "function"
  ) {
    throw new ApplicationError(
      "INVALID_COMMAND",
      "The usage adapter is invalid.",
    );
  }
  parseRuntimeUsageAdapterBinding({
    adapterId: options.usageAdapter.adapterId,
    schemaVersion: options.usageAdapter.schemaVersion,
  });
  parseWorkerRuntimeConfiguration(
    options.configuration ?? DEFAULT_WORKER_RUNTIME_CONFIGURATION,
  );
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
