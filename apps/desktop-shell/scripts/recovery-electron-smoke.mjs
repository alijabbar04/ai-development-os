import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { desktopElectronEnvironment } from "./electron-environment.mjs";

/** Called by the maintained Windows smoke after its original journeys. Each
 * phase is a fresh Electron process with a proven drained child before the
 * owned clock marker or exported bytes are changed. */
export async function runSavedRecoverySmoke({ electron, applicationRoot, smokeRoot, evidenceRoot }) {
  const dataRoot = join(smokeRoot, "owned-saved-recovery-user-data"), marker = join(dataRoot, "synthetic-clock.json");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(marker, JSON.stringify({ kind: "owned-saved-recovery-clock", at: "2026-09-08T00:00:00.000Z" }), { flag: "wx" });
  const reports = [];
  for (const phase of ["prepare", "recover", "reopen"]) {
    const reportPath = join(smokeRoot, "reports", `recovery-${phase}.json`);
    await mkdir(join(smokeRoot, "reports"), { recursive: true });
    const args = [join(applicationRoot, "dist", "testing", "electron-recovery-main.js"), `--smoke-root=${smokeRoot}`, `--recovery-phase=${phase}`, `--report=${reportPath}`, `--evidence-root=${evidenceRoot}`];
    const child = spawn(electron, args, { env: desktopElectronEnvironment(process.env), shell: false, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, abandoned = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-60_000); }); child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-60_000); });
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      let settled = false, killTimer = null;
      const finish = code => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); resolveExit(code); };
      const timer = setTimeout(() => { timedOut = true; child.kill(); killTimer = setTimeout(() => { abandoned = true; finish(null); }, 5_000); }, 180_000);
      child.once("exit", finish); child.once("error", error => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(killTimer); rejectExit(error); } });
    });
    if (/(?:bearerToken|startNonce|Authorization:\s*Bearer)/u.test(stdout + stderr)) throw new Error("RECOVERY_BOUNDARY_MATERIAL_REFUSED");
    let report = null;
    try { report = JSON.parse(await readFile(reportPath, "utf8")); } catch { /* Preserve missing-report context below. */ }
    if (exitCode !== 0 || timedOut || report?.failure !== null || report?.shutdown?.explicitReceipt !== true || !Object.values(report?.assertions ?? {}).every(value => value === true)) {
      throw new Error(`Recovery ${phase} failed: ${JSON.stringify({ exitCode, timedOut, abandoned, failure: report?.failure, step: report?.lastStep, diagnostics: report?.diagnostics, stdout: stdout.slice(-3_000), stderr: stderr.slice(-2_000) })}`);
    }
    reports.push(report);
    // Persist decisive evidence outside the disposable fixture immediately.
    await writeFile(join(evidenceRoot, `RECOVERY-${phase.toUpperCase()}.json`), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    if (phase === "prepare") {
      const baseline = JSON.parse(await readFile(join(dataRoot, "recovery-baseline.json"), "utf8"));
      const target = await realpath(baseline.project.handovers[0].fileName), canonicalRoot = await realpath(join(dataRoot, "saved-workspace", "artifacts")), rel = relative(canonicalRoot, target);
      if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("RECOVERY_EXPORT_NOT_OWNED");
      const bytes = await readFile(target, "utf8"); if (bytes !== baseline.savedText) throw new Error("RECOVERY_INITIAL_EXPORT_CHANGED");
      await writeFile(target, bytes.replaceAll("\n", "\r\n"));
      await writeFile(marker, JSON.stringify({ kind: "owned-saved-recovery-clock", at: baseline.project.plan.scopeApproval.expiresAt }));
    }
  }
  return { schemaVersion: 1, ok: true, phases: reports, fullAppReopens: 2, conflictingFilePreserved: true, syntheticClock: true };
}
