import { TaskGraphError, type TaskGraphErrorCode } from "./errors.js";
import {
  TASK_GRAPH_SCHEMA_VERSION,
  TASK_GRAPH_LIMITS,
  TASK_STATUSES,
  type GraphStatus,
  type JsonObject,
  type MutationOptions,
  type ReadyTaskQuery,
  type SucceedTaskOptions,
  type TaskDefinition,
  type TaskFailure,
  type TaskGraphCreateInput,
  type TaskGraphEvent,
  type TaskGraphRuntimeOptions,
  type TaskGraphSnapshot,
  type TaskNode,
  type TaskStatus,
  type VersionedMutationOptions,
} from "./types.js";
import {
  assertBoolean,
  assertCanonicalTimestamp,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertKind,
  cloneAndFreezeFailure,
  cloneAndFreezeJsonObject,
  cloneAndFreezeTask,
  copyDenseDataArray,
  copyPlainDataRecord,
  normalizeOptionalText,
  normalizeRequiredText,
  parseFailure,
  readClock,
} from "./validation.js";

const MAX_TASKS = TASK_GRAPH_LIMITS.maxTasks;
const MIN_PRIORITY = -1_000;
const MAX_PRIORITY = 1_000;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

const TASK_STATUS_SET = new Set<string>(TASK_STATUSES);
const TERMINAL_STATUSES = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
]);
const UNSUCCESSFUL_TERMINAL_STATUSES = new Set<TaskStatus>([
  "failed",
  "cancelled",
  "blocked",
]);

interface MutableTask {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  dependencies: string[];
  priority: number;
  metadata: JsonObject;
  status: TaskStatus;
  blockedBy: string[];
  outputArtifactIds: string[];
  failure: TaskFailure | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

type PendingEvent =
  | { readonly type: "task.added"; readonly task: TaskNode }
  | {
      readonly type: "dependency.added";
      readonly taskId: string;
      readonly dependencyId: string;
    }
  | {
      readonly type: "graph.sealed";
      readonly taskCount: number;
    }
  | {
      readonly type: "task.status_changed";
      readonly taskId: string;
      readonly from: TaskStatus;
      readonly to: TaskStatus;
      readonly reason: string | null;
      readonly task: TaskNode;
    }
  | {
      readonly type: "graph.status_changed";
      readonly from: GraphStatus;
      readonly to: GraphStatus;
    };

const defaultClock = (): Date => new Date();

export class TaskGraph {
  readonly #graphId: string;
  readonly #projectId: string;
  readonly #clock: () => Date;
  readonly #tasks: Map<string, MutableTask>;
  #version: number;
  #eventSequence: number;
  #sealed: boolean;
  #createdAt: string;
  #updatedAt: string;
  #events: TaskGraphEvent[] = [];
  #nextOrder: number;
  #clockActive = false;

  private constructor(
    snapshot: TaskGraphSnapshot,
    tasks: Map<string, MutableTask>,
    clock: () => Date,
  ) {
    this.#graphId = snapshot.graphId;
    this.#projectId = snapshot.projectId;
    this.#version = snapshot.version;
    this.#eventSequence = snapshot.eventSequence;
    this.#sealed = snapshot.sealed;
    this.#createdAt = snapshot.createdAt;
    this.#updatedAt = snapshot.updatedAt;
    this.#tasks = tasks;
    this.#clock = clock;
    this.#nextOrder =
      tasks.size === 0
        ? 0
        : Math.max(...Array.from(tasks.values(), (task) => task.order)) + 1;
  }

  static create(
    input: TaskGraphCreateInput,
    options: TaskGraphRuntimeOptions = {},
  ): TaskGraph {
    const record = copyPlainDataRecord(input, "Graph input", "INVALID_ARGUMENT");
    assertExactKeys(record, ["graphId", "projectId"], "Graph input", "INVALID_ARGUMENT");

    const clock = resolveClock(options);
    const timestamp = readClock(clock);
    const graphId = assertIdentifier(record["graphId"], "Graph ID");
    const projectId = assertIdentifier(record["projectId"], "Project ID");
    const snapshot: TaskGraphSnapshot = {
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      graphId,
      projectId,
      version: 0,
      eventSequence: 0,
      sealed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      tasks: [],
    };

    return new TaskGraph(snapshot, new Map(), clock);
  }

  static hydrate(
    value: unknown,
    options: TaskGraphRuntimeOptions = {},
  ): TaskGraph {
    const { snapshot, tasks } = parseSnapshot(value);
    return new TaskGraph(snapshot, tasks, resolveClock(options));
  }

  get graphId(): string {
    return this.#graphId;
  }

  get projectId(): string {
    return this.#projectId;
  }

  get version(): number {
    return this.#version;
  }

  get eventSequence(): number {
    return this.#eventSequence;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  get status(): GraphStatus {
    return this.#calculateGraphStatus();
  }

  get size(): number {
    return this.#tasks.size;
  }

  hasTask(taskId: string): boolean {
    return this.#tasks.has(assertIdentifier(taskId, "Task ID"));
  }

