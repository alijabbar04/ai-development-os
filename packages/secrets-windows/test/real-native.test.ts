import { describe, expect, it } from "vitest";
import {
  createRealWindowsCredentialNativePort,
  createWindowsCredentialNativePortFromLoader,
} from "../src/real-native.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("real Windows credential native port", () => {
  it("constructs the production port without loading or calling the native addon", () => {
    const port = createRealWindowsCredentialNativePort();
    expect(Object.keys(port)).toEqual(["availability", "read"]);
    expect(Object.isFrozen(port)).toBe(true);
  });

  it("fails finitely without loading the addon on non-Windows platforms", async () => {
    let loads = 0;
    const port = createWindowsCredentialNativePortFromLoader("linux", () => { loads += 1; return {}; });
    await expect(port.availability("AI-Dev-OS:v1:test:" + "a".repeat(64))).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(port.read("AI-Dev-OS:v1:test:" + "a".repeat(64))).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(loads).toBe(0);
  });

  it("maps missing, accessor, and throwing addon exports to one finite refusal", async () => {
    const values: Array<() => unknown> = [
      () => null,
      () => ({}),
      () => ({ availability: async () => ({ status: "ok" }) }),
      () => Object.defineProperty({ read: async () => ({ status: "not-found" }) }, "availability", {
        enumerable: true,
        get: () => { throw new Error("must-not-run"); },
      }),
      () => { throw new Error("private-path-canary"); },
    ];
    for (const loader of values) {
      const port = createWindowsCredentialNativePortFromLoader("win32", loader);
      await expect(port.availability("AI-Dev-OS:v1:test:" + "b".repeat(64))).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: "The Windows credential native boundary is unavailable.",
      });
    }
  });

  it("captures the addon once and forwards exact target names", async () => {
    const calls: string[] = [];
    let loads = 0;
    const addon = {
      async availability(targetName: string) { calls.push(`availability:${targetName}`); return { status: "ok" as const }; },
      async read(targetName: string) { calls.push(`read:${targetName}`); return { status: "not-found" as const }; },
    };
    Object.defineProperty(addon.availability, "bind", { value: () => async () => ({ status: "unavailable" as const }) });
    Object.defineProperty(addon.read, "bind", { value: () => async () => ({ status: "failure" as const }) });
    const port = createWindowsCredentialNativePortFromLoader("win32", () => { loads += 1; return addon; });
    const target = "AI-Dev-OS:v1:test:" + "c".repeat(64);
    await expect(port.availability(target)).resolves.toEqual({ status: "ok" });
    addon.availability = async () => ({ status: "unavailable" as const });
    addon.read = async () => ({ status: "failure" as const });
    await expect(port.availability(target)).resolves.toEqual({ status: "ok" });
    await expect(port.read(target)).resolves.toEqual({ status: "not-found" });
    expect(loads).toBe(1);
    expect(calls).toEqual([`availability:${target}`, `availability:${target}`, `read:${target}`]);
  });

  it("refuses pre-cancelled calls before loading the addon", async () => {
    let loads = 0;
    const signal = new AbortController();
    signal.abort();
    const port = createWindowsCredentialNativePortFromLoader("win32", () => { loads += 1; return {}; });
    await expect(port.availability("target", signal.signal)).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    await expect(port.read("target", signal.signal)).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(loads).toBe(0);
  });

  it("checks cancellation after availability and zeroes late read bytes", async () => {
    const availability = deferred<{ status: "ok"; bytes: Uint8Array }>();
    const read = deferred<{ status: "ok"; bytes: Uint8Array }>();
    const port = createWindowsCredentialNativePortFromLoader("win32", () => ({
      availability: () => availability.promise,
      read: () => read.promise,
    }));

    const availabilityController = new AbortController();
    const availabilityBytes = new TextEncoder().encode("synthetic-only");
    const availabilityPending = port.availability("target", availabilityController.signal);
    availabilityController.abort();
    availability.resolve({ status: "ok", bytes: availabilityBytes });
    await expect(availabilityPending).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(availabilityBytes.every((byte) => byte === 0)).toBe(true);

    const bytes = new TextEncoder().encode("synthetic-only");
    const readController = new AbortController();
    const readPending = port.read("target", readController.signal);
    readController.abort();
    read.resolve({ status: "ok", bytes });
    await expect(readPending).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes late bytes when hostile post-read cancellation inspection throws", async () => {
    const bytes = new TextEncoder().encode("synthetic-only");
    let reads = 0;
    const signal = Object.freeze({
      get aborted() { reads += 1; if (reads === 1) return false; throw new Error("hostile-aborted"); },
      addEventListener() { /* required signal surface */ },
    });
    const port = createWindowsCredentialNativePortFromLoader("win32", () => ({
      availability: async () => ({ status: "ok" }),
      read: async () => ({ status: "ok", bytes }),
    }));
    await expect(port.read("target", signal)).rejects.toMatchObject({
      code: "RESOLUTION_TIMEOUT",
      message: "The secret resolution cancellation state is unavailable.",
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes availability bytes when hostile post-call cancellation inspection throws", async () => {
    const bytes = new TextEncoder().encode("synthetic-only");
    let reads = 0;
    const signal = Object.freeze({
      get aborted() { reads += 1; if (reads === 1) return false; throw new Error("hostile-aborted"); },
      addEventListener() { /* required signal surface */ },
    });
    const port = createWindowsCredentialNativePortFromLoader("win32", () => ({
      availability: async () => ({ status: "ok", bytes }),
      read: async () => ({ status: "not-found" }),
    }));
    await expect(port.availability("target", signal)).rejects.toMatchObject({
      code: "RESOLUTION_TIMEOUT",
      message: "The secret resolution cancellation state is unavailable.",
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes safely discoverable bytes attached to rejected addon results", async () => {
    for (const operation of ["availability", "read"] as const) {
      for (const bare of [false, true]) {
        const bytes = new TextEncoder().encode("synthetic-only");
        const rejection = bare ? bytes : Object.assign(new Error("native-rejection"), { bytes });
        const port = createWindowsCredentialNativePortFromLoader("win32", () => ({
          availability: async () => { if (operation === "availability") throw rejection; return { status: "not-found" as const }; },
          read: async () => { if (operation === "read") throw rejection; return { status: "not-found" as const }; },
        }));
        await expect(operation === "availability" ? port.availability("target") : port.read("target")).rejects.toBe(rejection);
        expect(bytes.every((byte) => byte === 0)).toBe(true);
      }
    }
  });

  it("zeroes bare byte views returned after late cancellation", async () => {
    for (const operation of ["availability", "read"] as const) {
      const bytes = new TextEncoder().encode("synthetic-only");
      const pending = deferred<Uint8Array>();
      const controller = new AbortController();
      const port = createWindowsCredentialNativePortFromLoader("win32", () => ({
        availability: () => operation === "availability" ? pending.promise : Promise.resolve({ status: "not-found" as const }),
        read: () => operation === "read" ? pending.promise : Promise.resolve({ status: "not-found" as const }),
      }));
      const call = operation === "availability" ? port.availability("target", controller.signal) : port.read("target", controller.signal);
      controller.abort();
      pending.resolve(bytes);
      await expect(call).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
  });
});
