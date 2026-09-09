import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopElectronEnvironment } from "./electron-environment.mjs";

/** Actual Electron lock controls in finite owned profiles. No process
 * inventory, user profile, production app or service is consulted. */
export async function runProfileLockControl({ electron, applicationRoot, smokeRoot, evidenceRoot }) {
  const controlRoot = join(smokeRoot, "owned-profile-lock-control"), records = [], assertions = {};
  await mkdir(controlRoot, { recursive: true });
  let failure = null;
  const check = (name, value) => { assertions[name] = value; if (!value) throw new Error(`PROFILE_LOCK_ASSERTION:${name}`); };
  async function readReport(role, phase) {
    const path = join(controlRoot, `${role}-${phase}.json`), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4_096) throw new Error("PROFILE_LOCK_REPORT_REFUSED");
    return JSON.parse(await readFile(path, "utf8"));
  }
  function start(role) {
    const child = spawn(electron, [join(applicationRoot, "dist", "testing", "electron-profile-lock-main.js"), `--smoke-root=${smokeRoot}`, `--lock-role=${role}`],
      { env: desktopElectronEnvironment(process.env), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const record = { role, child, ready: null, final: null, completion: null, stdout: "", stderr: "" };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { record.stdout = (record.stdout + chunk).slice(-4_096); });
    child.stderr.on("data", chunk => { record.stderr = (record.stderr + chunk).slice(-4_096); });
    record.completed = new Promise(resolveEnd => {
      let settled = false, killTimer = null, timedOut = false;
      const finish = (code, error = null, abandoned = false) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); record.completion = { code, error, timedOut, abandoned }; resolveEnd(record.completion); };
      const timer = setTimeout(() => { timedOut = true; child.kill(); killTimer = setTimeout(() => finish(null, "owned-process-exit-unconfirmed", true), 5_000); }, 50_000);
      child.once("exit", code => finish(code)); child.once("error", () => finish(null, "owned-process-start-failed"));
    });
    records.push(record); return record;
  }
  async function ready(record) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try { record.ready = await readReport(record.role, "ready"); return record.ready; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (record.completion !== null) throw new Error(`PROFILE_LOCK_EXITED_BEFORE_READY:${record.role}`);
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error(`PROFILE_LOCK_READY_DEADLINE:${record.role}`);
  }
  try {
    const primary = start("primary"), first = await ready(primary);
    check("first-owned-profile-acquires-real-lock", first.acquired === true && first.profileUnchangedAfterSetName === true);
    const duplicate = start("duplicate"), same = await ready(duplicate);
    check("duplicate-owned-profile-is-refused", same.acquired === false && same.profilePath === first.profilePath);
    await duplicate.completed;
    check("duplicate-refusal-exits-cleanly", duplicate.completion.code === 0);
    const independent = start("independent"), second = await ready(independent);
    check("different-owned-profile-acquires-independent-lock", second.acquired === true && second.profilePath !== first.profilePath && second.profileUnchangedAfterSetName === true && primary.completion === null);
  } catch (error) { failure = error instanceof Error ? error.message : "PROFILE_LOCK_CONTROL_FAILED"; }
  finally {
    for (const record of records) if (record.completion === null) {
      try { await writeFile(join(controlRoot, `${record.role}-release`), "release-owned-profile-lock\n", { flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") failure ??= "PROFILE_LOCK_STOP_UNAVAILABLE"; }
    }
    await Promise.all(records.map(record => record.completed));
    for (const record of records) {
      try { record.final = await readReport(record.role, "final"); } catch { failure ??= `PROFILE_LOCK_FINAL_REPORT_UNAVAILABLE:${record.role}`; }
      if (record.completion.code !== 0 || record.completion.error !== null || record.completion.timedOut || record.completion.abandoned || record.final?.failure !== null || record.final?.shutdown?.explicitReceipt !== true) failure ??= `PROFILE_LOCK_SHUTDOWN_UNCONFIRMED:${record.role}`;
      if (/(?:bearerToken|startNonce|Authorization:\s*Bearer)/u.test(record.stdout + record.stderr)) failure ??= "PROFILE_LOCK_BOUNDARY_MATERIAL_REFUSED";
    }
  }
  if (failure === null) {
    try {
      check("both-independent-locks-held-until-owned-stop", records.filter(record => record.role !== "duplicate").every(record => record.final.heldAtFinish === true && record.final.release === "owned-stop"));
      check("refused-duplicate-never-owned-lock", records.find(record => record.role === "duplicate").final.heldAtFinish === false);
      check("all-owned-control-processes-exited", records.length === 3 && records.every(record => record.completion.code === 0 && record.final.shutdown.explicitReceipt === true));
    } catch (error) { failure = error instanceof Error ? error.message : "PROFILE_LOCK_CONTROL_FAILED"; }
  }
  const report = { schemaVersion: 1, ok: failure === null, assertions, failure,
    provenance: "Actual Electron single-instance locks; two owned profiles and one duplicate. No user app or workspace was inspected or changed.",
    processes: records.map(({ role, ready, final, completion }) => ({ role, ready, final, completion })) };
  await writeFile(join(evidenceRoot, "PROFILE-LOCK-CONTROL.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  if (failure !== null) throw new Error(failure);
  return report;
}
