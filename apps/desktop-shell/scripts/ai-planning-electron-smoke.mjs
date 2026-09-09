import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopElectronEnvironment } from "./electron-environment.mjs";

/** Synthetic inference is deliberately confined to a separate owned test
 * entry. The actual workspace, native review, child and SQLite are exercised. */
export async function runAiPlanningSmoke({ electron, applicationRoot, smokeRoot, evidenceRoot }) {
  const dataRoot = join(smokeRoot, "owned-ai-planning-user-data");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, "owned-fixture.json"), JSON.stringify({ kind: "owned-synthetic-ai-planning", version: 1 }), { flag: "wx" });
  const reports = [];
  for (const phase of ["journey", "reopen"]) {
    const reportPath = join(smokeRoot, "reports", `ai-planning-${phase}.json`);
    await mkdir(join(smokeRoot, "reports"), { recursive: true });
    const args = [join(applicationRoot, "dist", "testing", "electron-ai-planning-main.js"), `--smoke-root=${smokeRoot}`, `--ai-phase=${phase}`, `--report=${reportPath}`, `--evidence-root=${evidenceRoot}`];
    const child = spawn(electron, args, { env: desktopElectronEnvironment(process.env), shell: false, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, abandoned = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-60_000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-60_000); });
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      let settled = false, killTimer = null;
      const finish = code => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); resolveExit(code); };
      const timer = setTimeout(() => { timedOut = true; child.kill(); killTimer = setTimeout(() => { abandoned = true; finish(null); }, 5_000); }, 180_000);
      child.once("exit", finish);
      child.once("error", error => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(killTimer); rejectExit(error); } });
    });
    if (/(?:bearerToken|startNonce|Authorization:\s*Bearer)/u.test(stdout + stderr)) throw new Error("AI_PLANNING_BOUNDARY_MATERIAL_REFUSED");
    let report = null;
    try { report = JSON.parse(await readFile(reportPath, "utf8")); } catch { /* Report absence is a failed owned execution. */ }
    if (exitCode !== 0 || timedOut || report?.failure !== null || report?.shutdown?.explicitReceipt !== true || report?.providerEvidence !== "synthetic-owned-fixture" || report?.liveInvocations !== 0
      || Object.keys(report?.assertions ?? {}).length === 0 || !Object.values(report?.assertions ?? {}).every(value => value === true)) {
      throw new Error(`AI planning ${phase} failed: ${JSON.stringify({ exitCode, timedOut, abandoned, failure: report?.failure, step: report?.lastStep, diagnostics: report?.diagnostics, stdout: stdout.slice(-3_000), stderr: stderr.slice(-2_000) })}`);
    }
    reports.push(report);
    await writeFile(join(evidenceRoot, `AI-PLANNING-${phase.toUpperCase()}.json`), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  return { schemaVersion: 1, ok: true, providerEvidence: "synthetic-owned-fixture", liveInvocations: 0, phases: reports, fullAppReopens: 1 };
}