  getTask(taskId: string): TaskNode {
    return cloneAndFreezeTask(this.#requireTask(taskId));
  }

  listTasks(): readonly TaskNode[] {
    return Object.freeze(
      this.#orderedTasks().map((task) => cloneAndFreezeTask(task)),
    );
  }

  getReadyTasks(query: ReadyTaskQuery = {}): readonly TaskNode[] {
    const { limit } = parseReadyTaskQuery(query);

    const ready = this.#orderedTasks()
      .filter((task) => task.status === "ready")
      .sort((left, right) => right.priority - left.priority || left.order - right.order)
      .slice(0, limit)
      .map((task) => cloneAndFreezeTask(task));

    return Object.freeze(ready);
  }

  getTopologicalTasks(): readonly TaskNode[] {
    const ids = topologicalTaskIds(
      this.#tasks,
      "CYCLIC_DEPENDENCY",
      "GRAPH_LIMIT_EXCEEDED",
    );
    return Object.freeze(ids.map((id) => cloneAndFreezeTask(this.#tasks.get(id)!)));
  }

  addTask(
    definition: TaskDefinition,
    options: VersionedMutationOptions = {},
  ): TaskNode {
    const [task] = this.addTasks([definition], options);
    return task!;
  }

  addTasks(
    definitions: readonly TaskDefinition[],
    options: VersionedMutationOptions = {},
  ): readonly TaskNode[] {
    this.#assertNotReentrantMutation();
    this.#assertPlanning();
    const parsedOptions = parseVersionedOptions(options);
    this.#assertExpectedVersion(parsedOptions.expectedVersion);

    const definitionValues = copyDenseDataArray(
      definitions,
      "Task definitions",
      MAX_TASKS,
      "INVALID_ARGUMENT",
    );
    if (definitionValues.length === 0) {
      throw new TaskGraphError(
        "INVALID_ARGUMENT",
        "At least one task definition is required.",
      );
    }
    if (this.#tasks.size + definitionValues.length > MAX_TASKS) {
      throw new TaskGraphError(
        "GRAPH_LIMIT_EXCEEDED",
        "The graph task limit would be exceeded.",
        { maximum: MAX_TASKS },
      );
    }

    const timestamp = this.#readTimestamp();
    const parsed: MutableTask[] = [];
    const candidateIds = new Set(this.#tasks.keys());

    for (let index = 0; index < definitionValues.length; index += 1) {
      const task = parseTaskDefinition(
        definitionValues[index] as TaskDefinition,
        this.#nextOrder + index,
        timestamp,
      );
      if (candidateIds.has(task.id)) {
        throw new TaskGraphError("DUPLICATE_TASK", `Task '${task.id}' already exists.`, {
          taskId: task.id,
        });
      }
      candidateIds.add(task.id);
      parsed.push(task);
    }

    for (const task of parsed) {
      for (const dependencyId of task.dependencies) {
        if (!candidateIds.has(dependencyId)) {
          throw new TaskGraphError(
            "UNKNOWN_TASK",
            `Dependency '${dependencyId}' for task '${task.id}' does not exist.`,
            { taskId: task.id, dependencyId },
          );
        }
      }
    }

    const candidate = new Map(this.#tasks);
    for (const task of parsed) {
      candidate.set(task.id, task);
    }
    assertGraphEdgeLimit(candidate, "GRAPH_LIMIT_EXCEEDED");
    topologicalTaskIds(candidate, "CYCLIC_DEPENDENCY", "GRAPH_LIMIT_EXCEEDED");

    const previousStatus = this.status;
    const pendingEvents: PendingEvent[] = [];
    for (const task of parsed) {
      this.#tasks.set(task.id, task);
      pendingEvents.push({ type: "task.added", task: cloneAndFreezeTask(task) });
    }
    this.#nextOrder += parsed.length;
    this.#commit(timestamp, previousStatus, pendingEvents);

    return Object.freeze(parsed.map((task) => cloneAndFreezeTask(task)));
  }

  addDependency(
    taskId: string,
    dependencyId: string,
    options: VersionedMutationOptions = {},
  ): void {
    this.#assertNotReentrantMutation();
    this.#assertPlanning();
    const parsedOptions = parseVersionedOptions(options);
    this.#assertExpectedVersion(parsedOptions.expectedVersion);
    const task = this.#requireTask(taskId);
    this.#requireTask(dependencyId);

    if (task.id === dependencyId) {
      throw new TaskGraphError(
        "CYCLIC_DEPENDENCY",
        `Task '${task.id}' cannot depend on itself.`,
        { taskId: task.id },
      );
    }
    if (task.dependencies.includes(dependencyId)) {
      throw new TaskGraphError(
        "INVALID_ARGUMENT",
        `Task '${task.id}' already depends on '${dependencyId}'.`,
        { taskId: task.id, dependencyId },
      );
    }
    if (task.dependencies.length >= TASK_GRAPH_LIMITS.maxDependenciesPerTask) {
      throw new TaskGraphError(
        "GRAPH_LIMIT_EXCEEDED",
        `Task '${task.id}' has reached the dependency limit.`,
        { taskId: task.id, maximum: TASK_GRAPH_LIMITS.maxDependenciesPerTask },
      );
    }

    const candidate = new Map(this.#tasks);
    candidate.set(task.id, { ...task, dependencies: [...task.dependencies, dependencyId] });
    assertGraphEdgeLimit(candidate, "GRAPH_LIMIT_EXCEEDED");
    topologicalTaskIds(candidate, "CYCLIC_DEPENDENCY", "GRAPH_LIMIT_EXCEEDED");

    const timestamp = this.#readTimestamp();
    const previousStatus = this.status;
    task.dependencies.push(dependencyId);
    task.updatedAt = timestamp;
    this.#commit(timestamp, previousStatus, [
      { type: "dependency.added", taskId: task.id, dependencyId },
    ]);
  }

  seal(options: VersionedMutationOptions = {}): void {
    this.#assertNotReentrantMutation();
    this.#assertPlanning();
    const parsedOptions = parseVersionedOptions(options);
    this.#assertExpectedVersion(parsedOptions.expectedVersion);
    if (this.#tasks.size === 0) {
      throw new TaskGraphError("EMPTY_GRAPH", "An empty task graph cannot be sealed.");
    }

    const timestamp = this.#readTimestamp();
    const previousStatus = this.status;
    const pendingEvents: PendingEvent[] = [
      { type: "graph.sealed", taskCount: this.#tasks.size },
    ];
    this.#sealed = true;
    this.#reconcilePendingTasks(timestamp, pendingEvents);
    this.#commit(timestamp, previousStatus, pendingEvents);
  }

  startTask(taskId: string, options: MutationOptions = {}): TaskNode {
    return this.#performTransition(taskId, ["ready"], "running", options);
  }

  markTaskWaiting(taskId: string, options: MutationOptions = {}): TaskNode {
    return this.#performTransition(taskId, ["running"], "waiting", options);
  }

  markTaskNeedsResolution(
    taskId: string,
    options: MutationOptions = {},
  ): TaskNode {
    return this.#performTransition(taskId, ["running"], "needs_resolution", options);
  }

  resumeTask(taskId: string, options: MutationOptions = {}): TaskNode {
    return this.#performTransition(
      taskId,
      ["waiting", "needs_resolution"],
      "running",
      options,
    );
  }

  succeedTask(taskId: string, options: SucceedTaskOptions = {}): TaskNode {
    this.#assertNotReentrantMutation();
    this.#assertExecution();
    const parsedOptions = parseSucceedTaskOptions(options);
    this.#assertExpectedVersion(parsedOptions.expectedVersion);
    const task = this.#requireTask(taskId);
    this.#assertTransition(task, ["running"], "succeeded");
    const outputArtifactIds = parseUniqueIdentifiers(
      parsedOptions.outputArtifactIds,
      "Output artifact ID",
      "INVALID_ARGUMENT",
      TASK_GRAPH_LIMITS.maxOutputArtifactsPerTask,
    );
    const reason = parsedOptions.reason;
    const timestamp = this.#readTimestamp();
    const previousStatus = this.status;
    const pendingEvents: PendingEvent[] = [];

    task.outputArtifactIds = outputArtifactIds;
    task.failure = null;
    task.blockedBy = [];
    this.#setTaskStatus(task, "succeeded", timestamp, reason, pendingEvents);
    this.#reconcilePendingTasks(timestamp, pendingEvents);
    this.#commit(timestamp, previousStatus, pendingEvents);
    return cloneAndFreezeTask(task);
  }

  failTask(
    taskId: string,
    failure: TaskFailure,
    options: MutationOptions = {},
  ): TaskNode {
    this.#assertNotReentrantMutation();
    this.#assertExecution();
    const parsedOptions = parseMutationOptions(options);
    this.#assertExpectedVersion(parsedOptions.expectedVersion);
    const task = this.#requireTask(taskId);
    this.#assertTransition(
      task,
      ["ready", "running", "waiting", "needs_resolution"],
      "failed",
    );
    const parsedFailure = parseFailure(failure, "INVALID_ARGUMENT");
    const explicitReason = parsedOptions.reason;
    const timestamp = this.#readTimestamp();
    const previousStatus = this.status;
    const pendingEvents: PendingEvent[] = [];

    task.failure = parsedFailure;
    task.outputArtifactIds = [];
    task.blockedBy = [];
    this.#setTaskStatus(
      task,
      "failed",
      timestamp,
      explicitReason ?? parsedFailure.message,
      pendingEvents,
    );
    this.#reconcilePendingTasks(timestamp, pendingEvents);
    this.#commit(timestamp, previousStatus, pendingEvents);
    return cloneAndFreezeTask(task);
  }

  cancelTask(taskId: string, options: MutationOptions = {}): TaskNode {
    this.#assertNotReentrantMutation();
    this.#assertExecution();
    const parsedOptions = parseMutationOptions(options);
    this.#assertExpectedVersion(parsedOptions.expectedVersion);
    const task = this.#requireTask(taskId);
    this.#assertTransition(
      task,
      ["pending", "ready", "running", "waiting", "needs_resolution"],
      "cancelled",
    );
    const reason = parsedOptions.reason;
    const timestamp = this.#readTimestamp();
    const previousStatus = this.status;
    const pendingEvents: PendingEvent[] = [];

    task.failure = null;
    task.outputArtifactIds = [];
    task.blockedBy = [];
    this.#setTaskStatus(task, "cancelled", timestamp, reason, pendingEvents);
    this.#reconcilePendingTasks(timestamp, pendingEvents);
    this.#commit(timestamp, previousStatus, pendingEvents);
    return cloneAndFreezeTask(task);
  }

  cancelRemaining(options: MutationOptions = {}): readonly TaskNode[] {
    this.#assertNotReentrantMutation();
    this.#assertExecution();
    const parsedOptions = parseMutationOptions(options);
    this.#assertExpectedVersion(parsedOptions.expectedVersion);
    const cancellable = this.#orderedTasks().filter(
      (task) => !TERMINAL_STATUSES.has(task.status),
    );
    if (cancellable.length === 0) {
      return Object.freeze([]);
    }

    const reason = parsedOptions.reason;
    const timestamp = this.#readTimestamp();
    const previousStatus = this.status;
    const pendingEvents: PendingEvent[] = [];
    for (const task of cancellable) {
      task.failure = null;
      task.outputArtifactIds = [];
      task.blockedBy = [];
      this.#setTaskStatus(task, "cancelled", timestamp, reason, pendingEvents);
    }
    this.#commit(timestamp, previousStatus, pendingEvents);
    return Object.freeze(cancellable.map((task) => cloneAndFreezeTask(task)));
  }

  toSnapshot(): TaskGraphSnapshot {
    return Object.freeze({
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      graphId: this.#graphId,
      projectId: this.#projectId,
      version: this.#version,
      eventSequence: this.#eventSequence,
      sealed: this.#sealed,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      tasks: Object.freeze(
        this.#orderedTasks().map((task) => cloneAndFreezeTask(task)),
      ),
    });
  }

