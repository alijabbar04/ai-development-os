import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureOwnedElectronProfile } from "../src/testing/owned-electron-profile.js";

const roots: string[] = [];
function ownedRoot(): string { const root = mkdtempSync(join(tmpdir(), "ai-dev-os-desktop-saved-smoke-profile-unit-")); roots.push(root); return root; }
afterEach(() => {
  for (const root of roots.splice(0)) {
    const canonical = realpathSync.native(root), temporaryRoot = realpathSync.native(tmpdir());
    if (!basename(canonical).startsWith("ai-dev-os-desktop-saved-smoke-profile-unit-") || dirname(canonical).toLowerCase() !== temporaryRoot.toLowerCase() || lstatSync(root).isSymbolicLink()) throw new Error("PROFILE_UNIT_CLEANUP_REFUSED");
    rmSync(canonical, { recursive: true, force: false });
  }
});
function fixtureApp() {
  const paths = new Map<string, string>(), switches = new Map<string, string>(), effects: string[] = [];
  let ready = false;
  const app: Parameters<typeof configureOwnedElectronProfile>[0] = {
    isReady: () => ready,
    getPath: name => paths.get(name) ?? "not-configured",
    setPath: (name, value) => { expect(lstatSync(value).isDirectory()).toBe(true); effects.push(name); paths.set(name, value); },
    commandLine: { appendSwitch: (name, value) => { switches.set(name, value ?? ""); }, getSwitchValue: name => switches.get(name) ?? "" },
  };
  return { app, paths, effects, setReady: () => { ready = true; } };
}

describe("owned Electron fixture profile isolation", () => {
  it("creates each finite profile before configuring both Electron data paths", () => {
    const root = ownedRoot(), selected = [];
    for (const kind of ["saved", "recovery", "ai-planning"] as const) {
      const fake = fixtureApp(), profile = configureOwnedElectronProfile(fake.app, root, kind);
      expect(fake.effects).toEqual(["userData", "sessionData"]);
      expect(fake.paths.get("userData")).toBe(profile.profilePath); expect(fake.paths.get("sessionData")).toBe(profile.profilePath);
      expect(fake.app.commandLine.getSwitchValue("user-data-dir")).toBe(profile.profilePath);
      expect(() => profile.assertCurrent()).not.toThrow(); selected.push(profile.profilePath);
    }
    expect(new Set(selected).size).toBe(3);
  });

  it("retains duplicate profile identity and detects a later path override before locking", () => {
    const root = ownedRoot(), first = fixtureApp(), second = fixtureApp();
    const profile = configureOwnedElectronProfile(first.app, root, "lock-a"), duplicate = configureOwnedElectronProfile(second.app, root, "lock-a");
    expect(profile.profilePath).toBe(duplicate.profilePath);
    first.paths.set("userData", join(root, "unexpected-profile"));
    expect(() => profile.assertCurrent()).toThrow("OWNED_ELECTRON_PROFILE_CHANGED");
  });

  it("refuses late initialization and an unowned root without configuring app paths", () => {
    const root = ownedRoot(), late = fixtureApp(); late.setReady();
    expect(() => configureOwnedElectronProfile(late.app, root, "saved")).toThrow("OWNED_ELECTRON_PROFILE_TOO_LATE");
    expect(late.effects).toEqual([]); expect(existsSync(join(root, "chromium-user-data"))).toBe(false);
    const unowned = join(root, "not-an-owned-root"); mkdirSync(unowned); const fake = fixtureApp();
    expect(() => configureOwnedElectronProfile(fake.app, unowned, "saved")).toThrow("OWNED_ELECTRON_PROFILE_ROOT_REFUSED");
    expect(fake.effects).toEqual([]); expect(existsSync(join(unowned, "chromium-user-data"))).toBe(false);
  });

  it("preserves and refuses an existing linked profile directory", () => {
    const root = ownedRoot(), target = ownedRoot(), linked = join(root, "chromium-user-data"), fake = fixtureApp();
    symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => configureOwnedElectronProfile(fake.app, root, "saved")).toThrow("OWNED_ELECTRON_PROFILE_PATH_REFUSED");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true); expect(fake.effects).toEqual([]);
  });

  it("keeps normal profile and global lock behavior outside fixture setup", () => {
    const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
    const normal = source("../src/main/application.ts") + source("../src/main/startup.ts");
    expect(normal).not.toContain("configureOwnedElectronProfile");
    expect(normal).not.toMatch(/app\.setPath\(["'](?:userData|sessionData)["']/u);
    expect(normal).toContain("if (!app.requestSingleInstanceLock()) throw new Error(\"DESKTOP_SINGLE_INSTANCE_UNAVAILABLE\")");
    for (const entry of ["electron-smoke-main", "electron-recovery-main", "electron-ai-planning-main"]) {
      const fixture = source(`../src/testing/${entry}.ts`);
      expect(fixture.indexOf("configureOwnedElectronProfile(app")).toBeLessThan(fixture.indexOf("await launchDesktopApplication("));
      expect(fixture).toContain('value === "app-configured"'); expect(fixture).toContain("ownedElectronProfile.assertCurrent()");
    }
    const probe = source("../src/testing/electron-profile-lock-main.ts");
    expect(probe).toContain("app.requestSingleInstanceLock()"); expect(probe).toContain("app.hasSingleInstanceLock()");
    expect(probe).not.toContain("releaseSingleInstanceLock"); expect(probe).not.toMatch(/\b(?:spawn|execFile|fetch)\s*\(/u);
  });
});
