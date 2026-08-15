import type { JsonObject } from "@ai-dev-os/domain";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import type { RouteCandidate, WorkloadClass } from "./routing.js";
import type {
  FailureClassification,
  NormalizedUsage,
  OrchestrationTaskEnvelope,
  SchedulerClock,
  SelectedRoute,
} from "./types.js";
import type {
  NormalizedCanonicalUsageSnapshot,
  UsageSnapshotAdapter,
} from "./usage.js";

export const WORKER_WORK_DEFINITION_SCHEMA_VERSION = 1 as const;
export const WORKER_RUNTIME_SCHEMA_VERSION = 2 as const;
export const WORKER_RUNTIME_EVENT_SCHEMA_VERSION = 2 as const;
export const STAGE_18C_PRODUCTION_ENABLED = false as const;

export const WORKER_RUNTIME_STATUSES = Object.freeze([
  "ready",
  "leased",
  "running",
  "retry-wait",
  "completed",
  "failed",
  "cancelled",
] as const);
export type WorkerRuntimeStatus = (typeof WORKER_RUNTIME_STATUSES)[number];

export const WORKER_RUNTIME_EVENT_TYPES = Object.freeze([
  "work.enqueued",
  "lease.acquired",
  "lease.renewed",
  "usage.reserved",
  "dispatch.prepared",
  "dispatch.started",
  "attempt.retry-scheduled",
  "work.ready",
  "work.completed",
  "work.failed",
  "work.cancelled",
  "usage.reconciled",
] as const);
export type WorkerRuntimeEventType =
  (typeof WORKER_RUNTIME_EVENT_TYPES)[number];

export interface CapacityPoolConfiguration {
  readonly poolId: string;
  readonly maximumActive: number;
}

export interface WorkerRuntimeConfiguration {
  readonly maximumQueueDepth: number;
  readonly maximumRetainedWorkItems: number;
  readonly leaseDurationMs: number;
  readonly maximumLeaseRenewalsPerAttempt: number;
  readonly usageReadTimeoutMs: number;
  readonly usageFreshnessMs: number;
  readonly circuitFreshnessMs: number;
  readonly starvationAgingMs: number;
  readonly capacityPools: readonly CapacityPoolConfiguration[];
}

export interface RuntimeUsageAdapterBinding {
  readonly adapterId: string;
  readonly schemaVersion: 1 | 2 | 3;
}

export interface ProviderCircuitEvidence {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly providerId: string;
  readonly profileId: string;
  readonly state: "closed" | "open" | "half-open";
  readonly observedAt: string;
  readonly sourceFingerprint: string;
}

export interface WorkerWorkDefinition {
  readonly schemaVersion: typeof WORKER_WORK_DEFINITION_SCHEMA_VERSION;
  readonly workId: string;
  readonly task: OrchestrationTaskEnvelope;
  readonly candidate: RouteCandidate;
  readonly workloadClass: WorkloadClass;
  readonly capacityPool: string;
  readonly fairnessKey: string;
  readonly readyAt: string;
  readonly estimatedUsage: NormalizedUsage;
}

export interface WorkerLease {
  readonly leaseId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface RuntimeUsageReservation {
  readonly reservationId: string;
  readonly snapshotId: string;
  readonly sourceAdapterVersion: string;
  readonly sourceFingerprint: string;
  readonly observedAt: string;
  readonly fiveHourWindowId: string;
  readonly fiveHourResetAt: string;
  readonly weeklyWindowId: string;
  readonly weeklyResetAt: string;
  readonly usedFiveHourBasisPoints: number;
  readonly usedWeeklyBasisPoints: number;
  readonly predictedFiveHourBasisPoints: number;
  readonly predictedWeeklyBasisPoints: number;
  readonly estimatedUsage: NormalizedUsage;
  readonly circuit: ProviderCircuitEvidence;
  readonly reservedAt: string;
  readonly status:
    "reserved" | "reconciliation-required" | "reconciled" | "released";
  readonly actualUsage: NormalizedUsage | null;
  readonly reconciledAt: string | null;
}

export interface RuntimeDispatchIntent {
  readonly dispatchId: string;
  readonly route: SelectedRoute;
  readonly reservationId: string;
  readonly usageSnapshotId: string;
  readonly circuit: ProviderCircuitEvidence;
  readonly requestFingerprint: string;
  readonly preparedAt: string;
  readonly status: "prepared" | "started" | "terminal";
  readonly startedAt: string | null;
  readonly terminalAt: string | null;
}

export interface WorkerRuntimeTerminal {
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly code: string;
  readonly classification: FailureClassification | null;
  readonly actualUsage: NormalizedUsage;
  readonly finishedAt: string;
}

export interface WorkerRuntimeState {
  readonly schemaVersion: typeof WORKER_RUNTIME_SCHEMA_VERSION;
  readonly configuration: WorkerRuntimeConfiguration;
  readonly usageAdapter: RuntimeUsageAdapterBinding;
  readonly configurationFingerprint: string;
  readonly definition: WorkerWorkDefinition;
  readonly definitionFingerprint: string;
  readonly status: WorkerRuntimeStatus;
  readonly sequence: number;
  readonly lastEventId: string;
  readonly lastOccurredAt: string;
  readonly attempt: number;
  /** Exact usage accumulated across every concluded attempt. */
  readonly cumulativeUsage: NormalizedUsage;
  readonly lastFencingToken: number;
  readonly leaseRenewals: number;
  readonly lease: WorkerLease | null;
  readonly reservation: RuntimeUsageReservation | null;
  readonly latestUsageSnapshot: NormalizedCanonicalUsageSnapshot | null;
  readonly dispatch: RuntimeDispatchIntent | null;
  readonly readySince: string | null;
  readonly nextReadyAt: string | null;
  readonly terminal: WorkerRuntimeTerminal | null;
}

export interface WorkerRuntimeEvent {
  readonly schemaVersion: typeof WORKER_RUNTIME_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly workId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: WorkerRuntimeEventType;
  readonly command: JsonObject;
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly payload: JsonObject;
}

export interface EnqueueWorkCommand {
  readonly type: "enqueue-work";
  readonly commandId: string;
  readonly definition: WorkerWorkDefinition;
}

export interface ClaimWorkCommand {
  readonly type: "claim-work";
  readonly commandId: string;
  readonly workerId: string;
  readonly allowedCapacityPools: readonly string[];
}

export interface FencedWorkCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly fencingToken: number;
}

