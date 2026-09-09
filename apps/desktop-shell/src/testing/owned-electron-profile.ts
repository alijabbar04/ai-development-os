import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { App } from "electron";

const profiles = Object.freeze({ saved: ["chromium-user-data"], recovery: ["owned-saved-recovery-user-data", "chromium"], "ai-planning": ["owned-ai-planning-user-data", "chromium"],
  "lock-a": ["owned-profile-lock-control", "profile-a"], "lock-b": ["owned-profile-lock-control", "profile-b"] });
type FixtureApp = Pick<App, "isReady" | "getPath" | "setPath"> & { readonly commandLine: Pick<App["commandLine"], "appendSwitch" | "getSwitchValue"> };
const samePath = (left: string, right: string): boolean => process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** Dedicated fixture entries only. Electron's single-instance lock uses its
 * userData path, independently of a Chromium command-line profile switch. */
export function configureOwnedElectronProfile(app: FixtureApp, ownedRoot: string, profile: keyof typeof profiles): Readonly<{ profilePath: string; assertCurrent(): void }> {
  if (app.isReady()) throw new Error("OWNED_ELECTRON_PROFILE_TOO_LATE");
  if (!Object.hasOwn(profiles, profile)) throw new Error("OWNED_ELECTRON_PROFILE_UNKNOWN");
  const root = resolve(ownedRoot), stat = lstatSync(root), canonicalRoot = realpathSync.native(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !basename(root).startsWith("ai-dev-os-desktop-saved-smoke-") || !basename(canonicalRoot).startsWith("ai-dev-os-desktop-saved-smoke-")) throw new Error("OWNED_ELECTRON_PROFILE_ROOT_REFUSED");
  let profilePath = canonicalRoot;
  for (const part of profiles[profile]) {
    profilePath = join(profilePath, part);
    try { mkdirSync(profilePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const component = lstatSync(profilePath);
    if (!component.isDirectory() || component.isSymbolicLink() || !samePath(realpathSync.native(profilePath), profilePath)) throw new Error("OWNED_ELECTRON_PROFILE_PATH_REFUSED");
  }
  // Directories must exist, and sessionData must be overridden before ready.
  app.setPath("userData", profilePath);
  app.setPath("sessionData", profilePath);
  app.commandLine.appendSwitch("user-data-dir", profilePath);
  const assertCurrent = (): void => {
    if (!samePath(app.getPath("userData"), profilePath) || !samePath(app.getPath("sessionData"), profilePath) || !samePath(app.commandLine.getSwitchValue("user-data-dir"), profilePath)) throw new Error("OWNED_ELECTRON_PROFILE_CHANGED");
  };
  assertCurrent();
  return Object.freeze({ profilePath, assertCurrent });
}