  peekEvents(): readonly TaskGraphEvent[] {
    return Object.freeze([...this.#events]);
  }

  acknowledgeEvents(throughSequence: number): number {
    this.#assertNotReentrantMutation();
    const sequence = assertInteger(
      throughSequence,
      "Acknowledged event sequence",
      0,
      this.#eventSequence,
    );
    const before = this.#events.length;
    this.#events = this.#events.filter((event) => event.sequence > sequence);
    return before - this.#events.length;
  }

  #performTransition(
    taskId: string,
    allowedFrom: readonly TaskStatus[],
    target: TaskStatus,
    options: MutationOptions,
  ): TaskNode {
    this.#assertNotReentrantMutation();
    this.#assertExecution();
    const parsedOptions = parseMutationOptions(options);
    this.#assertExpectedVersion(parsedOptions.expectedVersion);
    const task = this.#requireTask(taskId);
    this.#assertTransition(task, allowedFrom, target);
    const reason = parsedOptions.reason;
    const timestamp = this.#readTimestamp();
    const previousStatus = this.status;
    const pendingEvents: PendingEvent[] = [];
    this.#setTaskStatus(task, target, timestamp, reason, pendingEvents);
    this.#commit(timestamp, previousStatus, pendingEvents);
    return cloneAndFreezeTask(task);
  }

  #setTaskStatus(
    task: MutableTask,
    target: TaskStatus,
    timestamp: string,
    reason: string | null,
    pendingEvents: PendingEvent[],
  ): void {
    const from = task.status;
    task.status = target;
    task.updatedAt = timestamp;
    pendingEvents.push({
      type: "task.status_changed",
      taskId: task.id,
      from,
      to: target,
      reason,
      task: cloneAndFreezeTask(task),
    });
  }

