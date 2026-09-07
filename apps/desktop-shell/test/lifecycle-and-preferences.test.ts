import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopSnapshot } from "../src/main/lifecycle.js";
import { DEFAULT_DESKTOP_PREFERENCES, parseDesktopPreferences, readDesktopPreferences, writeDesktopPreferences } from "../src/main/preferences.js";
import type { OwnedServiceSnapshot } from "../src/service/controller.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function service(overrides: Partial<OwnedServiceSnapshot> = {}): OwnedServiceSnapshot {
  return {
    phase: "ready",
    presentationMode: "normal",
    attemptStartedAt: "2026-09-07T10:00:00.000Z",
    recoveryAvailable: true,
    observation: {
      freshness: "live", observedAt: "2026-09-07T10:00:01.000Z", ageMs: 0, serviceVersion: "0.1.0",
      presentationMode: "normal", runningSessions: 0, verification: "identity-verified-connection-closed",
      dataSource: "owned-synthetic-development-service", authority: "none", commands: [],
    },
    failureCode: null,
    ...overrides,
  };
}

describe("desktop lifecycle and benign preferences", () => {
  it("preserves identical authority while Developer expands diagnostics", () => {
    const normal = createDesktopSnapshot(service(), DEFAULT_DESKTOP_PREFERENCES);
    const developerPreferences = { ...DEFAULT_DESKTOP_PREFERENCES, presentationMode: "developer" as const };
    const developer = createDesktopSnapshot(service({ presentationMode: "developer", observation: { ...service().observation!, presentationMode: "developer" } }), developerPreferences);
    expect(normal.authority).toBe("none");
    expect(developer.authority).toBe("none");
    expect(normal.commands).toEqual(developer.commands);
    expect(normal.diagnostics).toBeNull();
    expect(developer.diagnostics).toMatchObject({ ownsChild: true, verificationConnection: "closed-after-check" });
  });

  it("keeps failed-start recovery unavailable until its controller says the deadline passed", () => {
    const waiting = createDesktopSnapshot(service({ phase: "failed-start", recoveryAvailable: false, observation: null, failureCode: "SERVICE_START_FAILED" }), DEFAULT_DESKTOP_PREFERENCES);
    const elapsed = createDesktopSnapshot(service({ phase: "failed-start", recoveryAvailable: true, observation: null, failureCode: "SERVICE_START_FAILED" }), DEFAULT_DESKTOP_PREFERENCES);
    expect(waiting.recoveryAvailable).toBe(false);
    expect(waiting.readOnlyAvailable).toBe(false);
    expect(elapsed.recoveryAvailable).toBe(true);
  });

  it("reads and atomically persists only the three benign preferences", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-preferences-test-")); roots.push(root);
    expect(await readDesktopPreferences(root)).toEqual(DEFAULT_DESKTOP_PREFERENCES);
    const next = { schemaVersion: 1 as const, presentationMode: "developer" as const, textScale: "large" as const, welcomeDismissed: true };
    expect(await writeDesktopPreferences(root, next)).toEqual(next);
    expect(JSON.parse(await readFile(join(root, "preferences.json"), "utf8"))).toEqual(next);
    expect(await readDesktopPreferences(root)).toEqual(next);
    expect(() => parseDesktopPreferences({ ...next, credential: "not-allowed" })).toThrow("PREFERENCES_INVALID");
  });
});
