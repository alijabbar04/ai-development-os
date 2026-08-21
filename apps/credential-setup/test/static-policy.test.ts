import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_ELECTRON_VERSION } from "../src/main/constants.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(appRoot, "..", "..");
const read = (path: string): string => readFileSync(join(appRoot, path), "utf8");
const sources = [
  "src/main/constants.ts", "src/main/hardening.ts", "src/main/ipc.ts", "src/main/ipc-schema.ts",
  "src/main/protocol.ts", "src/main/production-composition.ts", "src/main/main.ts",
  "src/main/host-service.ts", "src/main/metadata-safety.ts", "src/main/metadata-store.ts", "src/main/startup-lifecycle.ts", "src/main/validation.ts",
  "src/preload/credential.cts",
].map(read).join("\n");

describe("Electron and dependency static policy", () => {
  it("pins Electron 43.4.1 as development-only and asserts the runtime floor before registering the surface", () => {
    const manifest = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    expect(manifest.dependencies?.["electron"]).toBeUndefined();
    expect(manifest.devDependencies?.["electron"]).toBe(CREDENTIAL_ELECTRON_VERSION);
    expect(manifest.peerDependencies?.["electron"]).toBe(CREDENTIAL_ELECTRON_VERSION);
    const main = read("src/main/main.ts");
    expect(main.indexOf("assertAppVaultElectronVersion")).toBeLessThan(main.indexOf("registerSchemesAsPrivileged"));
    expect(main.indexOf("assertCredentialElectronVersion")).toBeLessThan(main.indexOf("registerSchemesAsPrivileged"));
    const ensure = read("scripts/ensure-electron-runtime.mjs");
    for (const denied of ["ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_INSTALL_PLATFORM", "ELECTRON_INSTALL_ARCH", "electron_use_remote_checksums", "npm_config_electron_use_remote_checksums", "ELECTRON_USE_REMOTE_CHECKSUMS", "NPM_CONFIG_ELECTRON_USE_REMOTE_CHECKSUMS"]) expect(ensure).toContain(`\"${denied}\"`);
    for (const binding of ['manifest.version !== "43.4.1"', 'join(distRoot, "version")', 'join(packageRoot, "path.txt")', 'rel.startsWith("..")']) expect(ensure).toContain(binding);
    const rootManifest = JSON.parse(read("../../package.json")) as { scripts: Record<string, string> };
    const foundationSmoke = rootManifest.scripts["verify:app-vault-electron-smoke"];
    expect(foundationSmoke.indexOf("ensure:electron")).toBeLessThan(foundationSmoke.indexOf("@ai-dev-os/secrets-app-vault-electron"));
  });

  it("registers the scheme synchronously and awaits readiness only inside a launched async bootstrap", () => {
    const main = read("src/main/main.ts");
    const bootstrap = main.indexOf("async function startCredentialHost");
    const ready = main.indexOf("await app.whenReady()");
    expect(main.indexOf("registerSchemesAsPrivileged")).toBeLessThan(bootstrap);
    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(ready);
    expect(main).toContain("requestSingleInstanceLock");
    expect(main).toContain("else void startCredentialHost().catch");
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

  it("locks scheme privileges, CSP, web preferences, permissions, navigation, downloads, and the three-file protocol", () => {
    const main = read("src/main/main.ts");
    expect(main).toContain("privileges: { standard: true, secure: true }");
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
  });

  it("runs non-copying secret/metadata containment before any composed label check", () => {
    const safety = read("src/main/metadata-safety.ts");
    const separated = safety.indexOf("export function assertCredentialMetadataSeparatedFromSecret");
    const virtualScan = safety.indexOf("const candidates:", separated);
    const labelCheck = safety.indexOf("assertCredentialMetadataLabelsSafe(nickname, authorizedBy, code)", separated);
    expect(virtualScan).toBeGreaterThan(separated);
    expect(labelCheck).toBeGreaterThan(virtualScan);
  });

  it("copies exactly the reviewed three renderer files and emits a CommonJS sandbox preload", () => {
    const copy = read("scripts/copy-renderer.mjs");
    expect([...copy.matchAll(/"(index\.html|entry\.js|entry\.css)"/gu)].map((match) => match[1]).sort()).toEqual(["entry.css", "entry.js", "index.html"]);
    expect(read("tsconfig.json")).toContain('"src/**/*.cts"');
    expect(read("src/preload/credential.cts")).toContain('require("electron")');
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
    const wrapper = read("scripts/packed-runtime-wrapper.mjs");
    expect(verifier.indexOf('installedManifest.main !== "dist/main/main.js"')).toBeLessThan(verifier.indexOf('installedManifest.main = "packed-runtime-wrapper.mjs"'));
    const exactBridge = '["cancel", "describe", "remove", "rotate", "save", "setEnabled", "validate"]';
    expect(verifier).toContain(exactBridge);
    expect(wrapper).toContain(exactBridge);
  });
});
