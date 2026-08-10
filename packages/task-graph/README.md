# `@ai-dev-os/task-graph`

The task-graph package is the I/O-free aggregate used by the orchestration scheduler. It owns graph topology, task readiness, legal task transitions, dependency failure propagation, optimistic versions, ordered domain events, and defensive snapshot hydration.

Infrastructure adapters own attempts, leases, retries, persistence, provider calls, and repository workspaces. Keeping those concerns outside this package makes graph behavior deterministic and exhaustively testable.

```ts
import { TaskGraph } from "@ai-dev-os/task-graph";

const graph = TaskGraph.create({
  graphId: "graph:example",
  projectId: "project:example",
});

graph.addTasks([
  { id: "plan", kind: "plan", title: "Plan the change" },
  {
    id: "implement",
    kind: "implement",
    title: "Implement the change",
    dependencies: ["plan"],
  },
]);

graph.seal();
graph.startTask("plan");
graph.succeedTask("plan", { outputArtifactIds: ["artifact:plan"] });

console.log(graph.getReadyTasks().map((task) => task.id));
// ["implement"]
```

All returned tasks, snapshots, and events are immutable copies. Read pending events with `peekEvents()`, persist the snapshot and events in one transaction using idempotent event inserts, commit, and then call `acknowledgeEvents(lastSequence)`. A failed transaction leaves the in-memory event queue intact for retry.

Durable consumers can call `replayTaskGraphEvents(events, checkpoint)` to
validate exact event envelopes, contiguous aggregate-version batches, status
transitions, immutable task projections, command batch ordering, automatic
reconciliation, reason bounds, topology changes, and the final checkpoint. The
checkpoint supplies only the graph creation timestamp, which is not present in
the event schema.