export interface RenewLeaseCommand extends FencedWorkCommand {
  readonly type: "renew-lease";
}

export interface ReserveUsageCommand extends FencedWorkCommand {
  readonly type: "reserve-usage";
  readonly circuit: ProviderCircuitEvidence;
}

export interface PrepareDispatchCommand extends FencedWorkCommand {
  readonly type: "prepare-dispatch";
  readonly circuit: ProviderCircuitEvidence;
}

export interface MarkDispatchStartedCommand extends FencedWorkCommand {
  readonly type: "mark-dispatch-started";
  readonly dispatchId: string;
}

export interface CompleteWorkCommand extends FencedWorkCommand {
  readonly type: "complete-work";
  readonly dispatchId: string;
  readonly actualUsage: NormalizedUsage;
}

export interface FailWorkCommand extends FencedWorkCommand {
  readonly type: "fail-work";
  readonly dispatchId: string | null;
  readonly classification: FailureClassification;
  readonly code: string;
  readonly retryable: boolean;
  readonly actualUsage: NormalizedUsage;
}

export interface CancelWorkCommand {
  readonly type: "cancel-work";
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly code: string;
}

export interface ReconcileUsageCommand {
  readonly type: "reconcile-usage";
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly reservationId: string;
  readonly dispatchId: string;
  readonly actualUsage: NormalizedUsage;
}

export type WorkerRuntimeCommand =
  | EnqueueWorkCommand
  | ClaimWorkCommand
  | RenewLeaseCommand
  | ReserveUsageCommand
  | PrepareDispatchCommand
  | MarkDispatchStartedCommand
  | CompleteWorkCommand
  | FailWorkCommand
  | CancelWorkCommand
  | ReconcileUsageCommand;

export type WorkerRuntimeFaultPoint = "after-aggregate-before-event";

export interface WorkerRuntimeOptions {
  readonly persistence: PersistenceAdapter;
  readonly usageAdapter: UsageSnapshotAdapter;
  readonly clock?: SchedulerClock;
  readonly configuration?: WorkerRuntimeConfiguration;
  readonly fault?: (point: WorkerRuntimeFaultPoint) => Promise<void> | void;
}

export interface DurableWorkerRuntime {
  enqueue(command: EnqueueWorkCommand): Promise<{
    readonly outcome: "created" | "duplicate";
    readonly state: WorkerRuntimeState;
  }>;
  get(idempotencyKey: string): Promise<WorkerRuntimeState | null>;
  list(): Promise<readonly WorkerRuntimeState[]>;
  history(idempotencyKey: string): Promise<readonly WorkerRuntimeEvent[]>;
  claim(command: ClaimWorkCommand): Promise<WorkerRuntimeState | null>;
  renew(command: RenewLeaseCommand): Promise<WorkerRuntimeState>;
  reserveUsage(command: ReserveUsageCommand): Promise<WorkerRuntimeState>;
  prepareDispatch(command: PrepareDispatchCommand): Promise<WorkerRuntimeState>;
  markDispatchStarted(
    command: MarkDispatchStartedCommand,
  ): Promise<WorkerRuntimeState>;
  complete(command: CompleteWorkCommand): Promise<WorkerRuntimeState>;
  fail(command: FailWorkCommand): Promise<WorkerRuntimeState>;
  cancel(command: CancelWorkCommand): Promise<WorkerRuntimeState>;
  reconcileUsage(command: ReconcileUsageCommand): Promise<WorkerRuntimeState>;
  tick(): Promise<readonly WorkerRuntimeState[]>;
  assertLiveEffectDisabled(effectClass: string): never;
  close(): Promise<void>;
}