  #reconcilePendingTasks(timestamp: string, pendingEvents: PendingEvent[]): void {
    const topologicalIds = topologicalTaskIds(
      this.#tasks,
      "CYCLIC_DEPENDENCY",
      "GRAPH_LIMIT_EXCEEDED",
    );
    for (const taskId of topologicalIds) {
      const task = this.#tasks.get(taskId)!;
      if (task.status !== "pending") {
        continue;
      }

      const dependencies = task.dependencies.map((id) => this.#tasks.get(id)!);
      const blockedBy = dependencies
        .filter((dependency) =>
          UNSUCCESSFUL_TERMINAL_STATUSES.has(dependency.status),
        )
        .map((dependency) => dependency.id);

      if (blockedBy.length > 0) {
        task.blockedBy = blockedBy;
        this.#setTaskStatus(
          task,
          "blocked",
          timestamp,
          `Blocked by unsuccessful dependencies: ${blockedBy.join(", ")}`,
          pendingEvents,
        );
        continue;
      }

      if (dependencies.every((dependency) => dependency.status === "succeeded")) {
        task.blockedBy = [];
        this.#setTaskStatus(task, "ready", timestamp, null, pendingEvents);
      }
    }
  }

  #commit(
    timestamp: string,
    previousStatus: GraphStatus,
    pendingEvents: PendingEvent[],
  ): void {
    this.#version += 1;
    this.#updatedAt = timestamp;
    const nextStatus = this.status;
    if (previousStatus !== nextStatus) {
      pendingEvents.push({
        type: "graph.status_changed",
        from: previousStatus,
        to: nextStatus,
      });
    }

    const eventCount = pendingEvents.length;
    for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
      const pendingEvent = pendingEvents[eventIndex]!;
      this.#eventSequence += 1;
      const event = Object.freeze({
        graphId: this.#graphId,
        projectId: this.#projectId,
        sequence: this.#eventSequence,
        aggregateVersion: this.#version,
        eventIndex,
        eventCount,
        occurredAt: timestamp,
        ...pendingEvent,
      }) as TaskGraphEvent;
      this.#events.push(event);
    }
  }

  #assertPlanning(): void {
    if (this.#sealed) {
      throw new TaskGraphError("GRAPH_SEALED", "The graph topology is sealed.", {
        graphId: this.#graphId,
      });
    }
  }

  #assertExecution(): void {
    if (!this.#sealed) {
      throw new TaskGraphError(
        "GRAPH_NOT_SEALED",
        "The graph must be sealed before tasks can transition.",
        { graphId: this.#graphId },
      );
    }
  }

  #assertExpectedVersion(expectedVersion: number | undefined): void {
    const maximumEventsForCommand = MAX_TASKS + 3;
    if (
      this.#version >= MAX_SEQUENCE ||
      this.#eventSequence > MAX_SEQUENCE - maximumEventsForCommand
    ) {
      throw new TaskGraphError(
        "INVALID_ARGUMENT",
        "The graph version or event sequence has reached its safe integer limit.",
        { version: this.#version, eventSequence: this.#eventSequence },
      );
    }

    if (expectedVersion === undefined) {
      return;
    }
    assertInteger(expectedVersion, "Expected graph version", 0, MAX_SEQUENCE);
    if (expectedVersion !== this.#version) {
      throw new TaskGraphError(
        "CONCURRENCY_CONFLICT",
        `Expected graph version ${expectedVersion}, but found ${this.#version}.`,
        { expectedVersion, actualVersion: this.#version },
      );
    }
  }

  #assertTransition(
    task: MutableTask,
    allowedFrom: readonly TaskStatus[],
    target: TaskStatus,
  ): void {
    if (!allowedFrom.includes(task.status)) {
      throw new TaskGraphError(
        "INVALID_TRANSITION",
        `Task '${task.id}' cannot transition from '${task.status}' to '${target}'.`,
        { taskId: task.id, from: task.status, to: target },
      );
    }
  }

  #requireTask(taskId: string): MutableTask {
    const validatedId = assertIdentifier(taskId, "Task ID");
    const task = this.#tasks.get(validatedId);
    if (task === undefined) {
      throw new TaskGraphError("UNKNOWN_TASK", `Task '${validatedId}' does not exist.`, {
        taskId: validatedId,
      });
    }
    return task;
  }

  #orderedTasks(): MutableTask[] {
    return Array.from(this.#tasks.values()).sort((left, right) => left.order - right.order);
  }

  #calculateGraphStatus(): GraphStatus {
    if (!this.#sealed) {
      return "planning";
    }

    const tasks = Array.from(this.#tasks.values());
    if (tasks.every((task) => task.status === "succeeded")) {
      return "succeeded";
    }
    if (tasks.some((task) => !TERMINAL_STATUSES.has(task.status))) {
      return "active";
    }
    if (tasks.some((task) => task.status === "failed")) {
      return "failed";
    }
    return "cancelled";
  }

  #readTimestamp(): string {
    this.#assertNotReentrantMutation();
    this.#clockActive = true;
    try {
      const timestamp = readClock(this.#clock);
      if (timestamp < this.#updatedAt) {
        throw new TaskGraphError(
          "INVALID_ARGUMENT",
          "The graph clock moved backwards.",
          { previousTimestamp: this.#updatedAt, timestamp },
        );
      }
      return timestamp;
    } finally {
      this.#clockActive = false;
    }
  }

  #assertNotReentrantMutation(): void {
    if (this.#clockActive) {
      throw new TaskGraphError(
        "REENTRANT_MUTATION",
        "A graph mutation cannot be called from its clock callback.",
      );
    }
  }
}

