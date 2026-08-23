import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PRODUCTION_STARTUP_FAILURE_LINE,
  productionHostEnvironment,
  productionHostTargetFromLayout,
} from "./launch-production-host.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("production launch removes inherited Electron and Node controls and fixes production mode", () => {
  const unicodeLookalikes = Object.freeze({
    electron: "ELECTRO\u017f_ENABLE_LOGGING",
    node: "N\u212aDE_OPTIONS",
  });
  const source = Object.freeze({
    Path: "fixed-path",
    ELECTRON_RUN_AS_NODE: "synthetic-control",
    eLeCtRoN_rUn_As_NoDe: "synthetic-alternate",
    ELECTRON_ENABLE_LOGGING: "synthetic-debug-control",
    electron_log_file: "synthetic-storage-control",
    NODE_OPTIONS: "--require=synthetic-preload.cjs",
    Node_Extra_CA_Certs: "synthetic-trust-control",
    node_env: "development",
    GOOGLE_API_KEY: "synthetic-network-control",
    [unicodeLookalikes.electron]: "preserved-electron-lookalike",
    [unicodeLookalikes.node]: "preserved-node-lookalike",
    PRESERVED: "value",
  });
  const output = productionHostEnvironment(source);
  assert.deepEqual(Object.keys(output).sort(), ["NODE_ENV", "PRESERVED", "Path", unicodeLookalikes.electron, unicodeLookalikes.node].sort());
  assert.equal(output.Path, "fixed-path");
  assert.equal(output.PRESERVED, "value");
  assert.equal(output.NODE_ENV, "production");
  assert.equal(output[unicodeLookalikes.electron], "preserved-electron-lookalike");
  assert.equal(output[unicodeLookalikes.node], "preserved-node-lookalike");
  assert.equal(source.ELECTRON_RUN_AS_NODE, "synthetic-control");
});

test("production launch resolves only the pinned Electron executable and fixed built entry", async () => {
  const packagePath = resolve(appRoot, "synthetic-node-modules", "electron", "package.json");
  const target = productionHostTargetFromLayout({
    packagePath,
    packageVersion: "43.4.1",
    executablePath: "electron.exe",
    distributionVersion: "v43.4.1",
    applicationMain: "dist/main/startup-bootstrap.cjs",
  });
  assert.equal(relative(appRoot, target.entry), join("dist", "main", "startup-bootstrap.cjs"));
  assert.equal(target.application, appRoot);
  assert.equal(target.cwd, appRoot);
  assert.equal(target.executable, resolve(appRoot, "synthetic-node-modules", "electron", "dist", "electron.exe"));
  assert.equal(isAbsolute(target.executable), true);
  assert.throws(() => productionHostTargetFromLayout({ packagePath, packageVersion: "43.4.0", executablePath: "electron.exe", distributionVersion: "43.4.0", applicationMain: "dist/main/startup-bootstrap.cjs" }), /ELECTRON_VERSION_UNREVIEWED/u);
  assert.throws(() => productionHostTargetFromLayout({ packagePath, packageVersion: "43.4.1", executablePath: join("..", "outside.exe"), distributionVersion: "43.4.1", applicationMain: "dist/main/startup-bootstrap.cjs" }), /ELECTRON_BINDING_UNAVAILABLE/u);
  assert.throws(() => productionHostTargetFromLayout({ packagePath, packageVersion: "43.4.1", executablePath: "electron.exe", distributionVersion: "43.4.1", applicationMain: "dist/main/main.js" }), /ELECTRON_BINDING_UNAVAILABLE/u);
  const manifest = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8"));
  assert.equal(manifest.devDependencies.electron, "43.4.1");
  assert.equal(manifest.main, "dist/main/startup-bootstrap.cjs");
  assert.equal(manifest.scripts.start, "node scripts/launch-production-host.mjs");
});

test("launcher failure output is one finite non-secret startup record", () => {
  assert.equal(PRODUCTION_STARTUP_FAILURE_LINE.match(/\n/gu)?.length, 1);
  assert.deepEqual(JSON.parse(PRODUCTION_STARTUP_FAILURE_LINE), {
    schemaVersion: 1,
    operation: "credential-host-startup",
    phase: "runtime-binding",
    code: "STARTUP_FAILED",
    terminal: true,
  });
});

test("CommonJS bootstrap enters synchronously and bounds a non-Electron runtime failure", () => {
  const bootstrap = resolve(appRoot, "src", "main", "startup-bootstrap.cjs");
  const result = spawnSync(process.execPath, [bootstrap], { cwd: appRoot, encoding: "utf8", windowsHide: true, shell: false });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    schemaVersion: 1,
    operation: "credential-host-startup",
    phase: "runtime-binding",
    code: "ELECTRON_BINDING_UNAVAILABLE",
    terminal: true,
  });
  assert.equal(result.stderr.match(/\n/gu)?.length, 1);
});

test("launcher never accepts forwarded arguments or invokes a shell", async () => {
  const source = await readFile(fileURLToPath(new URL("launch-production-host.mjs", import.meta.url)), "utf8");
  assert.match(source, /process\.argv\.length !== 2/u);
  assert.match(source, /spawn\(target\.executable, \[target\.application\]/u);
  assert.match(source, /shell: false/u);
  assert.doesNotMatch(source, /process\.argv\.slice|shell: true|exec\(|execFile\(/u);
});
