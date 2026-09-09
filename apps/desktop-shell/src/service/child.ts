import process from "node:process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { startControlService, type ControlServiceHandle } from "@ai-dev-os/control-service";
import { createSyntheticDevelopmentDataset } from "./dataset.js";
import { openPlanningStorage, type PlanningStorage } from "@ai-dev-os/application/planning-storage";
import { createSavedPlanningApplication, type SavedPlanningApplication } from "@ai-dev-os/application/planning";
import { exactPlanningRecord, parsePlanningQuery, type NativePlanningReply, type NativePlanningRequest } from "../shared/planning-ipc.js";

/** The normal executable below supplies no clock. Only the separate owned
 * fixture entry imports this host and supplies its synthetic clock factory. */
export function runOwnedServiceChild(planningClockForTest?: (dataRoot: string) => Promise<{ now(): Date }>, planningProcessForTest?: (dataRoot: string) => Promise<NonNullable<Parameters<typeof createSavedPlanningApplication>[0]["planningProcess"]>>): void {
type StartMessage = Readonly<{
  kind: "start";
  launchNonce: string;
  storageRoot: string;
  dataRoot: string;
  presentationMode: "normal" | "developer";
}>;

function isStartMessage(value: unknown): value is StartMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "dataRoot,kind,launchNonce,presentationMode,storageRoot"
    && record["kind"] === "start"
    && typeof record["launchNonce"] === "string"
    && /^[a-f0-9]{32}$/u.test(record["launchNonce"])
    && typeof record["storageRoot"] === "string"
    && typeof record["dataRoot"] === "string"
    && (record["presentationMode"] === "normal" || record["presentationMode"] === "developer");
}

function controlKind(value: unknown, expectedNonce: string | null): "shutdown" | "terminate-for-test" | null {
  if (expectedNonce === null || typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "kind,launchNonce" || record["launchNonce"] !== expectedNonce) return null;
  return record["kind"] === "shutdown" || record["kind"] === "terminate-for-test" ? record["kind"] : null;
}

let handle: ControlServiceHandle | null = null;
let storage: PlanningStorage | null = null;
let planning: SavedPlanningApplication | null = null;
const planningContext = new AsyncLocalStorage<string>();
const native = new Map<string, (value: NativePlanningReply) => void>();
const planningRequests = new Set<string>();
async function askNative(request: NativePlanningRequest): Promise<NativePlanningReply> {
  const requestId = planningContext.getStore();
  if (closing || requestId === undefined || !planningRequests.has(requestId) || native.size >= 8 || !process.connected) return null;
  const nativeId = randomBytes(16).toString("hex");
  return await new Promise((resolveNative) => {
    const timer = setTimeout(() => finish(null), 110_000);
    const finish = (value: NativePlanningReply): void => { if (!native.has(nativeId)) return; native.delete(nativeId); clearTimeout(timer); resolveNative(value); };
    native.set(nativeId, finish);
    process.send?.({ kind: "planning-native", launchNonce, requestId, nativeId, request }, (error) => { if (error !== null) finish(null); });
  });
}
function planningMessage(message: unknown): boolean {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const raw = message as Record<string, unknown>;
  if (raw["launchNonce"] !== launchNonce || closing) return false;
  try {
    if (raw["kind"] === "planning-native-reply") {
      const r = exactPlanningRecord(raw, ["kind", "launchNonce", "nativeId", "value"]);
      native.get(String(r["nativeId"]))?.(r["value"] as NativePlanningReply); return true;
    }
    if (raw["kind"] !== "planning-request") return false;
    const r = exactPlanningRecord(raw, ["kind", "launchNonce", "requestId", "query"]), query = parsePlanningQuery(r["query"]), requestId = r["requestId"];
    if (planning === null || typeof requestId !== "string" || !/^[a-f0-9]{32}$/u.test(requestId) || planningRequests.has(requestId) || planningRequests.size >= 8) return false;
    planningRequests.add(requestId);
    void planningContext.run(requestId, async () => {
      try {
        const value = query.kind === "snapshot" ? await planning!.snapshot(query.projectId) : query.kind === "observe" ? await planning!.observe(query.commandId) : query.kind === "handover" ? await planning!.handover(query.projectId, query.handoverId) : await planning!.command(query.command);
        if (process.connected) process.send?.({ kind: "planning-reply", launchNonce, requestId, ok: true, value });
      } catch { if (process.connected) process.send?.({ kind: "planning-reply", launchNonce, requestId, ok: false, value: null }); }
      finally { planningRequests.delete(requestId); }
    });
    return true;
  } catch { return false; }
}
let startPromise: Promise<ControlServiceHandle> | null = null;
let launchNonce: string | null = null;
let closing = false;
let closePromise: Promise<void> | null = null;

function close(exitCode: number): Promise<void> {
  if (closePromise !== null) return closePromise;
  closing = true;
  for (const finish of [...native.values()]) finish(null);
  closePromise = (async () => {
    try {
      const started = handle ?? await startPromise?.catch(() => null) ?? null;
      await planning?.drain();
      try { await started?.close(); }
      finally { await storage?.close(); }
      process.exitCode = exitCode;
    } catch {
      process.exitCode = 72;
    } finally {
      process.disconnect?.();
    }
  })();
  return closePromise;
}

process.once("disconnect", () => { void close(0); });
process.once("SIGTERM", () => { void close(0); });
process.on("message", (message: unknown) => {
  if (isStartMessage(message) && handle === null && launchNonce === null) {
    launchNonce = message.launchNonce;
    const now = new Date().toISOString();
    startPromise = (async () => {
      const planningClock = await planningClockForTest?.(message.dataRoot);
      const planningProcess = await planningProcessForTest?.(message.dataRoot);
      storage = await openPlanningStorage(message.dataRoot);
      planning = createSavedPlanningApplication({ persistence: storage.persistence, artifactRoot: storage.artifactRoot, ...(planningClock === undefined ? {} : { clock: planningClock }), ...(planningProcess === undefined ? {} : { planningProcess }), operator: {
        async confirm(review) { return await askNative({ kind: "confirm", review }) === true; },
        async selectRepository() { const value = await askNative({ kind: "repository" }); return typeof value === "string" ? value : null; },
        async selectResult() {
          const value = await askNative({ kind: "result" });
          if (value === null || typeof value !== "object") return null;
          const record = exactPlanningRecord(value, ["name", "text"]);
          return typeof record["name"] === "string" && typeof record["text"] === "string" && record["text"].length <= 65536 ? { name: record["name"], text: record["text"] } : null;
        },
      } });
      await planning.initialize();
      return await startControlService({
      storageRoot: message.storageRoot,
      presentationMode: message.presentationMode,
      projectionDataset: createSyntheticDevelopmentDataset(now),
      });
    })();
    void (async () => {
      try {
        handle = await startPromise;
        if (!closing) process.send?.(Object.freeze({ kind: "ready", launchNonce: message.launchNonce }));
      } catch {
        if (!closing) {
          process.send?.(Object.freeze({ kind: "failed", launchNonce: message.launchNonce, code: "SERVICE_START_FAILED" }));
          await close(71);
        }
      }
    })();
    return;
  }
  if (planningMessage(message)) return;
  const control = controlKind(message, launchNonce);
  if (control === "shutdown") { void close(0); return; }
  if (control === "terminate-for-test") { void close(70); return; }
  void close(73);
});
}

// Canonical comparison preserves direct execution through Windows path aliases.
// Importing from the test entry does not also start the production host.
if (process.argv[1] !== undefined && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) runOwnedServiceChild();