interface ParsedVersionedOptions {
  readonly expectedVersion: number | undefined;
}

interface ParsedMutationOptions extends ParsedVersionedOptions {
  readonly reason: string | null;
}

interface ParsedSucceedTaskOptions extends ParsedMutationOptions {
  readonly outputArtifactIds: unknown;
}

function parseVersionedOptions(value: unknown): ParsedVersionedOptions {
  const record = copyPlainDataRecord(value, "Versioned mutation options", "INVALID_ARGUMENT");
  assertExactKeys(
    record,
    ["expectedVersion"],
    "Versioned mutation options",
    "INVALID_ARGUMENT",
  );
  return {
    expectedVersion:
      record["expectedVersion"] === undefined
        ? undefined
        : assertInteger(
            record["expectedVersion"],
            "Expected graph version",
            0,
            MAX_SEQUENCE,
          ),
  };
}

function parseMutationOptions(value: unknown): ParsedMutationOptions {
  const record = copyPlainDataRecord(value, "Mutation options", "INVALID_ARGUMENT");
  assertExactKeys(
    record,
    ["expectedVersion", "reason"],
    "Mutation options",
    "INVALID_ARGUMENT",
  );
  return {
    expectedVersion:
      record["expectedVersion"] === undefined
        ? undefined
        : assertInteger(
            record["expectedVersion"],
            "Expected graph version",
            0,
            MAX_SEQUENCE,
          ),
    reason: normalizeOptionalText(record["reason"], "Transition reason", 1_000),
  };
}

function parseSucceedTaskOptions(value: unknown): ParsedSucceedTaskOptions {
  const record = copyPlainDataRecord(value, "Success options", "INVALID_ARGUMENT");
  assertExactKeys(
    record,
    ["expectedVersion", "reason", "outputArtifactIds"],
    "Success options",
    "INVALID_ARGUMENT",
  );
  return {
    expectedVersion:
      record["expectedVersion"] === undefined
        ? undefined
        : assertInteger(
            record["expectedVersion"],
            "Expected graph version",
            0,
            MAX_SEQUENCE,
          ),
    reason: normalizeOptionalText(record["reason"], "Transition reason", 1_000),
    outputArtifactIds:
      record["outputArtifactIds"] === undefined ? [] : record["outputArtifactIds"],
  };
}

