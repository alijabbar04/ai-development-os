import process from "node:process";
import { startControlService, type ControlServiceHandle } from "@ai-dev-os/control-service";
import { createSyntheticDevelopmentDataset } from "./dataset.js";

type StartMessage = Readonly<{
  kind: "start";
  launchNonce: string;
  storageRoot: string;
  presentationMode: "normal" | "developer";
}>;

function isStartMessage(value: unknown): value is StartMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "kind,launchNonce,presentationMode,storageRoot"
    && record["kind"] === "start"
    && typeof record["launchNonce"] === "string"
    && /^[a-f0-9]{32}$/u.test(record["launchNonce"])
    && typeof record["storageRoot"] === "string"
    && (record["presentationMode"] === "normal" || record["presentationMode"] === "developer");
}

function controlKind(value: unknown, expectedNonce: string | null): "shutdown" | "terminate-for-test" | null {
  if (expectedNonce === null || typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "kind,launchNonce" || record["launchNonce"] !== expectedNonce) return null;
  return record["kind"] === "shutdown" || record["kind"] === "terminate-for-test" ? record["kind"] : null;
}

let handle: ControlServiceHandle | null = null;
let startPromise: Promise<ControlServiceHandle> | null = null;
let launchNonce: string | null = null;
let closing = false;
let closePromise: Promise<void> | null = null;

function close(exitCode: number): Promise<void> {
  if (closePromise !== null) return closePromise;
  closing = true;
  closePromise = (async () => {
    try {
      const started = handle ?? await startPromise?.catch(() => null) ?? null;
      await started?.close();
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
    startPromise = startControlService({
      storageRoot: message.storageRoot,
      presentationMode: message.presentationMode,
      projectionDataset: createSyntheticDevelopmentDataset(now),
    });
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
  const control = controlKind(message, launchNonce);
  if (control === "shutdown") { void close(0); return; }
  if (control === "terminate-for-test") { void close(70); return; }
  void close(73);
});
