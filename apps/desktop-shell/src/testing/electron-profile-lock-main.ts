import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import { assertDesktopElectronVersion } from "../main/constants.js";
import { configureOwnedElectronProfile } from "./owned-electron-profile.js";

// A windowless lock control. It never opens a workspace, child service or
// provider, and can stop only itself in response to its owned release file.
try {
  const argument = (name: string): string => { const value = process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3); if (!value) throw new Error("PROFILE_LOCK_ARGUMENT_MISSING"); return value; };
  const root = resolve(argument("smoke-root")), role = argument("lock-role");
  if (!["primary", "duplicate", "independent"].includes(role)) throw new Error("PROFILE_LOCK_ROLE_REFUSED");
  assertDesktopElectronVersion(process.versions["electron"]);
  const profile = configureOwnedElectronProfile(app, root, role === "independent" ? "lock-b" : "lock-a");
  // Reproduce the unchanged application's name-setting order. An explicit
  // profile must survive setName before the real Electron lock is requested.
  app.setName("AI Development OS — AI Powerhouse"); profile.assertCurrent();
  app.on("window-all-closed", () => { /* A bounded owned stop ends this probe. */ });
  const acquired = app.requestSingleInstanceLock(), reportRoot = join(root, "owned-profile-lock-control"), releasePath = join(reportRoot, `${role}-release`);
  const base = { schemaVersion: 1, role, profilePath: profile.profilePath, profileUnchangedAfterSetName: true, acquired, electron: process.versions["electron"] };
  writeFileSync(join(reportRoot, `${role}-ready.json`), JSON.stringify(base) + "\n", { flag: "wx" });
  let finished = false, poll: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const finish = (release: "duplicate-refused" | "owned-stop" | "deadline" | "invalid-stop", failure: string | null): void => {
    if (finished) return; finished = true; clearInterval(poll); clearTimeout(deadline);
    try {
      profile.assertCurrent();
      writeFileSync(join(reportRoot, `${role}-final.json`), JSON.stringify({ ...base, heldAtFinish: app.hasSingleInstanceLock(), release, failure, shutdown: { explicitReceipt: failure === null } }) + "\n", { flag: "wx" });
      app.exit(failure === null ? 0 : 1);
    } catch { process.stderr.write("OWNED_PROFILE_LOCK_FINAL_UNAVAILABLE\n"); app.exit(1); }
  };
  if (!acquired) finish("duplicate-refused", null);
  else {
    poll = setInterval(() => {
      try {
        const stat = lstatSync(releasePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 || readFileSync(releasePath, "utf8") !== "release-owned-profile-lock\n") { finish("invalid-stop", "PROFILE_LOCK_STOP_REFUSED"); return; }
        finish("owned-stop", null);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") finish("invalid-stop", "PROFILE_LOCK_STOP_UNAVAILABLE"); }
    }, 50);
    deadline = setTimeout(() => finish("deadline", "PROFILE_LOCK_CONTROL_DEADLINE"), 45_000);
  }
} catch {
  process.stderr.write("OWNED_PROFILE_LOCK_CONTROL_UNAVAILABLE\n");
  app.exit(1);
}