function parseReadyTaskQuery(value: unknown): { readonly limit: number } {
  const record = copyPlainDataRecord(value, "Ready task query", "INVALID_ARGUMENT");
  assertExactKeys(record, ["limit"], "Ready task query", "INVALID_ARGUMENT");
  return {
    limit:
      record["limit"] === undefined
        ? MAX_TASKS
        : assertInteger(record["limit"], "Ready task limit", 0, MAX_TASKS),
  };
}

function resolveClock(options: TaskGraphRuntimeOptions): () => Date {
  const record = copyPlainDataRecord(options, "Runtime options", "INVALID_ARGUMENT");
  assertExactKeys(record, ["clock"], "Runtime options", "INVALID_ARGUMENT");
  const clock = record["clock"];
  if (clock !== undefined && typeof clock !== "function") {
    throw new TaskGraphError("INVALID_ARGUMENT", "Runtime clock must be a function.");
  }
  return (clock as (() => Date) | undefined) ?? defaultClock;
}

function parseTaskDefinition(
  value: TaskDefinition,
  order: number,
  timestamp: string,
): MutableTask {
  const record = copyPlainDataRecord(value, "Task definition", "INVALID_ARGUMENT");
  assertExactKeys(
    record,
    ["id", "kind", "title", "description", "dependencies", "priority", "metadata"],
    "Task definition",
    "INVALID_ARGUMENT",
  );

  const id = assertIdentifier(record["id"], "Task ID");
  const dependencies = parseUniqueIdentifiers(
    record["dependencies"] === undefined ? [] : record["dependencies"],
    "Dependency ID",
    "INVALID_ARGUMENT",
    TASK_GRAPH_LIMITS.maxDependenciesPerTask,
  );
  if (dependencies.includes(id)) {
    throw new TaskGraphError(
      "CYCLIC_DEPENDENCY",
      `Task '${id}' cannot depend on itself.`,
      { taskId: id },
    );
  }

  return {
    id,
    kind: assertKind(record["kind"]),
    title: normalizeRequiredText(record["title"], "Task title", 300),
    description: normalizeOptionalText(record["description"], "Task description", 10_000),
    dependencies,
    priority:
      record["priority"] === undefined
        ? 0
        : assertInteger(record["priority"], "Task priority", MIN_PRIORITY, MAX_PRIORITY),
    metadata: cloneAndFreezeJsonObject(
      record["metadata"] === undefined ? {} : record["metadata"],
      "Task metadata",
    ),
    status: "pending",
    blockedBy: [],
    outputArtifactIds: [],
    failure: null,
    order,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function parseSnapshot(value: unknown): {
  snapshot: TaskGraphSnapshot;
  tasks: Map<string, MutableTask>;
} {
  const code = "INVALID_SNAPSHOT" as const;
  const record = copyPlainDataRecord(value, "Task graph snapshot", code);
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "graphId",
      "projectId",
      "version",
      "eventSequence",
      "sealed",
      "createdAt",
      "updatedAt",
      "tasks",
    ],
    "Task graph snapshot",
    code,
  );

  if (record["schemaVersion"] !== TASK_GRAPH_SCHEMA_VERSION) {
    throw new TaskGraphError(code, "Unsupported task graph snapshot schema version.", {
      expected: TASK_GRAPH_SCHEMA_VERSION,
      actual: record["schemaVersion"],
    });
  }

  const graphId = assertIdentifier(record["graphId"], "Graph ID", code);
  const projectId = assertIdentifier(record["projectId"], "Project ID", code);
  const version = assertInteger(record["version"], "Graph version", 0, MAX_SEQUENCE, code);
  const eventSequence = assertInteger(
    record["eventSequence"],
    "Graph event sequence",
    0,
    MAX_SEQUENCE,
    code,
  );
  const sealed = assertBoolean(record["sealed"], "Graph sealed", code);
  const createdAt = assertCanonicalTimestamp(record["createdAt"], "Graph createdAt", code);
  const updatedAt = assertCanonicalTimestamp(record["updatedAt"], "Graph updatedAt", code);
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw new TaskGraphError(code, "Graph createdAt cannot be after updatedAt.");
  }
  const taskValues = copyDenseDataArray(record["tasks"], "Snapshot tasks", MAX_TASKS, code);
  const parsedTasks: MutableTask[] = [];
  for (let index = 0; index < taskValues.length; index += 1) {
    parsedTasks.push(parseSnapshotTask(taskValues[index]));
  }
  parsedTasks.sort((left, right) => left.order - right.order);
  for (let index = 0; index < parsedTasks.length; index += 1) {
    if (parsedTasks[index]!.order !== index) {
      throw new TaskGraphError(code, "Snapshot task order must be contiguous from zero.", {
        index,
        order: parsedTasks[index]!.order,
      });
    }
  }
  const tasks = new Map<string, MutableTask>();
  for (const task of parsedTasks) {
    if (tasks.has(task.id)) {
      throw new TaskGraphError(code, `Snapshot contains duplicate task '${task.id}'.`, {
        taskId: task.id,
      });
    }
    if (
      Date.parse(task.createdAt) < Date.parse(createdAt) ||
      Date.parse(task.updatedAt) > Date.parse(updatedAt)
    ) {
      throw new TaskGraphError(code, `Task '${task.id}' timestamps exceed graph bounds.`, {
        taskId: task.id,
      });
    }
    tasks.set(task.id, task);
  }

  if (eventSequence < version) {
    throw new TaskGraphError(
      code,
      "Graph event sequence cannot be lower than its aggregate version.",
      { version, eventSequence },
    );
  }
  if (tasks.size === 0 && (version !== 0 || eventSequence !== 0 || sealed)) {
    throw new TaskGraphError(code, "An empty graph must be an initial planning snapshot.");
  }
  if (tasks.size > 0 && version === 0) {
    throw new TaskGraphError(code, "A non-empty graph must have a positive version.");
  }
  if (sealed && version < 2) {
    throw new TaskGraphError(code, "A sealed graph must include planning and seal versions.");
  }
  const maximumTaskUpdatedAt = parsedTasks.reduce(
    (maximum, task) =>
      Date.parse(task.updatedAt) > Date.parse(maximum) ? task.updatedAt : maximum,
    createdAt,
  );
  if (maximumTaskUpdatedAt !== updatedAt) {
    throw new TaskGraphError(
      code,
      "Graph updatedAt must equal the latest task update timestamp.",
      { updatedAt, maximumTaskUpdatedAt },
    );
  }
  for (const task of tasks.values()) {
    for (const dependencyId of task.dependencies) {
      if (!tasks.has(dependencyId)) {
        throw new TaskGraphError(
          code,
          `Task '${task.id}' references missing dependency '${dependencyId}'.`,
          { taskId: task.id, dependencyId },
        );
      }
    }
  }
  assertGraphEdgeLimit(tasks, code);
  topologicalTaskIds(tasks, code, code);
  validateHydratedTaskStates(tasks, sealed);

  const snapshot: TaskGraphSnapshot = Object.freeze({
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    graphId,
    projectId,
    version,
    eventSequence,
    sealed,
    createdAt,
    updatedAt,
    tasks: Object.freeze(parsedTasks.map((task) => cloneAndFreezeTask(task))),
  });
  return { snapshot, tasks };
}

