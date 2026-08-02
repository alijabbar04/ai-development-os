import { describe, expect, it } from "vitest";
import {
  TaskGraph,
  TaskGraphError,
  type TaskGraphErrorCode,
  type TaskGraphSnapshot,
} from "../src/index.js";

const BASE_TIME = Date.parse("2026-08-02T12:00:00.000Z");

function sequentialClock(): () => Date {
  let offset = 0;
  return () => new Date(BASE_TIME + offset++);
}

function createGraph(): TaskGraph {
  return TaskGraph.create(
    { graphId: "graph:test", projectId: "project:test" },
    { clock: sequentialClock() },
  );
}

function expectGraphError(action: () => unknown, code: TaskGraphErrorCode): void {
  try {
    action();
    throw new Error(`Expected TaskGraphError with code ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(TaskGraphError);
    expect((error as TaskGraphError).code).toBe(code);
  }
}

function cloneSnapshot(snapshot: TaskGraphSnapshot): Record<string, any> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, any>;
}

function acknowledgeAll(graph: TaskGraph): void {
  const lastSequence = graph.peekEvents().at(-1)?.sequence;
  if (lastSequence !== undefined) {
    graph.acknowledgeEvents(lastSequence);
  }
}

describe("TaskGraph planning", () => {
  it("creates an empty, unsealed, version-zero aggregate", () => {
    const graph = createGraph();

    expect(graph.graphId).toBe("graph:test");
    expect(graph.projectId).toBe("project:test");
    expect(graph.status).toBe("planning");
    expect(graph.version).toBe(0);
    expect(graph.eventSequence).toBe(0);
    expect(graph.size).toBe(0);
    expect(graph.peekEvents()).toEqual([]);
  });

  it("rejects invalid aggregate identifiers and invalid clocks", () => {
    expectGraphError(
      () => TaskGraph.create({ graphId: " bad ", projectId: "project:test" }),
      "INVALID_ARGUMENT",
    );
    expectGraphError(
      () =>
        TaskGraph.create(
          { graphId: "graph:test", projectId: "project:test" },
          { clock: () => new Date(Number.NaN) },
        ),
      "INVALID_ARGUMENT",
    );
  });

  it("rejects a clock that moves backwards without mutating state", () => {
    const timestamps = [new Date(BASE_TIME + 1), new Date(BASE_TIME)];
    const graph = TaskGraph.create(
      { graphId: "graph:test", projectId: "project:test" },
      { clock: () => timestamps.shift()! },
    );
    const before = graph.toSnapshot();

    expectGraphError(
      () => graph.addTask({ id: "root", kind: "plan", title: "Root" }),
      "INVALID_ARGUMENT",
    );

    expect(graph.toSnapshot()).toEqual(before);
    expect(graph.peekEvents()).toEqual([]);
  });

  it("adds a forward-referencing batch atomically", () => {
    const graph = createGraph();

    const added = graph.addTasks([
      {
        id: "review",
        kind: "review",
        title: "Review output",
        dependencies: ["implement"],
      },
      { id: "plan", kind: "plan", title: "Plan work" },
      {
        id: "implement",
        kind: "implement",
        title: "Implement work",
        dependencies: ["plan"],
      },
    ]);

    expect(added.map((task) => task.id)).toEqual(["review", "plan", "implement"]);
    expect(graph.getTopologicalTasks().map((task) => task.id)).toEqual([
      "plan",
      "implement",
      "review",
    ]);
    expect(graph.version).toBe(1);
    expect(graph.peekEvents()).toHaveLength(3);
    expect(graph.peekEvents().every((event) => event.aggregateVersion === 1)).toBe(true);
  });

  it("does not partially add a batch containing a duplicate", () => {
    const graph = createGraph();
    graph.addTask({ id: "existing", kind: "plan", title: "Existing" });
    acknowledgeAll(graph);
    const before = graph.toSnapshot();

    expectGraphError(
      () =>
        graph.addTasks([
          { id: "new", kind: "test", title: "New" },
          { id: "existing", kind: "test", title: "Duplicate" },
        ]),
      "DUPLICATE_TASK",
    );

    expect(graph.toSnapshot()).toEqual(before);
    expect(graph.peekEvents()).toEqual([]);
  });

  it("rejects hostile and sparse task-definition arrays without invoking instance methods", () => {
    const graph = createGraph();
    const hostile = [
      { id: "root", kind: "plan", title: "Root" },
    ] as Array<Record<string, unknown>> & { map?: () => unknown };
    hostile.map = () => [{ id: "bypass", kind: "plan", title: "Bypass" }];

    expectGraphError(() => graph.addTasks(hostile as never), "INVALID_ARGUMENT");
    expectGraphError(
      () => graph.addTasks(new Array(1) as never),
      "INVALID_ARGUMENT",
    );
    expect(graph.size).toBe(0);
  });

  it("does not partially add a batch with an unknown dependency", () => {
    const graph = createGraph();
    const before = graph.toSnapshot();

    expectGraphError(
      () =>
        graph.addTasks([
          {
            id: "implementation",
            kind: "implement",
            title: "Implementation",
            dependencies: ["missing"],
          },
        ]),
      "UNKNOWN_TASK",
    );

    expect(graph.toSnapshot()).toEqual(before);
    expect(graph.peekEvents()).toEqual([]);
  });

  it("does not treat null collection fields as omitted", () => {
    const graph = createGraph();

    expectGraphError(
      () =>
        graph.addTask({
          id: "null-dependencies",
          kind: "plan",
          title: "Null dependencies",
          dependencies: null,
        } as never),
      "INVALID_ARGUMENT",
    );
    expectGraphError(
      () =>
        graph.addTask({
          id: "null-metadata",
          kind: "plan",
          title: "Null metadata",
          metadata: null,
        } as never),
      "INVALID_ARGUMENT",
    );
    expect(graph.size).toBe(0);
  });

  it("rejects self-dependencies and cyclic batch plans", () => {
    const graph = createGraph();

    expectGraphError(
      () =>
        graph.addTask({
          id: "self",
          kind: "plan",
          title: "Self",
          dependencies: ["self"],
        }),
      "CYCLIC_DEPENDENCY",
    );
    expectGraphError(
      () =>
        graph.addTasks([
          { id: "a", kind: "plan", title: "A", dependencies: ["b"] },
          { id: "b", kind: "plan", title: "B", dependencies: ["a"] },
        ]),
      "CYCLIC_DEPENDENCY",
    );
    expect(graph.size).toBe(0);
  });

  it("rejects a dependency mutation that would create a cycle", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "a", kind: "plan", title: "A" },
      { id: "b", kind: "plan", title: "B", dependencies: ["a"] },
    ]);
    const before = graph.toSnapshot();

    expectGraphError(() => graph.addDependency("a", "b"), "CYCLIC_DEPENDENCY");

    expect(graph.toSnapshot()).toEqual(before);
  });

  it("adds a dependency and rejects duplicate or missing dependency targets", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "a", kind: "plan", title: "A" },
      { id: "b", kind: "plan", title: "B" },
    ]);

    graph.addDependency("b", "a");
    expect(graph.getTask("b").dependencies).toEqual(["a"]);
    expectGraphError(() => graph.addDependency("b", "a"), "INVALID_ARGUMENT");
    expectGraphError(() => graph.addDependency("b", "missing"), "UNKNOWN_TASK");
  });

  it("enforces dependency and graph-depth quotas atomically", () => {
    const fanIn = createGraph();
    const dependencyIds = Array.from({ length: 257 }, (_, index) => `dependency:${index}`);
    expectGraphError(
      () =>
        fanIn.addTask({
          id: "too-wide",
          kind: "plan",
          title: "Too wide",
          dependencies: dependencyIds,
        }),
      "INVALID_ARGUMENT",
    );
    expect(fanIn.size).toBe(0);

    const tooDeep = createGraph();
    const chain = Array.from({ length: 129 }, (_, index) => ({
      id: `task:${index}`,
      kind: "plan",
      title: `Task ${index}`,
      ...(index === 0 ? {} : { dependencies: [`task:${index - 1}`] }),
    }));
    expectGraphError(() => tooDeep.addTasks(chain), "GRAPH_LIMIT_EXCEEDED");
    expect(tooDeep.size).toBe(0);
  });

  it("defensively clones and freezes task metadata", () => {
    const graph = createGraph();
    const metadata = { nested: { enabled: true }, labels: ["one"] };
    const task = graph.addTask({
      id: "metadata",
      kind: "plan",
      title: "Metadata",
      metadata,
    });

    metadata.nested.enabled = false;
    metadata.labels.push("two");

    expect(task.metadata).toEqual({ labels: ["one"], nested: { enabled: true } });
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.metadata)).toBe(true);
    expect(Object.isFrozen(task.metadata["nested"])).toBe(true);
  });

  it("canonicalizes negative zero for JSON-stable snapshots", () => {
    const graph = createGraph();
    const task = graph.addTask({
      id: "canonical",
      kind: "plan",
      title: "Canonical",
      priority: -0,
      metadata: { value: -0 },
    });

    expect(Object.is(task.priority, -0)).toBe(false);
    expect(Object.is(task.metadata["value"], -0)).toBe(false);
    const serialized = cloneSnapshot(graph.toSnapshot());
    expect(TaskGraph.hydrate(serialized).toSnapshot()).toEqual(graph.toSnapshot());
  });

  it("rejects cyclic, non-plain, and prototype-sensitive metadata", () => {
    const graph = createGraph();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expectGraphError(
      () =>
        graph.addTask({
          id: "cyclic",
          kind: "plan",
          title: "Cyclic",
          metadata: cyclic as never,
        }),
      "INVALID_ARGUMENT",
    );
    expectGraphError(
      () =>
        graph.addTask({
          id: "date",
          kind: "plan",
          title: "Date",
          metadata: { value: new Date() } as never,
        }),
      "INVALID_ARGUMENT",
    );
    const dangerous = JSON.parse('{"__proto__":{"polluted":true}}') as never;
    expectGraphError(
      () =>
        graph.addTask({
          id: "dangerous",
          kind: "plan",
          title: "Dangerous",
          metadata: dangerous,
        }),
      "INVALID_ARGUMENT",
    );
  });

  it("rejects accessor-backed records without invoking their getters", () => {
    const graph = createGraph();
    let getterCalls = 0;
    const options = {} as Record<string, unknown>;
    Object.defineProperty(options, "expectedVersion", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 0;
      },
    });

    expectGraphError(
      () =>
        graph.addTask(
          { id: "root", kind: "plan", title: "Root" },
          options as never,
        ),
      "INVALID_ARGUMENT",
    );
    expect(getterCalls).toBe(0);
    expect(graph.size).toBe(0);
  });

  it("rejects empty graphs and seals topology permanently", () => {
    const graph = createGraph();
    expectGraphError(() => graph.seal(), "EMPTY_GRAPH");

    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    graph.seal();

    expect(graph.sealed).toBe(true);
    expect(graph.status).toBe("active");
    expect(graph.getTask("root").status).toBe("ready");
    expectGraphError(
      () => graph.addTask({ id: "late", kind: "plan", title: "Late" }),
      "GRAPH_SEALED",
    );
    expectGraphError(() => graph.addDependency("root", "root"), "GRAPH_SEALED");
  });

  it("orders ready tasks by priority and then stable insertion order", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "low", kind: "test", title: "Low", priority: -1 },
      { id: "high-first", kind: "test", title: "High first", priority: 10 },
      { id: "high-second", kind: "test", title: "High second", priority: 10 },
    ]);
    graph.seal();

    expect(graph.getReadyTasks().map((task) => task.id)).toEqual([
      "high-first",
      "high-second",
      "low",
    ]);
    expect(graph.getReadyTasks({ limit: 1 }).map((task) => task.id)).toEqual([
      "high-first",
    ]);
    expect(graph.getReadyTasks({ limit: 0 })).toEqual([]);
  });

  it("validates query and topology option objects consistently", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    graph.seal();

    expectGraphError(() => graph.getReadyTasks(null as never), "INVALID_ARGUMENT");
    expectGraphError(
      () => graph.getReadyTasks({ limit: 1, extra: true } as never),
      "INVALID_ARGUMENT",
    );

    const planning = createGraph();
    expectGraphError(
      () =>
        planning.addTask(
          { id: "root", kind: "plan", title: "Root" },
          { reason: "not valid for topology" } as never,
        ),
      "INVALID_ARGUMENT",
    );
  });
});

describe("TaskGraph execution", () => {
  it("requires sealing before any task transition", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });

    expectGraphError(() => graph.startTask("root"), "GRAPH_NOT_SEALED");
  });

  it("supports running, waiting, resolution, resume, and success", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    graph.seal();

    expect(graph.startTask("root").status).toBe("running");
    expect(graph.markTaskWaiting("root", { reason: "External input" }).status).toBe(
      "waiting",
    );
    expect(graph.resumeTask("root").status).toBe("running");
    expect(graph.markTaskNeedsResolution("root").status).toBe("needs_resolution");
    expect(graph.resumeTask("root").status).toBe("running");
    const completed = graph.succeedTask("root", {
      outputArtifactIds: ["artifact:result"],
    });

    expect(completed.status).toBe("succeeded");
    expect(completed.outputArtifactIds).toEqual(["artifact:result"]);
    expect(graph.status).toBe("succeeded");
  });

  it("rejects illegal task transitions without mutating the graph", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    graph.seal();
    acknowledgeAll(graph);
    const before = graph.toSnapshot();

    expectGraphError(() => graph.succeedTask("root"), "INVALID_TRANSITION");

    expect(graph.toSnapshot()).toEqual(before);
    expect(graph.peekEvents()).toEqual([]);
  });

  it("rejects reentrant clock mutations and preserves aggregate atomicity", () => {
    let graph: TaskGraph | undefined;
    let triggerNestedMutation = false;
    let offset = 0;
    const clock = (): Date => {
      if (triggerNestedMutation) {
        triggerNestedMutation = false;
        graph!.cancelTask("root");
      }
      return new Date(BASE_TIME + offset++);
    };
    graph = TaskGraph.create(
      { graphId: "graph:reentrant", projectId: "project:test" },
      { clock },
    );
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    graph.seal();
    graph.startTask("root");
    const before = graph.toSnapshot();
    const eventsBefore = graph.peekEvents();
    triggerNestedMutation = true;

    expectGraphError(() => graph!.succeedTask("root"), "REENTRANT_MUTATION");

    expect(graph.toSnapshot()).toEqual(before);
    expect(graph.peekEvents()).toEqual(eventsBefore);
    expect(TaskGraph.hydrate(cloneSnapshot(graph.toSnapshot())).toSnapshot()).toEqual(
      graph.toSnapshot(),
    );
  });

  it("releases downstream tasks only after every dependency succeeds", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "left", kind: "implement", title: "Left" },
      { id: "right", kind: "implement", title: "Right" },
      {
        id: "merge",
        kind: "review",
        title: "Merge",
        dependencies: ["left", "right"],
      },
    ]);
    graph.seal();
    graph.startTask("left");
    graph.succeedTask("left");

    expect(graph.getTask("merge").status).toBe("pending");

    graph.startTask("right");
    graph.succeedTask("right");

    expect(graph.getTask("merge").status).toBe("ready");
  });

  it("round-trips a blocked fan-in task after later dependencies fail", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "left", kind: "test", title: "Left" },
      { id: "right", kind: "test", title: "Right" },
      {
        id: "join",
        kind: "review",
        title: "Join",
        dependencies: ["left", "right"],
      },
    ]);
    graph.seal();
    graph.failTask("left", {
      code: "LEFT_FAILED",
      message: "Left failed",
      retryable: false,
    });
    expect(graph.getTask("join").blockedBy).toEqual(["left"]);

    graph.failTask("right", {
      code: "RIGHT_FAILED",
      message: "Right failed",
      retryable: false,
    });

    const hydrated = TaskGraph.hydrate(cloneSnapshot(graph.toSnapshot()));
    expect(hydrated.getTask("join").blockedBy).toEqual(["left"]);
    expect(hydrated.status).toBe("failed");
  });

  it("propagates failure transitively and reports a failed graph", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "root", kind: "implement", title: "Root" },
      {
        id: "child",
        kind: "test",
        title: "Child",
        dependencies: ["root"],
      },
      {
        id: "leaf",
        kind: "review",
        title: "Leaf",
        dependencies: ["child"],
      },
    ]);
    graph.seal();
    graph.startTask("root");
    graph.failTask("root", {
      code: "TEST_FAILED",
      message: "Validation failed",
      retryable: false,
    });

    expect(graph.getTask("root").failure?.code).toBe("TEST_FAILED");
    expect(graph.getTask("child").status).toBe("blocked");
    expect(graph.getTask("child").blockedBy).toEqual(["root"]);
    expect(graph.getTask("leaf").status).toBe("blocked");
    expect(graph.getTask("leaf").blockedBy).toEqual(["child"]);
    expect(graph.status).toBe("failed");
  });

  it("allows terminal failure from ready after attempt retries are exhausted", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "implement", title: "Root" });
    graph.seal();

    graph.failTask("root", {
      code: "NO_ROUTE",
      message: "No eligible provider remained",
      retryable: false,
    });

    expect(graph.getTask("root").status).toBe("failed");
    expect(graph.status).toBe("failed");
  });

  it("copies output identifiers and rejects custom or oversized arrays", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "implement", title: "Root" });
    graph.seal();
    graph.startTask("root");
    const outputs = ["artifact:one"];
    graph.succeedTask("root", { outputArtifactIds: outputs });
    outputs[0] = "artifact:changed";
    expect(graph.getTask("root").outputArtifactIds).toEqual(["artifact:one"]);

    const hostileGraph = createGraph();
    hostileGraph.addTask({ id: "root", kind: "implement", title: "Root" });
    hostileGraph.seal();
    hostileGraph.startTask("root");
    const hostile = ["artifact:one"] as string[] & { map?: () => unknown };
    hostile.map = () => [{ retained: true }];
    expectGraphError(
      () => hostileGraph.succeedTask("root", { outputArtifactIds: hostile as never }),
      "INVALID_ARGUMENT",
    );
    expect(hostileGraph.getTask("root").status).toBe("running");

    expectGraphError(
      () => hostileGraph.succeedTask("root", { outputArtifactIds: null } as never),
      "INVALID_ARGUMENT",
    );
    expect(hostileGraph.getTask("root").status).toBe("running");

    expectGraphError(
      () =>
        hostileGraph.succeedTask("root", {
          outputArtifactIds: Array.from(
            { length: 1_001 },
            (_, index) => `artifact:${index}`,
          ),
        }),
      "INVALID_ARGUMENT",
    );
    expect(hostileGraph.getTask("root").status).toBe("running");
  });

  it("propagates cancellation and reports a cancelled graph", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "root", kind: "implement", title: "Root" },
      {
        id: "child",
        kind: "test",
        title: "Child",
        dependencies: ["root"],
      },
    ]);
    graph.seal();
    graph.cancelTask("root", { reason: "User cancelled" });

    expect(graph.getTask("root").status).toBe("cancelled");
    expect(graph.getTask("child").status).toBe("blocked");
    expect(graph.status).toBe("cancelled");
  });

  it("keeps the graph active while an independent branch can still run", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "failed", kind: "test", title: "Failed branch" },
      { id: "active", kind: "test", title: "Active branch" },
    ]);
    graph.seal();
    graph.failTask("failed", {
      code: "FAILED",
      message: "Failed",
      retryable: false,
    });

    expect(graph.status).toBe("active");

    graph.startTask("active");
    graph.succeedTask("active");

    expect(graph.status).toBe("failed");
  });

  it("cancels every nonterminal task in one aggregate version", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "one", kind: "test", title: "One" },
      { id: "two", kind: "test", title: "Two" },
    ]);
    graph.seal();
    graph.startTask("one");
    const beforeVersion = graph.version;
    acknowledgeAll(graph);

    const cancelled = graph.cancelRemaining({ reason: "Run cancelled" });

    expect(cancelled.map((task) => task.id)).toEqual(["one", "two"]);
    expect(graph.version).toBe(beforeVersion + 1);
    expect(graph.status).toBe("cancelled");
    expect(
      new Set(graph.peekEvents().map((event) => event.aggregateVersion)),
    ).toEqual(new Set([graph.version]));
    expect(graph.cancelRemaining()).toEqual([]);
    expect(graph.version).toBe(beforeVersion + 1);
  });

  it("rejects stale optimistic versions before mutation", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    const before = graph.toSnapshot();
    acknowledgeAll(graph);

    expectGraphError(
      () =>
        graph.addTask(
          { id: "late", kind: "plan", title: "Late" },
          { expectedVersion: 0 },
        ),
      "CONCURRENCY_CONFLICT",
    );

    expect(graph.toSnapshot()).toEqual(before);
    expect(graph.peekEvents()).toEqual([]);
  });

  it("increments the aggregate once per command and events monotonically", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "root", kind: "plan", title: "Root" },
      {
        id: "child",
        kind: "test",
        title: "Child",
        dependencies: ["root"],
      },
    ]);
    graph.seal();
    graph.startTask("root");
    graph.succeedTask("root");

    expect(graph.version).toBe(4);
    const events = graph.peekEvents();
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.at(-1)?.aggregateVersion).toBe(4);
    expect(events.some((event) => event.type === "graph.status_changed")).toBe(true);
  });

  it("marks every event with an explicit aggregate-version batch position", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "one", kind: "plan", title: "One" },
      { id: "two", kind: "plan", title: "Two" },
    ]);

    expect(graph.peekEvents().map((event) => [event.eventIndex, event.eventCount])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    acknowledgeAll(graph);
    graph.seal();
    const sealEvents = graph.peekEvents();
    expect(sealEvents.every((event) => event.eventCount === sealEvents.length)).toBe(true);
    expect(sealEvents.map((event) => event.eventIndex)).toEqual(
      sealEvents.map((_, index) => index),
    );
  });

  it("can rehydrate after every successful lifecycle command", () => {
    const graph = createGraph();
    const assertRoundTrip = (): void => {
      expect(TaskGraph.hydrate(cloneSnapshot(graph.toSnapshot())).toSnapshot()).toEqual(
        graph.toSnapshot(),
      );
    };

    graph.addTasks([
      { id: "root", kind: "plan", title: "Root" },
      {
        id: "child",
        kind: "test",
        title: "Child",
        dependencies: ["root"],
      },
    ]);
    assertRoundTrip();
    graph.seal();
    assertRoundTrip();
    graph.startTask("root");
    assertRoundTrip();
    graph.markTaskWaiting("root");
    assertRoundTrip();
    graph.resumeTask("root");
    assertRoundTrip();
    graph.markTaskNeedsResolution("root");
    assertRoundTrip();
    graph.resumeTask("root");
    assertRoundTrip();
    graph.succeedTask("root");
    assertRoundTrip();
    graph.cancelTask("child");
    assertRoundTrip();
  });

  it("retains events across persistence rollback and acknowledges after commit", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    const snapshot = graph.toSnapshot();
    const pending = graph.peekEvents();

    // A failed persistence transaction does not acknowledge anything.
    expect(graph.peekEvents()).toEqual(pending);
    const acknowledged = graph.acknowledgeEvents(pending.at(-1)!.sequence);

    expect(acknowledged).toBe(1);
    expect(graph.peekEvents()).toEqual([]);
    expect(graph.toSnapshot()).toEqual(snapshot);
  });
});

describe("TaskGraph hydration", () => {
  it("round-trips a valid graph without recreating historical events", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "root", kind: "plan", title: "Root", metadata: { scope: "repo" } },
      {
        id: "child",
        kind: "test",
        title: "Child",
        dependencies: ["root"],
      },
    ]);
    graph.seal();
    graph.startTask("root");
    graph.succeedTask("root", { outputArtifactIds: ["artifact:root"] });

    const hydrated = TaskGraph.hydrate(
      JSON.parse(JSON.stringify(graph.toSnapshot())),
      { clock: sequentialClock() },
    );

    expect(hydrated.toSnapshot()).toEqual(graph.toSnapshot());
    expect(hydrated.peekEvents()).toEqual([]);
    expect(hydrated.getReadyTasks().map((task) => task.id)).toEqual(["child"]);
  });

  it("rejects unknown fields and unsupported schemas", () => {
    const graph = createGraph();
    const unknown = cloneSnapshot(graph.toSnapshot());
    unknown["unexpected"] = true;
    expectGraphError(() => TaskGraph.hydrate(unknown), "INVALID_SNAPSHOT");

    const wrongVersion = cloneSnapshot(graph.toSnapshot());
    wrongVersion["schemaVersion"] = 2;
    expectGraphError(() => TaskGraph.hydrate(wrongVersion), "INVALID_SNAPSHOT");
  });

  it("rejects overridden or sparse snapshot arrays without retaining input objects", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    const hostile = cloneSnapshot(graph.toSnapshot());
    const retainedTask = hostile["tasks"][0];
    hostile["tasks"].map = () => [retainedTask];

    expectGraphError(() => TaskGraph.hydrate(hostile), "INVALID_SNAPSHOT");

    const sparse = cloneSnapshot(graph.toSnapshot());
    sparse["tasks"] = new Array(1);
    expectGraphError(() => TaskGraph.hydrate(sparse), "INVALID_SNAPSHOT");
  });

  it("rejects inconsistent aggregate version and event sequence values", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });

    const lowSequence = cloneSnapshot(graph.toSnapshot());
    lowSequence["eventSequence"] = 0;
    expectGraphError(() => TaskGraph.hydrate(lowSequence), "INVALID_SNAPSHOT");

    const impossibleInitial = cloneSnapshot(createGraph().toSnapshot());
    impossibleInitial["version"] = 1;
    impossibleInitial["eventSequence"] = 1;
    expectGraphError(() => TaskGraph.hydrate(impossibleInitial), "INVALID_SNAPSHOT");
  });

  it("rejects non-contiguous task order and unreachable graph timestamps", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });

    const orderGap = cloneSnapshot(graph.toSnapshot());
    orderGap["tasks"][0]["order"] = 9_999;
    expectGraphError(() => TaskGraph.hydrate(orderGap), "INVALID_SNAPSHOT");

    const futureGraph = cloneSnapshot(graph.toSnapshot());
    futureGraph["updatedAt"] = "2099-01-01T00:00:00.000Z";
    expectGraphError(() => TaskGraph.hydrate(futureGraph), "INVALID_SNAPSHOT");
  });

  it("refuses mutation when numeric aggregate counters are exhausted", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    const exhausted = cloneSnapshot(graph.toSnapshot());
    exhausted["version"] = Number.MAX_SAFE_INTEGER;
    exhausted["eventSequence"] = Number.MAX_SAFE_INTEGER;
    const hydrated = TaskGraph.hydrate(exhausted, { clock: sequentialClock() });
    const before = hydrated.toSnapshot();

    expectGraphError(
      () => hydrated.addTask({ id: "late", kind: "plan", title: "Late" }),
      "INVALID_ARGUMENT",
    );

    expect(hydrated.toSnapshot()).toEqual(before);
  });

  it("reserves enough event sequence capacity for the largest command batch", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    const nearLimit = cloneSnapshot(graph.toSnapshot());
    nearLimit["version"] = Number.MAX_SAFE_INTEGER - 20_000;
    nearLimit["eventSequence"] = Number.MAX_SAFE_INTEGER - 5_000;
    const hydrated = TaskGraph.hydrate(nearLimit);

    expectGraphError(
      () => hydrated.addTask({ id: "late", kind: "plan", title: "Late" }),
      "INVALID_ARGUMENT",
    );
    expect(hydrated.eventSequence).toBe(Number.MAX_SAFE_INTEGER - 5_000);
  });

  it("rejects cycles even when a snapshot is otherwise well-shaped", () => {
    const graph = createGraph();
    graph.addTasks([
      { id: "a", kind: "plan", title: "A" },
      { id: "b", kind: "plan", title: "B" },
    ]);
    const snapshot = cloneSnapshot(graph.toSnapshot());
    snapshot["tasks"][0]["dependencies"] = ["b"];
    snapshot["tasks"][1]["dependencies"] = ["a"];

    expectGraphError(() => TaskGraph.hydrate(snapshot), "INVALID_SNAPSHOT");
  });

  it("rejects unreconciled sealed task state", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    graph.seal();
    const snapshot = cloneSnapshot(graph.toSnapshot());
    snapshot["tasks"][0]["status"] = "pending";

    expectGraphError(() => TaskGraph.hydrate(snapshot), "INVALID_SNAPSHOT");
  });

  it("rejects inconsistent failure, output, and blocker data", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    graph.seal();

    const failure = cloneSnapshot(graph.toSnapshot());
    failure["tasks"][0]["failure"] = {
      code: "FAILED",
      message: "Unexpected failure data",
      retryable: false,
    };
    expectGraphError(() => TaskGraph.hydrate(failure), "INVALID_SNAPSHOT");

    const output = cloneSnapshot(graph.toSnapshot());
    output["tasks"][0]["outputArtifactIds"] = ["artifact:invalid"];
    expectGraphError(() => TaskGraph.hydrate(output), "INVALID_SNAPSHOT");

    const blocker = cloneSnapshot(graph.toSnapshot());
    blocker["tasks"][0]["blockedBy"] = ["root"];
    expectGraphError(() => TaskGraph.hydrate(blocker), "INVALID_SNAPSHOT");
  });

  it("keeps returned snapshots and task collections immutable", () => {
    const graph = createGraph();
    graph.addTask({ id: "root", kind: "plan", title: "Root" });
    const snapshot = graph.toSnapshot();
    const tasks = graph.listTasks();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks)).toBe(true);
    expect(Object.isFrozen(tasks)).toBe(true);
    expect(Object.isFrozen(tasks[0])).toBe(true);
    expect(() => (snapshot.tasks as any[]).push({})).toThrow(TypeError);
  });
});
