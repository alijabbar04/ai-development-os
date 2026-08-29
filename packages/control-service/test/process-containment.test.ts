import { fork } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONNECTION_DESCRIPTOR_FILE, INSTANCE_LOCK_FILE } from "../src/index.js";
import { createCanonicalTemporaryRoot } from "./temporary-root.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function missing(path: string): Promise<boolean> {
  try { await access(path); return false; }
  catch { return true; }
}

describe("C4 task-owned process containment fixture", () => {
  it("closes the listener and owned artifacts through its signal path", async () => {
    const storageRoot = await createCanonicalTemporaryRoot("ai-dev-os-c4-child-");
    roots.push(storageRoot);
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "signal-control-service.mjs");
    const child = fork(fixture, [storageRoot], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child readiness timed out")), 5_000);
      child.once("error", reject);
      child.on("message", (message: unknown) => {
        if (typeof message === "object" && message !== null && "type" in message && typeof message.type === "string") {
          messages.push(message.type);
          if (message.type === "ready") {
            child.send("emit-task-owned-sigterm");
          } else if (message.type === "closed") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    await exited;
    expect(messages).toEqual(["ready", "closed"]);
    expect(child.exitCode).toBe(0);
    expect(await missing(join(storageRoot, CONNECTION_DESCRIPTOR_FILE))).toBe(true);
    expect(await missing(join(storageRoot, INSTANCE_LOCK_FILE))).toBe(true);
  });
});