function parseSnapshotTask(value: unknown): MutableTask {
  const code = "INVALID_SNAPSHOT" as const;
  const record = copyPlainDataRecord(value, "Snapshot task", code);
  assertExactKeys(
    record,
    [
      "id",
      "kind",
      "title",
      "description",
      "dependencies",
      "priority",
      "metadata",
      "status",
      "blockedBy",
      "outputArtifactIds",
      "failure",
      "order",
      "createdAt",
      "updatedAt",
    ],
    "Snapshot task",
    code,
  );

  const statusValue = record["status"];
  if (typeof statusValue !== "string" || !TASK_STATUS_SET.has(statusValue)) {
    throw new TaskGraphError(code, "Snapshot task has an invalid status.", {
      value: statusValue,
    });
  }
  const status = statusValue as TaskStatus;
  const createdAt = assertCanonicalTimestamp(record["createdAt"], "Task createdAt", code);
  const updatedAt = assertCanonicalTimestamp(record["updatedAt"], "Task updatedAt", code);
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw new TaskGraphError(code, "Task createdAt cannot be after updatedAt.");
  }

  return {
    id: assertIdentifier(record["id"], "Task ID", code),
    kind: assertKind(record["kind"], code),
    title: normalizeRequiredText(record["title"], "Task title", 300, code),
    description: normalizeOptionalText(record["description"], "Task description", 10_000, code),
    dependencies: parseUniqueIdentifiers(
      record["dependencies"],
      "Dependency ID",
      code,
      TASK_GRAPH_LIMITS.maxDependenciesPerTask,
    ),
    priority: assertInteger(
      record["priority"],
      "Task priority",
      MIN_PRIORITY,
      MAX_PRIORITY,
      code,
    ),
    metadata: cloneAndFreezeJsonObject(record["metadata"], "Task metadata", code),
    status,
    blockedBy: parseUniqueIdentifiers(
      record["blockedBy"],
      "Blocked-by task ID",
      code,
      TASK_GRAPH_LIMITS.maxDependenciesPerTask,
    ),
    outputArtifactIds: parseUniqueIdentifiers(
      record["outputArtifactIds"],
      "Output artifact ID",
      code,
      TASK_GRAPH_LIMITS.maxOutputArtifactsPerTask,
    ),
    failure: record["failure"] === null ? null : parseFailure(record["failure"], code),
    order: assertInteger(record["order"], "Task order", 0, MAX_TASKS - 1, code),
    createdAt,
    updatedAt,
  };
}

