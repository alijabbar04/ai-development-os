import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_ELECTRON_VERSION } from "../src/main/constants.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(appRoot, "..", "..");
const read = (path: string): string => readFileSync(join(appRoot, path), "utf8");
const expectOrdered = (source: string, left: string, right: string): void => {
  expect(source).toContain(left);
  expect(source).toContain(right);
  expect(source.indexOf(left)).toBeLessThan(source.indexOf(right));
};
const sources = [
  "src/main/anthropic-validation-authorization.ts", "src/main/anthropic-validation.ts",
  "src/main/constants.ts", "src/main/hardening.ts", "src/main/ipc.ts", "src/main/ipc-schema.ts",
  "src/main/protocol.ts", "src/main/production-composition.ts", "src/main/main.ts",
  "src/main/host-service.ts", "src/main/metadata-safety.ts", "src/main/metadata-store.ts", "src/main/startup-bootstrap.cjs", "src/main/startup-bootstrap-runtime.cjs", "src/main/startup-deadline.cjs", "src/main/startup-diagnostic.ts", "src/main/startup-entry.ts", "src/main/startup-lifecycle.ts", "src/main/validation.ts",
  "src/preload/credential.cts",
].map(read).join("\n");

describe("Electron and dependency static policy", () => {
  it("fetches full history in every CI job that builds or verifies the candidate binding", () => {
    const workflow = read("../../.github/workflows/ci.yml");
    const jobSection = (job: string, nextJob?: string): string => {
      const start = workflow.indexOf(`  ${job}:`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = nextJob === undefined ? workflow.length : workflow.indexOf(`  ${nextJob}:`, start + 1);
      expect(end).toBeGreaterThan(start);
      return workflow.slice(start, end);
    };

    for (const section of [
      jobSection("check", "audit"),
      jobSection("coverage", "postgres"),
      jobSection("packed-consumer", "credential-host-packed"),
      jobSection("credential-host-packed"),
    ]) expect(section).toContain("fetch-depth: 0");
  });

  it("pins Electron 43.4.1 as development-only and asserts the runtime floor before registering the surface", () => {
    const manifest = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    expect(manifest.dependencies?.["electron"]).toBeUndefined();
    expect(manifest.devDependencies?.["electron"]).toBe(CREDENTIAL_ELECTRON_VERSION);
    expect(manifest.peerDependencies?.["electron"]).toBe(CREDENTIAL_ELECTRON_VERSION);
    const bootstrap = read("src/main/startup-bootstrap-runtime.cjs");
    const entry = read("src/main/startup-entry.ts");
    expectOrdered(bootstrap, "version !== ELECTRON_VERSION", "credentialProtocol.registerSchemesAsPrivileged([{");
    expectOrdered(entry, "assertAppVaultElectronVersion", "createProductionCredentialHost");
    expectOrdered(entry, "assertCredentialElectronVersion", "createProductionCredentialHost");
    const ensure = read("scripts/ensure-electron-runtime.mjs");
    for (const denied of ["ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_INSTALL_PLATFORM", "ELECTRON_INSTALL_ARCH", "electron_use_remote_checksums", "npm_config_electron_use_remote_checksums", "ELECTRON_USE_REMOTE_CHECKSUMS", "NPM_CONFIG_ELECTRON_USE_REMOTE_CHECKSUMS"]) expect(ensure).toContain(`\"${denied}\"`);
    for (const binding of ['manifest.version !== "43.4.1"', 'join(distRoot, "version")', 'join(packageRoot, "path.txt")', 'rel.startsWith("..")']) expect(ensure).toContain(binding);
    const rootManifest = JSON.parse(read("../../package.json")) as { scripts: Record<string, string> };
    const foundationSmoke = rootManifest.scripts["verify:app-vault-electron-smoke"];
    expectOrdered(foundationSmoke, "ensure:electron", "@ai-dev-os/secrets-app-vault-electron");
  });

  it("bounds module loading and registers the scheme before awaiting readiness", () => {
    const packageEntry = read("src/main/startup-bootstrap.cjs");
    const bootstrap = read("src/main/startup-bootstrap-runtime.cjs");
    const deadline = read("src/main/startup-deadline.cjs");
    const main = read("src/main/main.ts");
    const entry = read("src/main/startup-entry.ts");
    const manifest = JSON.parse(read("package.json")) as { main: string };
    expect(manifest.main).toBe("dist/main/startup-bootstrap.cjs");
    expect(packageEntry).toContain('require("./startup-bootstrap-runtime.cjs")');
    expect(packageEntry).toContain("bootstrap.startProductionCredentialBootstrap(startupDeadline)");
    expect(packageEntry).toContain("module.exports = Object.freeze({ bootstrapStarted })");
    expectOrdered(packageEntry, "armProductionCredentialStartupDeadline()", 'require("./startup-bootstrap-runtime.cjs")');
    expect(packageEntry).not.toContain("require.main");
    expectOrdered(bootstrap, "credentialProtocol.registerSchemesAsPrivileged([{", "options.loadMain()");
    expect(bootstrap).toContain('loadMain: () => import("./main.js")');
    expect(bootstrap).not.toMatch(/process\.env|process\.argv|\bawait\b/u);
    expect(deadline).toContain("const CREDENTIAL_STARTUP_DEADLINE_MS = 30_000");
    expect(deadline).toContain('process.on("unhandledRejection"');
    expect(deadline).toContain('process.on("uncaughtException"');
    expect(deadline).not.toMatch(/process\.env|process\.argv/u);
    expectOrdered(main, 'setPhase("runtime-binding")', 'await import("electron")');
    expectOrdered(main, 'await import("electron")', 'await import("./startup-entry.js")');
    expect(main).toContain("await runCredentialStartupTask({");
    expect(main).not.toContain("void runCredentialStartupTask({");
    expect(main).not.toMatch(/from "electron"|@ai-dev-os\//u);
    expect(entry).toContain("await waitForCredentialAppReady(app)");
    expect(entry).not.toContain("app.whenReady");
    expect(entry).not.toContain("registerSchemesAsPrivileged");
    expect(entry).not.toContain('setPhase("protocol-registration")');
    expect(entry).toContain("requestSingleInstanceLock");
    expect(main).not.toContain(".catch(() => { app.exit(1); })");
    expect(main).toContain("fallbackExit(code) { process.exitCode = code; process.exit(code); }");
    expectOrdered(main, "process.exitCode = code;", "process.exit(code);");
  });

  it("contains exactly the six reviewed channel literals and no raw/generic bridge exposure", () => {
    const constants = read("src/main/constants.ts");
    const channels = [...constants.matchAll(/"credential-vault:([a-z-]+)"/gu)].map((match) => match[1]);
    expect(channels).toEqual(["describe", "save", "rotate", "remove", "validate", "cancel"]);
    const preload = read("src/preload/credential.cts");
    expect(preload).toContain('exposeInMainWorld("credentialVault"');
    expect(preload).not.toMatch(/exposeInMainWorld\([^\n]+ipcRenderer|ipcRenderer\.on|ipcRenderer\.send|\binvoke:\s*\(/u);
    expect((read("src/main/ipc.ts").match(/handle\(CREDENTIAL_CHANNELS\./g) ?? []).length).toBe(6);
  });

  it("has no renderer URL override, environment read, dev server, shell, process launch, export, clipboard read, global shortcut, or forbidden future package", () => {
    expect(sources).not.toMatch(/process\.env|VITE_DEV_SERVER_URL|openDevTools|toggleDevTools|crashReporter|globalShortcut/u);
    expect(sources).not.toMatch(/clipboard\.(readText|readHTML|readImage|readBuffer)|shell\.(openExternal|openPath)|showSaveDialog|child_process/u);
    expect(sources).not.toMatch(/@ai-dev-os\/(orchestration|scheduler|process-broker|daemon|generated-client|git)/u);
    expect(sources).not.toMatch(/ClaudeAccountManager|Local State|CredEnum|setUsePlainTextEncryption/u);
  });

  it("uses one fixed no-argument production launcher with a bounded child environment", () => {
    const manifest = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const launcher = read("scripts/launch-production-host.mjs");
    expect(manifest.scripts["start"]).toBe("node scripts/launch-production-host.mjs");
    for (const removed of ["ELECTRON_", "NODE_", "DOTNET_", "COMPLUS_", "CORECLR_", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]) expect(launcher).toContain(`"${removed}"`);
    expect(launcher).toContain('output.NODE_ENV = "production"');
    expect(launcher).toContain('const productionMain = "dist/main/startup-bootstrap.cjs"');
    expect(launcher).toContain("resolve(appRoot, applicationMain)");
    expect(launcher).toContain("applicationManifest.main");
    expect(launcher).toContain("spawn(target.executable, [target.application]");
    expect(launcher).toContain("process.argv.length !== 2");
    expect(launcher).toContain("shell: false");
    expect(launcher).toContain("writeSync(2, PRODUCTION_STARTUP_FAILURE_LINE)");
    expect(launcher).not.toMatch(/process\.argv\.slice|shell: true|exec\(|execFile\(|ELECTRON_OVERRIDE_DIST_PATH|app\.setPath/u);
  });

  it("locks scheme privileges, CSP, web preferences, permissions, navigation, downloads, and the three-file protocol", () => {
    const bootstrap = read("src/main/startup-bootstrap-runtime.cjs");
    expect(bootstrap).toContain("privileges: { standard: true, secure: true }");
    expect(sources).not.toMatch(/supportFetchAPI|corsEnabled|bypassCSP|allowServiceWorkers|Cross-Origin-Opener-Policy|Cross-Origin-Embedder-Policy|webRequest/u);
    const hardening = read("src/main/hardening.ts");
    for (const setting of ["sandbox: true", "contextIsolation: true", "nodeIntegration: false", "nodeIntegrationInSubFrames: false", "nodeIntegrationInWorker: false", "webSecurity: true", "allowRunningInsecureContent: false", "webviewTag: false", "devTools: false", "spellcheck: false"]) expect(hardening).toContain(setting);
    for (const denial of ["setPermissionRequestHandler", "setPermissionCheckHandler", "setDevicePermissionHandler", "setDisplayMediaRequestHandler", "will-download", "will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview", "setWindowOpenHandler"]) expect(hardening).toContain(denial);
    expect(read("src/main/constants.ts")).toContain("connect-src 'none'");
    expect(read("src/main/constants.ts")).toContain("form-action 'none'");
    expect(read("src/main/constants.ts")).toContain('["index.html", "entry.js", "entry.css"]');
  });

  it("keeps Electron imports bounded and manager construction main-only while all reads use policy-aware resolvers", () => {
    const files = readdirSync(join(repository, "apps", "credential-setup", "src"), { recursive: true }).filter((name) => typeof name === "string" && /\.(?:ts|cts)$/u.test(name));
    expect(files.length).toBeGreaterThan(0);
    const composition = read("src/main/production-composition.ts");
    expect(composition).toContain("createAppVaultManager");
    expect(composition).toContain("Promise.allSettled");
    expect(read("src/main/host-service.ts")).toContain("createPolicyAwareSecretResolver");
    expect(read("src/main/host-service.ts")).toContain("return await resolver.withSecret(input, callback)");
    expect(read("src/main/host-service.ts")).toContain("this.#resolvers[payload.slotId].resolve(");
    expect(read("src/main/host-service.ts")).not.toMatch(/\.broker\.withSecret/u);
    expect(sources).not.toMatch(/\.storage\.(read|write)|\.crypto\.decrypt/u);
  });

  it("contains no realistic credential-shaped fixture or secret-bearing diagnostics", () => {
    const all = sources + read("../../packages/credential-ui/src/browser/entry.ts");
    const realistic = /(sk-ant-api\d{2}-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-or-v1-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{32,})/u;
    expect(all).not.toMatch(realistic);
    expect(sources).not.toMatch(/console\.(log|warn|error|debug)|JSON\.stringify\(.*secret/u);
    const diagnostic = read("src/main/startup-diagnostic.ts");
    expect(diagnostic).not.toMatch(/\.message|\.stack|process\.env|Object\.keys\(error|JSON\.stringify\(error/u);
    expect(diagnostic).toContain("writeSync(2, line)");
  });

  it("keeps real Electron smoke failure output finite and secret-independent", () => {
    const smoke = read("scripts/real-electron-smoke.mjs");
    expect(smoke).toContain("CREDENTIAL_DIAGNOSTIC.test(stdout)");
    expect(smoke).toContain("CREDENTIAL_DIAGNOSTIC.test(stderr)");
    expect(smoke).toContain("finiteLabel(report.stage");
    expect(smoke).not.toContain("report.assertions[name]");
    expect(smoke).not.toMatch(/stderr\.trim|failedAssertions|synthetic-canary-redacted|synthetic-replacement-redacted/u);
  });

  it("runs non-copying secret/metadata containment before any composed label check", () => {
    const safety = read("src/main/metadata-safety.ts");
    expectOrdered(safety, "export function assertCredentialMetadataSeparatedFromSecret", "const candidates:");
    expectOrdered(safety, "const candidates:", "assertCredentialMetadataLabelsSafe(nickname, authorizedBy, code)");
  });

  it("copies exactly the reviewed three renderer files and emits a CommonJS sandbox preload", () => {
    const copy = read("scripts/copy-renderer.mjs");
    const bootstrapCopy = read("scripts/copy-main-bootstrap.mjs");
    expect([...copy.matchAll(/"(index\.html|entry\.js|entry\.css)"/gu)].map((match) => match[1]).sort()).toEqual(["entry.css", "entry.js", "index.html"]);
    expect(read("tsconfig.json")).toContain('"src/**/*.cts"');
    expect(read("src/preload/credential.cts")).toContain('require("electron")');
    expect(bootstrapCopy).toContain('"startup-bootstrap.cjs"');
    expect(bootstrapCopy).toContain('"startup-bootstrap-runtime.cjs"');
    expect(bootstrapCopy).toContain('"startup-deadline.cjs"');
    expect(bootstrapCopy).toContain("credential-startup-bootstrap-copy-mismatch");
  });

  it("verifies the compiled Windows addon without invoking Credential Manager", () => {
    const workflow = readFileSync(join(repository, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toContain("run: npm run verify:windows-native-shape");
    expect(workflow).not.toMatch(/^\s+run:\s+npm run test:native-smoke/mu);
    const verifier = read("scripts/verify-windows-credential-addon-shape.mjs");
    expect(verifier).toContain('Reflect.ownKeys(addon)');
    expect(verifier).not.toMatch(/addon\.(?:availability|read)\s*\(/u);
    expect(verifier).toContain("credential-manager-calls:0");
  });

  it("binds the packed host entry and exact preload bridge before accepting runtime success", () => {
    const verifier = read("scripts/verify-packed-host.mjs");
    const wrapper = read("scripts/packed-runtime-wrapper.cjs");
    expectOrdered(verifier, 'installedManifest.main !== "dist/main/startup-bootstrap.cjs"', 'installedManifest.main = "packed-runtime-wrapper.cjs"');
    expectOrdered(wrapper, "bootstrap.bootstrapStarted", "async function run()");
    expect(wrapper).toContain('require("electron")');
    expect(wrapper).toContain("if (bootstrapStarted) void run()");
    expect(wrapper).toContain("window.isVisible()");
    expect(wrapper).not.toContain("PACKED_BOOTSTRAP_FAILED");
    expect(wrapper).not.toMatch(/^\s*import\s/mu);
    const exactBridge = '["cancel", "describe", "remove", "rotate", "save", "setEnabled", "validate"]';
    expect(verifier).toContain(exactBridge);
    expect(wrapper).toContain(exactBridge);
  });

  it("refuses to emit a published candidate binding from a dirty worktree", () => {
    const writer = read("scripts/write-stage-18e-i-candidate-binding.mjs");
    expect(writer).toContain('["status", "--porcelain=v1", "--untracked-files=all"]');
    expectOrdered(writer, "CANDIDATE_BINDING_WORKTREE_NOT_CLEAN", "readCommittedSubjectManifest(repositoryRoot, head)");
    expect(writer).toContain("assertStage18eIManifestBase(manifest)");
    expect(writer).toContain("collectSubjectManifest(repositoryRoot, STAGE_18E_I_BASE_COMMIT, parents[1])");
    expect(writer).not.toContain("collectSubjectManifest(repositoryRoot, manifest.baseCommit");
  });
});
