export const TASK_GRAPH_SCHEMA_VERSION = 1 as const;

export const TASK_GRAPH_LIMITS = Object.freeze({
  maxTasks: 10_000,
  maxDependenciesPerTask: 256,
  maxEdges: 100_000,
  maxDepth: 128,
  maxOutputArtifactsPerTask: 1_000,
});

export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting",
  "needs_resolution",
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const GRAPH_STATUSES = [
  "planning",
  "active",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type GraphStatus = (typeof GRAPH_STATUSES)[number];

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface TaskDefinition {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly description?: string;
  readonly dependencies?: readonly string[];
  readonly priority?: number;
  readonly metadata?: JsonObject;
}

export interface TaskFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface TaskNode {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly description: string | null;
  readonly dependencies: readonly string[];
  readonly priority: number;
  readonly metadata: JsonObject;
  readonly status: TaskStatus;
  readonly blockedBy: readonly string[];
  readonly outputArtifactIds: readonly string[];
  readonly failure: TaskFailure | null;
  readonly order: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskGraphSnapshot {
  readonly schemaVersion: typeof TASK_GRAPH_SCHEMA_VERSION;
  readonly graphId: string;
  readonly projectId: string;
  readonly version: number;
  readonly eventSequence: number;
  readonly sealed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tasks: readonly TaskNode[];
}

export interface TaskGraphCreateInput {
  readonly graphId: string;
  readonly projectId: string;
}

export interface TaskGraphRuntimeOptions {
  readonly clock?: () => Date;
}

export interface VersionedMutationOptions {
  readonly expectedVersion?: number;
}

export interface MutationOptions extends VersionedMutationOptions {
  readonly reason?: string;
}

export interface SucceedTaskOptions extends MutationOptions {
  readonly outputArtifactIds?: readonly string[];
}

export interface ReadyTaskQuery {
  readonly limit?: number;
}

interface TaskGraphEventBase {
  readonly graphId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly aggregateVersion: number;
  readonly eventIndex: number;
  readonly eventCount: number;
  readonly occurredAt: string;
}

export type TaskGraphEvent =
  | (TaskGraphEventBase & {
      readonly type: "task.added";
      readonly task: TaskNode;
    })
  | (TaskGraphEventBase & {
      readonly type: "dependency.added";
      readonly taskId: string;
      readonly dependencyId: string;
    })
  | (TaskGraphEventBase & {
      readonly type: "graph.sealed";
      readonly taskCount: number;
    })
  | (TaskGraphEventBase & {
      readonly type: "task.status_changed";
      readonly taskId: string;
      readonly from: TaskStatus;
      readonly to: TaskStatus;
      readonly reason: string | null;
      readonly task: TaskNode;
    })
  | (TaskGraphEventBase & {
      readonly type: "graph.status_changed";
      readonly from: GraphStatus;
      readonly to: GraphStatus;
    });
