import assert from "node:assert/strict";
import { openPlanningStorage } from "@ai-dev-os/application/planning-storage";

// Invoked only by the explicit owned-runtime validation script. The supplied
// root is a fresh, task-owned fixture, never the operator's desktop data.
const root = process.argv[2];
if (root === undefined) throw new Error("SQLITE_PROBE_ROOT_REQUIRED");
let store = await openPlanningStorage(root);
await store.persistence.transact(async (tx) => {
  await tx.aggregates.create({ aggregateType: "project", aggregateId: "runtime-probe", schemaVersion: 1, payload: { fixture: "owned-child-write" } });
  await tx.events.append({ eventId: "runtime-probe-event", aggregateType: "project", aggregateId: "runtime-probe", aggregateVersion: 1, eventType: "runtime-probe.created", eventSchemaVersion: 1, payload: { fixture: "owned-child-write" }, occurredAt: new Date().toISOString() });
});
await store.close();
store = await openPlanningStorage(root);
try {
  await store.persistence.transact(async (tx) => {
    assert.equal(JSON.stringify((await tx.aggregates.get("project", "runtime-probe"))?.payload), '{"fixture":"owned-child-write"}');
    assert.equal((await tx.events.list({ aggregateType: "project", aggregateId: "runtime-probe" })).items.length, 1);
  });
  process.stdout.write(`${JSON.stringify({ kind: "owned-child-sqlite-write-reopen", node: process.versions.node, modulesAbi: process.versions.modules, electron: process.versions["electron"] ?? null, execPath: process.execPath, journalMode: "delete", synchronous: "FULL", ok: true })}\n`);
} finally { await store.close(); }