function validateHydratedTaskStates(
  tasks: Map<string, MutableTask>,
  sealed: boolean,
): void {
  const code = "INVALID_SNAPSHOT" as const;
  for (const task of tasks.values()) {
    if (!sealed) {
      if (
        task.status !== "pending" ||
        task.blockedBy.length > 0 ||
        task.outputArtifactIds.length > 0 ||
        task.failure !== null
      ) {
        throw new TaskGraphError(
          code,
          `Unsealed task '${task.id}' must be pending without outcome data.`,
          { taskId: task.id },
        );
      }
      continue;
    }

    const dependencies = task.dependencies.map((id) => tasks.get(id)!);
    const unsuccessful = dependencies
      .filter((dependency) => UNSUCCESSFUL_TERMINAL_STATUSES.has(dependency.status))
      .map((dependency) => dependency.id);
    const allSucceeded = dependencies.every(
      (dependency) => dependency.status === "succeeded",
    );

    if (task.status === "pending" && (allSucceeded || unsuccessful.length > 0)) {
      throw new TaskGraphError(code, `Pending task '${task.id}' is not reconciled.`, {
        taskId: task.id,
      });
    }
    if (
      ["ready", "running", "waiting", "needs_resolution", "succeeded", "failed"].includes(
        task.status,
      ) &&
      !allSucceeded
    ) {
      throw new TaskGraphError(
        code,
        `Task '${task.id}' cannot be '${task.status}' before all dependencies succeed.`,
        { taskId: task.id, status: task.status },
      );
    }
    if (task.status === "blocked") {
      const unsuccessfulIds = new Set(unsuccessful);
      if (
        task.blockedBy.length === 0 ||
        task.blockedBy.some((taskId) => !unsuccessfulIds.has(taskId))
      ) {
        throw new TaskGraphError(code, `Blocked task '${task.id}' has invalid blockers.`, {
          taskId: task.id,
        });
      }
    } else if (task.blockedBy.length > 0) {
      throw new TaskGraphError(code, `Task '${task.id}' has blockers but is not blocked.`, {
        taskId: task.id,
      });
    }

    if ((task.status === "failed") !== (task.failure !== null)) {
      throw new TaskGraphError(code, `Task '${task.id}' has inconsistent failure data.`, {
        taskId: task.id,
      });
    }
    if (task.status !== "succeeded" && task.outputArtifactIds.length > 0) {
      throw new TaskGraphError(
        code,
        `Only succeeded task '${task.id}' may contain output artifacts.`,
        { taskId: task.id },
      );
    }
  }
}

function parseUniqueIdentifiers(
  value: unknown,
  label: string,
  code: TaskGraphErrorCode,
  maximumLength: number,
): string[] {
  const items = copyDenseDataArray(
    value,
    `${label} list`,
    maximumLength,
    code,
  );
  const result: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    result.push(assertIdentifier(items[index], label, code));
  }
  if (new Set(result).size !== result.length) {
    throw new TaskGraphError(code, `${label} list cannot contain duplicates.`);
  }
  return result;
}

function topologicalTaskIds(
  tasks: Map<string, MutableTask>,
  cycleErrorCode: TaskGraphErrorCode,
  limitErrorCode: TaskGraphErrorCode,
): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, MutableTask[]>();
  const depths = new Map<string, number>();
  for (const task of tasks.values()) {
    indegree.set(task.id, task.dependencies.length);
    for (const dependencyId of task.dependencies) {
      const list = dependents.get(dependencyId) ?? [];
      list.push(task);
      dependents.set(dependencyId, list);
    }
  }

  const queue = new TaskOrderMinHeap();
  for (const task of tasks.values()) {
    if (indegree.get(task.id) === 0) {
      depths.set(task.id, 1);
      queue.push(task);
    }
  }

  const ordered: string[] = [];
  while (queue.size > 0) {
    const task = queue.pop()!;
    ordered.push(task.id);
    for (const dependent of dependents.get(task.id) ?? []) {
      const depth = (depths.get(task.id) ?? 1) + 1;
      const previousDepth = depths.get(dependent.id) ?? 1;
      if (depth > previousDepth) {
        depths.set(dependent.id, depth);
      }
      if (depth > TASK_GRAPH_LIMITS.maxDepth) {
        throw new TaskGraphError(
          limitErrorCode,
          "Task graph depth limit would be exceeded.",
          { maximum: TASK_GRAPH_LIMITS.maxDepth, taskId: dependent.id },
        );
      }
      const remaining = indegree.get(dependent.id)! - 1;
      indegree.set(dependent.id, remaining);
      if (remaining === 0) {
        queue.push(dependent);
      }
    }
  }

  if (ordered.length !== tasks.size) {
    const cyclicTaskIds = Array.from(indegree.entries())
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id)
      .sort();
    throw new TaskGraphError(
      cycleErrorCode,
      "Task dependencies contain a cycle.",
      { taskIds: cyclicTaskIds },
    );
  }

  return ordered;
}

function assertGraphEdgeLimit(
  tasks: Map<string, MutableTask>,
  errorCode: TaskGraphErrorCode,
): void {
  let edgeCount = 0;
  for (const task of tasks.values()) {
    edgeCount += task.dependencies.length;
    if (edgeCount > TASK_GRAPH_LIMITS.maxEdges) {
      throw new TaskGraphError(errorCode, "Task graph edge limit would be exceeded.", {
        maximum: TASK_GRAPH_LIMITS.maxEdges,
      });
    }
  }
}

class TaskOrderMinHeap {
  readonly #items: MutableTask[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(task: MutableTask): void {
    this.#items.push(task);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#items[parent]!.order <= task.order) {
        break;
      }
      this.#items[index] = this.#items[parent]!;
      index = parent;
    }
    this.#items[index] = task;
  }

  pop(): MutableTask | undefined {
    const root = this.#items[0];
    const last = this.#items.pop();
    if (root === undefined || last === undefined || this.#items.length === 0) {
      return root;
    }

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.#items.length) {
        break;
      }
      let child = left;
      if (
        right < this.#items.length &&
        this.#items[right]!.order < this.#items[left]!.order
      ) {
        child = right;
      }
      if (this.#items[child]!.order >= last.order) {
        break;
      }
      this.#items[index] = this.#items[child]!;
      index = child;
    }
    this.#items[index] = last;
    return root;
  }
}
